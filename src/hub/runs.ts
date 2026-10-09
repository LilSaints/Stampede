import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { executeWorkflow } from '../runtime/hooks.js';
import { parseWorkflow } from '../runtime/parse.js';
import { type AgentLaunch, type TurnHandle, zeroUsage } from '../backends/adapter.js';
import { launchTurn } from '../backends/procs.js';
import { codexSchema, jsonAnswer, validateSchema } from '../backends/codexSchema.js';
import { contract } from '../contract/prompts.js';
import { externalTools } from '../backends/tool-usage.js';
import { claudeContext, claudeReplies, claudeSessionExists, claudeTranscriptSize, claudeWindow, codexContext, codexThreadExists } from '../backends/context.js';
import { Store, readJson, readJournal } from './store.js';
import { type Config, lowerConfig } from './config.js';
import { type BackendInfo } from './capabilities.js';
import { Scheduler, AdmissionError } from './scheduler.js';
import { MessageBus, envelopes, type Peer } from './bus.js';
import { type Agent, type AgentOpts, type Run, agentTerminal, runTerminal } from './model.js';
import { RunCache, type TeamRecord } from './cache.js';
import { Mutex, hash, canonical, fingerprint, invalidateFingerprint, type FingerprintMemo, createWorkspace, finishWorkspace, git, repoRoot, resolveCommit } from './workspaces.js';

const now = () => new Date().toISOString();
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('run cancelled')); return; }
  const abort = () => { clearTimeout(timer); reject(new Error('run cancelled')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
interface AgentContext {
  agent: Agent; opts: AgentOpts; prompt: string; abort: AbortController; token: string; tokenHash: string; done: Promise<unknown>; resolve: (value: unknown) => void;
  task?: Promise<void>; handle?: TurnHandle; release?: (id?: string) => void; tainted: boolean; resumeScheduled: boolean; launch?: AgentLaunch;
  key?: string; occ?: number; inputs?: unknown; cacheable?: boolean; cached?: boolean; autoDone: boolean; base?: string;
  finishing?: Promise<void>; requestedTerminal?: Agent['status']; retryRequested?: boolean; resumeLimitNotified?: boolean;
  shared: { reads: string[]; writes: string[] };
}
interface Team { id: string; names: string[]; createdAt: number; lastOrchestratorMessage: number; releaseIdleAfterMs?: number; key?: string; occ?: number; replay?: TeamRecord; admissionAbort?: AbortController; admission?: Promise<void> }
/** What an agent cut off by a stopping hub records, so a resumed run can continue it. */
const INTERRUPTED = { kind: 'interrupted', message: 'the hub stopped during this agent\'s turn' };
/** The first prompt of a continued agent, in the session that holds the original task. */
const CONTINUE_PROMPT = 'Your previous turn on this task was interrupted before it finished: the Stampede hub stopped. This session and your workspace, with any changes you made, are as you left them. Check where you stopped, continue the original task, and end with the final answer it asks for.';
export interface RunInput { script?: string; scriptPath?: string; name?: string; args?: unknown; cwd?: string; budgetTokens?: number; budgetUsd?: number; defaultBackend?: 'claude' | 'codex'; orchestratorSessionId?: string; notifyAgents?: boolean; title?: string; continueInterrupted?: boolean; limits?: Partial<Config['limits']> }
export interface UiEvent { hubSeq: number; runId: string; type: string; at: string; data: any }

export class RunManager extends EventEmitter {
  readonly runs = new Map<string, Run>();
  readonly active = new Map<string, RunExecution>();
  readonly scheduler: Scheduler;
  readonly events: UiEvent[] = [];
  hubSeq = 0;
  hubUrl = '';
  processStarted?: (pid: number, agent: Agent) => Promise<void>;
  recoverAgent?: (agent: Agent) => Promise<void>;
  private eventMutex = new Mutex();
  private closing = false;
  constructor(readonly store: Store, readonly config: Config, readonly backends: Record<'claude' | 'codex', BackendInfo>, readonly cliEntry: string) {
    super(); const s = config.scheduler;
    this.scheduler = new Scheduler({ global: s.maxConcurrent, perRun: s.perRun, claude: s.claude.maxConcurrent, codex: backends.codex.capabilities.concurrentHomeSafe === false ? 1 : s.codex.maxConcurrent, reserve: s.nonCommsReserve, admissionMaxMs: s.admissionMaxMs });
  }
  async restore() {
    await this.store.initialize();
    this.hubSeq = (await readJson<{ seq: number }>(path.join(this.store.home, 'hub-seq.json')))?.seq ?? 0;
    for (const id of await this.store.runs()) {
      const run = await readJson<Run>(path.join(this.store.runDir(id), 'run.json')); if (!run) continue;
      this.runs.set(id, run);
      for (const file of ['events.jsonl', 'journal.jsonl', 'messages.jsonl', 'board.jsonl', 'teams.jsonl']) await readJournal(path.join(this.store.runDir(id), file), true);
      if (!runTerminal(run.status)) {
        for (const agent of run.agents) {
          await this.recoverAgent?.(agent);
          if (!agentTerminal(agent.status)) { agent.status = 'cancelled'; agent.error = { ...INTERRUPTED }; }
          for (const file of ['mcp.json', 'settings.json']) await rm(path.join(this.store.runDir(id), 'agents', agent.id, file), { force: true });
        }
        run.counters.agentsRunning = 0; run.status = 'interrupted'; run.endedAt = now();
        await this.event(run, 'run.status', { status: run.status });
        await this.store.write(path.join(this.store.runDir(id), 'result.json'), { status: run.status, error: { message: 'hub stopped before the run completed' } });
      }
    }
  }
  async event(run: Run, type: string, data: any = {}) {
    return this.eventMutex.run(async () => {
      if (type === 'run.status' && runTerminal(data.status)) await this.store.write(path.join(this.store.runDir(run.id), 'result.json'), { status: run.status, result: run.result, error: run.error, cacheHits: run.cacheHits, liveCalls: run.liveCalls, ...run.cacheReport, effects: run.agents.filter(a => a.workspace.kept).map(a => ({ name: a.name, ...a.workspace })) });
      const event = { hubSeq: ++this.hubSeq, runId: run.id, type, at: now(), data };
      if (type === 'run.status' && runTerminal(data.status) || type === 'message.accepted' && (data.to === 'orchestrator' || data.to === '*') && !['orchestrator', 'system'].includes(data.from) || ['team.deadlock', 'team.admission_blocked', 'backend.unavailable', 'budget.exhausted', 'agent.failed', 'agent.done'].includes(type)) run.notifications = [...run.notifications ?? [], event].slice(-200);
      await this.store.write(path.join(this.store.home, 'hub-seq.json'), { seq: this.hubSeq });
      await this.store.append(path.join(this.store.runDir(run.id), 'events.jsonl'), event);
      await this.store.write(path.join(this.store.runDir(run.id), 'run.json'), run);
      this.events.push(event); if (this.events.length > 10000) this.events.shift();
      this.emit('event', event); return event;
    });
  }
  get(id: string) { const run = this.runs.get(id); if (!run) throw new Error('unknown run'); return run; }
  async source(input: RunInput, cwd: string) {
    if ([input.script, input.scriptPath, input.name].filter(v => v !== undefined).length !== 1) throw new Error('provide exactly one of script, scriptPath, name');
    if (input.script !== undefined) return input.script;
    if (input.scriptPath) return readFile(path.resolve(cwd, input.scriptPath), 'utf8');
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(input.name!)) throw new Error('invalid saved workflow name');
    for (const file of [path.join(this.store.home, 'workflows', input.name! + '.js'), path.join(cwd, '.stampede', 'workflows', input.name! + '.js')]) {
      try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new Error('saved workflow not found');
  }
  async start(input: RunInput, resumeOf?: string) {
    if (this.closing) throw new Error('hub is shutting down');
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const source = await this.source(input, cwd); const parsed = parseWorkflow(source);
    const config = lowerConfig(this.config, await readJson(path.join(cwd, '.stampede', 'config.json')) ?? {});
    const effective = input.limits ? lowerConfig(config, { limits: input.limits }) : config;
    for (const budget of [input.budgetTokens, input.budgetUsd]) if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) throw new Error('budget must be a non-negative finite number');
    // A script run several times (one batch per run) names each run apart by its title.
    const title = input.title?.trim();
    if (input.title !== undefined && (typeof input.title !== 'string' || !title || title.length > 80)) throw new Error('title must be 1 to 80 characters');
    const backend = input.defaultBackend ?? config.defaultBackend;
    if (!['claude', 'codex'].includes(backend)) throw new Error('invalid backend');
    if (input.budgetUsd !== undefined && backend === 'codex' && !config.pricing.codex?.[config.codex.defaultModel]) throw new Error(`budgetUsd requires pricing for codex model ${config.codex.defaultModel}`);
    const id = `run_${ulid()}`; const directory = this.store.runDir(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const scriptPath = path.join(directory, 'script.js'); await writeFile(scriptPath, source, { mode: 0o600 });
    const run: Run = { id, name: title || parsed.meta.name, ...(title ? { title } : {}), ...(resumeOf && input.continueInterrupted === false ? { continueInterrupted: false } : {}), cwd, scriptPath, scriptSha256: hash(source), args: input.args ?? null, status: 'running', resumeOf, phases: parsed.meta.phases ?? [], createdAt: now(), startedAt: now(), budget: { totalTokens: input.budgetTokens ?? null, spentTokens: 0, totalUsd: input.budgetUsd ?? null, spentUsd: 0 }, ...(input.notifyAgents ? { notifyAgents: true } : {}), counters: { agentsStarted: 0, agentsRunning: 0, messages: 0 }, orchestratorSessionId: input.orchestratorSessionId, agents: [], log: [], defaultBackend: backend, seenSeq: {}, readSeq: {}, cacheHits: 0, liveCalls: 0 };
    await this.store.write(path.join(directory, 'args.json'), run.args);
    const execution = new RunExecution(this, run, effective);
    run.cacheReport = { notCacheable: execution.cache.notCacheable, verificationFailures: execution.cache.verificationFailures, cachedExternalTools: execution.cache.cachedExternalTools };
    const limits = effective.scheduler;
    this.scheduler.configureRun(id, { global: limits.maxConcurrent, perRun: limits.perRun, claude: limits.claude.maxConcurrent, codex: limits.codex.maxConcurrent, reserve: limits.nonCommsReserve, admissionMaxMs: limits.admissionMaxMs });
    if (resumeOf) await execution.cache.load(this.store.runDir(resumeOf));
    if (this.closing) { this.scheduler.forgetRun(id); throw new Error('hub is shutting down'); }
    this.runs.set(id, run); this.active.set(id, execution);
    await this.event(run, 'run.status', { status: run.status });
    execution.task = execution.execute(source).finally(() => { this.active.delete(id); this.scheduler.forgetRun(id); });
    void execution.task.catch(error => { this.emit('internalError', error); });
    return { runId: id, status: run.status, scriptPath, cacheHits: 0, liveCalls: 0, ...run.cacheReport };
  }
  async resume(id: string, input: { scriptPath?: string; args?: unknown; orchestratorSessionId?: string; continueInterrupted?: boolean }) {
    const old = this.get(id); if (!runTerminal(old.status)) throw new Error('only terminal runs may be resumed');
    return this.start({ scriptPath: input.scriptPath ?? old.scriptPath, cwd: old.cwd, args: Object.hasOwn(input, 'args') ? input.args : old.args, defaultBackend: old.defaultBackend, budgetTokens: old.budget.totalTokens ?? undefined, budgetUsd: old.budget.totalUsd ?? undefined, orchestratorSessionId: input.orchestratorSessionId ?? old.orchestratorSessionId, notifyAgents: old.notifyAgents, title: old.title, continueInterrupted: input.continueInterrupted }, id);
  }
  async control(id: string, action: string) {
    const run = this.get(id), execution = this.active.get(id);
    if (!execution || runTerminal(run.status)) throw new Error('run is terminal');
    if (action === 'cancel') await execution.cancel();
    else if (action === 'pause' || action === 'resume') { run.status = action === 'pause' ? 'paused' : 'running'; this.scheduler.pause(id, action === 'pause'); await this.event(run, 'run.status', { status: run.status }); if (action === 'resume') execution.scheduleResumes(); }
    else throw new Error('invalid run action');
    return { status: run.status };
  }
  async shutdown() {
    this.closing = true;
    const executions = [...this.active.values()];
    await Promise.all(executions.map(e => e.cancel('interrupted')));
    await Promise.allSettled(executions.map(e => e.task));
    await this.flushEvents();
  }
  async flushEvents() { await this.eventMutex.run(async () => {}); await this.store.flush(); }
}

export class RunExecution {
  readonly abort = new AbortController();
  readonly cache = new RunCache();
  // Resume starts a fresh memo: edits made between runs must be visible even
  // inside the TTL. Writer generations invalidate other active runs as well.
  private readonly fingerprints: FingerprintMemo = new Map();
  readonly contexts = new Map<string, AgentContext>();
  readonly peers = new Map<string, Peer>();
  readonly teams = new Map<string, Team>();
  readonly bus: MessageBus;
  readonly unavailable = new Set<string>();
  task?: Promise<void>;
  runtime?: ReturnType<typeof executeWorkflow>;
  private readonly childRuntimes = new Set<ReturnType<typeof executeWorkflow>>();
  private readonly childAborts = new Set<AbortController>();
  private readonly childTasks = new Set<Promise<unknown>>();
  draining = false;
  private cancellation?: Promise<void>;
  constructor(readonly manager: RunManager, readonly run: Run, readonly config: Config) {
    this.bus = new MessageBus(run.id, this.peers, { ...config.limits, claimLeaseMs: config.delivery.claimLeaseMs }, async (kind, value) => {
      await manager.store.append(path.join(manager.store.runDir(run.id), kind === 'board.posted' ? 'board.jsonl' : 'messages.jsonl'), { kind, value });
      if (kind === 'delivery.handed') await this.event('message.delivered', value);
    });
    this.bus.on('message', (message, deliveries) => { run.counters.messages++; for (const d of deliveries) { const c = this.contexts.get(d.recipient); if (c) c.tainted = true; } void this.event('message.accepted', message).catch(e => this.fail(e)); this.scheduleResumes(); });
    this.bus.on('budget', from => { void this.notifyBudget('messages', from).catch(e => this.fail(e)); });
  }
  private async notifyBudget(kind: string, agent: string) {
    await this.bus.send('system', 'orchestrator', `${kind} limit reached for ${agent}; pending messages remain available.`, undefined, 'system');
    await this.event('budget.exhausted', { kind, agent });
  }
  private async backendUnavailable(backend: 'claude' | 'codex', error: { kind: string; message: string }) {
    if (this.unavailable.has(backend)) return;
    this.unavailable.add(backend);
    this.manager.scheduler.rejectBackend(this.run.id, backend, Object.assign(new Error(error.message), { kind: error.kind }));
    const hint = error.kind === 'auth' ? `auth failed for ${backend}: run '${backend === 'claude' ? 'claude auth login' : 'codex login'}'` : `${backend} could not start: ${error.message}`;
    await this.bus.send('system', 'orchestrator', hint.slice(0, 1000), undefined, 'system');
    await this.event('backend.unavailable', { backend, error, hint });
  }
  event(type: string, value: any = {}) { return this.manager.event(this.run, type, value); }
  sharedUse(name: string, tool: string, write = false) {
    const c = this.contexts.get(name)!; c.tainted = true;
    const uses = write ? c.shared.writes : c.shared.reads;
    if (!uses.includes(tool)) uses.push(tool);
  }
  async fail(error: Error) { if (!runTerminal(this.run.status)) { this.run.error = { message: error.message, stack: error.stack }; await this.cancel('failed'); } }
  budgetAvailable() { const b = this.run.budget; return (b.totalTokens === null || b.spentTokens < b.totalTokens) && (b.totalUsd === null || b.spentUsd < b.totalUsd); }
  async execute(source: string) {
    try {
      this.runtime = executeWorkflow({ source, filename: this.run.scriptPath, args: this.run.args, budgetTokens: this.run.budget.totalTokens, cpuBlockMs: this.config.limits.scriptCpuBlockMs, signal: this.abort.signal, call: (method, params) => this.call(method, params) });
      this.run.result = await this.runtime.result;
      this.draining = true;
      await this.stopMembers([...this.contexts.keys()]);
      for (const team of this.teams.values()) if (team.key) await this.recordTeam(team);
      if (!runTerminal(this.run.status)) { this.run.status = 'completed'; this.run.endedAt = now(); await this.event('run.status', { status: 'completed' }); }
    } catch (error) {
      if (!runTerminal(this.run.status)) { this.run.error = { message: (error as Error).message, stack: (error as Error).stack }; await this.cancel('failed'); }
    } finally {
      this.draining = true;
      for (const controller of this.childAborts) controller.abort();
      await Promise.allSettled(this.childTasks);
      await this.cancellation;
      await Promise.allSettled([...this.teams.values()].map(team => team.admission));
      await this.manager.store.write(path.join(this.manager.store.runDir(this.run.id), 'result.json'), { status: this.run.status, result: this.run.result, error: this.run.error, cacheHits: this.run.cacheHits, liveCalls: this.run.liveCalls, ...this.run.cacheReport, effects: this.run.agents.filter(a => a.workspace.kept).map(a => ({ name: a.name, ...a.workspace })) });
      await this.manager.store.write(path.join(this.manager.store.runDir(this.run.id), 'run.json'), this.run);
      for (const c of this.contexts.values()) { c.token = ''; for (const file of ['mcp.json', 'settings.json']) await rm(path.join(this.agentDir(c.agent), file), { force: true }); }
    }
  }
  async call(method: string, params: any, nesting = 0, group?: string): Promise<any> {
    if (this.abort.signal.aborted || this.draining || runTerminal(this.run.status)) throw new Error('run cancelled');
    const phase = (title?: string) => group ? group + (title ? ' / ' + title : '') : title;
    if (method === 'agent') { const opts = params.opts ?? {}; const c = this.prepare(params.prompt, { ...opts, phase: phase(opts.phase) }); c.task = this.dispatch(c); void c.task.catch(e => this.fail(e)); return c.done; }
    if (method === 'phase') { const title = phase(params.title)!; if (!group) this.run.phase = title; if (!this.run.phases.some(p => p.title === title)) this.run.phases.push({ title }); await this.event('phase', { title }); return; }
    // An agent's worktree as the script needs it to continue that work: branch, commits and path.
    if (method === 'workspace') { const a = this.run.agents.find(x => x.name === params.name); return a?.workspace.kind === 'worktree' ? { branch: a.workspace.branch ?? null, baseCommit: a.workspace.baseCommit ?? null, commit: a.workspace.commit ?? null, path: a.workspace.path, kept: a.workspace.kept ?? null } : null; }
    if (method === 'log') { this.run.log.push(params.message); this.run.log = this.run.log.slice(-100); await this.event('log', params); return; }
    if (method === 'send' || method === 'team.send') return (await this.sendOrchestrator(params.to, params.text)).seq;
    if (method === 'board' || method === 'team.board') return this.bus.entries.filter(e => !params.topic || e.topic === params.topic);
    if (method === 'spawnTeam') {
      const opts = params.opts ?? {};
      return this.spawnTeam(group ? params.members.map((member: any) => ({ ...member, phase: phase(member.phase ?? opts.phase) })) : params.members, { ...opts, phase: phase(opts.phase) });
    }
    if (method.startsWith('team.')) return this.teamCall(method.slice(5), params);
    if (method === 'workflow') {
      if (nesting) throw new Error('nested workflow() is unavailable');
      const input = typeof params.ref === 'string' ? { name: params.ref } : params.ref;
      const source = await this.manager.source(input, this.run.cwd);
      if (this.draining || this.abort.signal.aborted || runTerminal(this.run.status)) throw new Error('run cancelled');
      const childGroup = '▸ ' + (input.name ?? parseWorkflow(source).meta.name);
      const controller = new AbortController(); this.childAborts.add(controller);
      const child = executeWorkflow({ source, args: params.args, budgetTokens: this.run.budget.totalTokens, signal: AbortSignal.any([this.abort.signal, controller.signal]), cpuBlockMs: this.config.limits.scriptCpuBlockMs, call: (m, p) => this.call(m, p, 1, childGroup) });
      this.childRuntimes.add(child); child.setSpent(this.run.budget.spentTokens);
      const task = child.result.finally(() => { this.childRuntimes.delete(child); this.childAborts.delete(controller); this.childTasks.delete(task); });
      this.childTasks.add(task); return task;
    }
    throw new Error(`unknown workflow hook ${method}`);
  }
  async sendOrchestrator(to: string, text: string) {
    const sent = await this.bus.send('orchestrator', to, text);
    for (const team of this.teams.values()) if (to === '*' || team.names.includes(to)) team.lastOrchestratorMessage = Date.now();
    return sent;
  }
  private validate(prompt: string, opts: AgentOpts, team = false) {
    if (typeof prompt !== 'string') throw new Error('agent prompt must be a string');
    if (!this.budgetAvailable()) throw new Error('budget exhausted');
    const backend = opts.backend ?? this.run.defaultBackend;
    if (!['claude', 'codex'].includes(backend)) throw new Error('invalid backend');
    if (this.unavailable.has(backend)) throw new Error(`${backend} is unavailable for this run`);
    if (backend === 'codex' && (team || opts.comms) && this.manager.backends.codex.capabilities.mcpViaFlags === false) throw new Error('Codex messaging is not qualified for this CLI version; run stampede doctor and qualify the updated backend');
    if (opts.cwd !== undefined && typeof opts.cwd !== 'string') throw new Error('agent cwd must be a string');
    if (opts.schema) { validateSchema(opts.schema); if (backend === 'codex') codexSchema(opts.schema); }
    if (opts.access && !['read-only', 'edit', 'full'].includes(opts.access)) throw new Error('invalid access level');
    if (opts.access === 'full' && !this.config.allowFullAccess) throw new Error("access 'full' disabled by config");
    if (backend === 'codex' && (opts.access === 'edit' || opts.isolation === 'worktree' && opts.access !== 'read-only') && this.manager.backends.codex.capabilities.workspaceWriteReady === false) throw new Error('Codex workspace-write sandbox is not ready; run stampede doctor');
    if (opts.isolation && !['shared', 'worktree'].includes(opts.isolation)) throw new Error('invalid isolation');
    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > this.config.limits.turnTimeoutMs)) throw new Error('timeoutMs must be positive and no greater than the configured limit');
    if (opts.maxResumes !== undefined && (!Number.isInteger(opts.maxResumes) || opts.maxResumes < 0 || opts.maxResumes > this.config.limits.maxResumesPerAgent)) throw new Error('maxResumes must be an integer within the configured limit');
    if (opts.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) throw new Error('invalid effort');
    if (opts.cache !== undefined && !['auto', 'never'].includes(opts.cache)) throw new Error('invalid cache policy');
    if (opts.notify !== undefined && typeof opts.notify !== 'boolean') throw new Error('notify must be a boolean');
    if (opts.readWorktrees !== undefined && (!Array.isArray(opts.readWorktrees) || opts.readWorktrees.some(name => typeof name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(name)))) throw new Error('readWorktrees must be a list of agent names');
    if (opts.baseRef !== undefined) {
      const ref: any = opts.baseRef;
      if (typeof ref === 'string' ? !/^[^\s-]\S{0,199}$/.test(ref) : !ref || typeof ref !== 'object' || typeof ref.agent !== 'string') throw new Error('baseRef must be a git ref or { agent: name }');
      if (!(opts.isolation === 'worktree' || opts.isolation === undefined && (opts.access === 'edit' || opts.access === 'full'))) throw new Error("baseRef needs isolation 'worktree', or edit or full access");
      if (typeof ref === 'object' && !this.run.agents.find(a => a.name === ref.agent)?.workspace.commit) throw new Error(`baseRef agent ${ref.agent} has no finished worktree`);
    }
    if (opts.cacheInputs !== undefined && (!Array.isArray(opts.cacheInputs) || opts.cacheInputs.some(file => typeof file !== 'string'))) throw new Error('cacheInputs must be an array of paths');
    if (opts.name !== undefined && (typeof opts.name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(opts.name) || ['orchestrator', 'system'].includes(opts.name) || this.contexts.has(opts.name))) throw new Error('agent name must be unique and match [a-z0-9-]{1,40}');
    if (backend === 'codex' && opts.agentType && !this.config.codex.agentTypes[opts.agentType]) throw new Error(`unknown agentType for codex: ${opts.agentType}`);
    const model = opts.model ?? (backend === 'codex' && opts.agentType ? this.config.codex.agentTypes[opts.agentType].model : undefined) ?? this.config.codex.defaultModel;
    if (backend === 'codex' && this.run.budget.totalUsd !== null && !this.config.pricing.codex?.[model]) throw new Error(`budgetUsd requires pricing for codex model ${model}`);
  }
  prepare(prompt: string, opts: AgentOpts, teamId?: string): AgentContext {
    this.validate(prompt, opts, Boolean(teamId));
    if (this.run.counters.agentsStarted >= 1000) throw new Error('1000-agent cap reached');
    const n = this.run.counters.agentsStarted + 1;
    const backend = opts.backend ?? this.run.defaultBackend;
    const name = opts.name ?? `${(opts.label ?? backend).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32)}-${n}`;
    if (this.contexts.has(name)) throw new Error('duplicate agent name');
    const access = opts.access ?? (opts.isolation === 'worktree' ? 'edit' : 'read-only');
    const isolation = opts.isolation ?? (access === 'read-only' ? 'shared' : 'worktree');
    const enabled = Boolean(teamId || opts.comms);
    const canMessage = typeof opts.comms === 'object' ? opts.comms.canMessage ?? '*' : '*';
    const agent: Agent = { id: `agt_${ulid()}`, runId: this.run.id, name, label: opts.label ?? name, role: opts.role, phase: opts.phase ?? this.run.phase, backend, mode: 'oneshot', comms: { enabled, canMessage }, access, workspace: { kind: isolation, path: path.resolve(this.run.cwd, opts.cwd ?? '.') }, status: 'queued', markedDone: false, usage: zeroUsage(), resumes: 0, stopBlocks: 0, lastActivityAt: now(), turns: [], teamId };
    if (agent.phase && !this.run.phases.some(phase => phase.title === agent.phase)) this.run.phases.push({ title: agent.phase });
    let resolve!: (value: unknown) => void; const done = new Promise(r => { resolve = r; });
    const token = randomBytes(32).toString('hex');
    const context: AgentContext = { agent, opts, prompt, abort: new AbortController(), token, tokenHash: hash(token), done, resolve, tainted: false, shared: { reads: [], writes: [] }, resumeScheduled: false, autoDone: typeof opts.comms === 'object' ? opts.comms.autoDoneOnIdle ?? !teamId : !teamId };
    this.run.counters.agentsStarted = n;
    this.contexts.set(name, context); this.run.agents.push(agent);
    this.syncPeer(agent); return context;
  }
  // Codex's rollout is read at most every 2s while a turn streams, and always
  // when it ends; a missing or unreadable rollout leaves the last value.
  // Reads can overlap (a throttled one still in flight when the turn ends), so
  // only the latest one started applies its result.
  // Claude's transcript is read the same way, from where the last read of
  // the turn stopped: the turn's replies so far are its live output.
  private claudeRead = new Map<string, { offset: number; replies: Map<string, number>; at: number; reading: boolean }>();
  private claudeOutput(a: Agent) {
    const read = this.claudeRead.get(a.id);
    if (!read || read.reading || !a.sessionId || Date.now() - read.at < 2000) return;
    read.reading = true; read.at = Date.now();
    void claudeReplies(a.sessionId, a.workspace.path, read.offset).then(found => {
      if (!found || this.claudeRead.get(a.id) !== read || a.turns.at(-1)?.endedAt) return;
      read.offset = found.next;
      for (const [id, output] of found.replies) read.replies.set(id, output);
      a.liveTokens = [...read.replies.values()].reduce((sum, n) => sum + n, 0);
    }).catch(() => {}).finally(() => { read.reading = false; });
  }
  private codexRead = new Map<string, { at: number; n: number }>();
  private codexContext(a: Agent, final: boolean) {
    const last = this.codexRead.get(a.id) ?? { at: 0, n: 0 };
    if (!a.sessionId || !final && Date.now() - last.at < 2000) return;
    const n = last.n + 1;
    this.codexRead.set(a.id, { at: Date.now(), n });
    void codexContext(a.sessionId).then(found => {
      if (!found || this.codexRead.get(a.id)?.n !== n) return;
      a.context = { tokens: found.tokens, ...(found.window ? { window: found.window } : {}) };
      a.model = found.model ?? a.model;
      // The rollout counts the whole thread: the turns already ended on it are in `usage`.
      const open = a.turns.at(-1);
      if (!final && found.spent !== undefined && open && !open.endedAt) a.liveTokens = Math.max(0, found.spent - a.turns.filter(t => t.endedAt && t.outcome?.sessionId === a.sessionId).reduce((sum, t) => sum + t.outcome!.usage.outputTokens, 0));
    }).catch(() => {});
  }
  private syncPeer(a: Agent) { this.peers.set(a.name, { name: a.name, backend: a.backend, comms: a.comms.enabled, canMessage: a.comms.canMessage, status: a.status, markedDone: a.markedDone, turn: a.turns.length }); }
  /** A line of the run's log, which workflow_status shows the orchestrator, from the hub rather than the script. */
  private async note(message: string) { this.run.log.push(message); this.run.log = this.run.log.slice(-100); await this.event('log', { message }); }
  async status(c: AgentContext, status: Agent['status']) {
    c.agent.status = status; c.agent.lastActivityAt = now(); this.syncPeer(c.agent);
    await this.manager.store.write(path.join(this.agentDir(c.agent), 'agent.json'), { ...c.agent, token_sha256: c.tokenHash, prompt_sha256: hash(c.prompt), shared: { tainted: c.tainted } });
    await this.event('agent.status', { name: c.agent.name, status });
  }
  agentDir(agent: Agent) { return path.join(this.manager.store.runDir(this.run.id), 'agents', agent.id); }
  private slot(c: AgentContext) { return { id: c.agent.id, name: c.agent.name, runId: this.run.id, backend: c.agent.backend, comms: c.agent.comms.enabled }; }
  private async identifyCall(c: AgentContext, refresh = false) {
    if (c.key !== undefined && !refresh) return;
    const previousKey = c.key;
    const inputs = await fingerprint(c.agent.workspace.path, c.agent.workspace.kind, c.opts.cacheInputs ?? [], this.config.cache, this.fingerprints);
    c.inputs = inputs;
    const agentType = c.agent.backend === 'codex' && c.opts.agentType ? this.config.codex.agentTypes[c.opts.agentType] : undefined;
    const model = c.opts.model ?? agentType?.model ?? (c.agent.backend === 'codex' ? this.config.codex.defaultModel : undefined);
    const effort = c.opts.effort ?? agentType?.effort ?? (c.agent.backend === 'codex' ? this.config.codex.defaultEffort : undefined);
    // Whether the orchestrator hears of it changes nothing the agent does.
    const { notify: _notify, ...opts } = c.opts;
    c.key = hash(canonical({ spec: { prompt: c.prompt, ...opts, backend: c.agent.backend, access: c.agent.access, isolation: c.agent.workspace.kind, cwd: c.agent.workspace.path, model, effort, agentType, base: c.base }, args: this.run.args, inputs, backendVersion: this.manager.backends[c.agent.backend].version, settings: c.agent.backend === 'claude' ? this.config.claude : this.config.codex }));
    if (previousKey !== c.key) c.occ = this.cache.next(c.key);
    c.agent.callKey = c.key; c.agent.callOcc = c.occ;
    c.cacheable = inputs.cacheable && c.opts.cache !== 'never' && c.agent.access !== 'full' && (c.agent.access === 'read-only' || c.agent.workspace.kind === 'worktree');
    if (!c.cacheable && previousKey !== c.key) this.cache.notCacheable.push({ label: c.agent.label, reason: c.opts.cache === 'never' ? 'cache disabled' : inputs.cacheable ? 'unverifiable workspace effects' : 'workspace fingerprint unavailable' });
  }
  async dispatch(c: AgentContext, preReserved?: (id?: string) => void) {
    c.release = preReserved;
    try {
      if (this.unavailable.has(c.agent.backend)) throw new Error(`${c.agent.backend} is unavailable for this run`);
      c.release = preReserved ?? await this.manager.scheduler.acquire([this.slot(c)], c.abort.signal);
      if (this.abort.signal.aborted || c.abort.signal.aborted) { await this.finish(c, 'cancelled'); return; }
      if (!this.budgetAvailable()) { c.agent.error = { kind: 'budget', message: 'budget exhausted' }; await this.finish(c, 'failed'); return; }
      // An agent continuing another's work starts from the commit that work ended at, or the ref given; the key holds the commit.
      if (c.opts.baseRef !== undefined) c.base ??= typeof c.opts.baseRef === 'object' ? this.run.agents.find(a => a.name === (c.opts.baseRef as { agent: string }).agent)!.workspace.commit! : await resolveCommit(c.agent.workspace.path, c.opts.baseRef);
      await this.identifyCall(c);
      if (c.cacheable && !c.agent.teamId) {
        const hit = await this.cache.lookup(c.key!, c.occ!);
        if (hit) {
          c.cached = true; c.agent.result = hit.result; c.agent.workspace = hit.effects; c.agent.externalTools = hit.externalTools;
          if (hit.externalTools?.length) this.cache.cachedExternalTools.push({ label: c.agent.label, tools: hit.externalTools });
          this.run.cacheHits++; await this.finish(c, 'done'); return;
        }
      }
      // An agent the resumed run lost mid-turn when the hub stopped continues its own session, in its own worktree.
      const prior = await this.interrupted(c);
      if (prior) {
        c.agent.workspace = { ...prior.workspace }; c.agent.sessionId = prior.sessionId; c.agent.continues = { runId: this.run.resumeOf!, agentId: prior.id };
        await this.note(`${c.agent.name}: continuing its interrupted session${prior.workspace.kind === 'worktree' ? ' and worktree' : ''} from ${this.run.resumeOf}`);
        await this.configure(c); this.run.liveCalls++;
        await this.turn(c, CONTINUE_PROMPT, true);
        return;
      }
      if (c.agent.workspace.kind === 'worktree') { c.agent.workspace = await createWorkspace(c.agent.workspace.path, this.run.id, c.agent.name, c.base).catch(error => { throw Object.assign(error, { kind: 'workspace' }); }); await this.event('worktree.created', { name: c.agent.name, workspace: c.agent.workspace }); }
      await this.configure(c);
      this.run.liveCalls++;
      await this.turn(c, c.prompt, false);
    } catch (error) {
      if (error instanceof AdmissionError) { c.agent.error = { kind: error.kind, message: error.message, blockedBy: error.blockedBy, waitedMs: error.waitedMs }; await this.event('team.admission_blocked', { agents: [c.agent.name], blockedBy: error.blockedBy, waitedMs: error.waitedMs }); }
      // Only a failure to start the backend makes it unavailable; a worktree problem fails this agent alone, and says so.
      else { c.agent.error = { kind: (error as any).kind ?? 'spawn', message: (error as Error).message }; if (!c.abort.signal.aborted && ['spawn', 'auth'].includes(c.agent.error.kind)) await this.backendUnavailable(c.agent.backend, c.agent.error); else if (!c.abort.signal.aborted) await this.note(`${c.agent.name}: ${c.agent.error.message}`); }
      if (!agentTerminal(c.agent.status)) await this.finish(c, c.abort.signal.aborted ? 'cancelled' : 'failed');
    } finally {
      if (agentTerminal(c.agent.status)) { c.release?.(c.agent.id); c.release = undefined; }
    }
  }
  /**
   * The agent of the resumed run that this call is (same key and occurrence),
   * if the hub stopped during its turn and its session, and its worktree where
   * it had one, are still there. Messaging agents and team members start
   * again, as does an agent another run already continued.
   */
  private async interrupted(c: AgentContext) {
    const old = this.run.resumeOf ? this.manager.runs.get(this.run.resumeOf) : undefined;
    if (!old || old.status !== 'interrupted' || this.run.continueInterrupted === false || c.agent.comms.enabled || c.agent.teamId) return undefined;
    const prior = old.agents.find(a => a.callKey === c.key && a.callOcc === c.occ && a.status === 'cancelled' && a.error?.kind === 'interrupted' && a.backend === c.agent.backend && a.sessionId && a.turns.length);
    if (!prior || [...this.manager.runs.values()].some(run => run.agents.some(a => a.continues?.agentId === prior.id))) return undefined;
    const worktreeGone = prior.workspace.kind === 'worktree' && await git(prior.workspace.path, ['rev-parse', '--abbrev-ref', 'HEAD']).then(head => head !== prior.workspace.branch, () => true);
    const sessionGone = !worktreeGone && !await (prior.backend === 'claude' ? claudeSessionExists(prior.sessionId!, prior.workspace.path) : codexThreadExists(prior.sessionId!));
    if (worktreeGone || sessionGone) { await this.note(`${c.agent.name}: interrupted in ${old.id}, but its ${worktreeGone ? 'worktree' : 'session'} is gone, so it starts again`); return undefined; }
    return prior;
  }
  private async configure(c: AgentContext) {
    const a = c.agent, backend = this.manager.backends[a.backend];
    if (!backend.available || this.unavailable.has(a.backend)) throw new Error(backend.error ?? 'backend unavailable');
    const dir = this.agentDir(a); await mkdir(dir, { recursive: true, mode: 0o700 });
    const mcpPath = path.join(dir, 'mcp.json'), settingsPath = path.join(dir, 'settings.json');
    await this.manager.store.write(mcpPath, { mcpServers: a.comms.enabled ? { stampede: { type: 'stdio', command: process.execPath, args: [this.manager.cliEntry, 'mcp', '--role', 'agent'], env: { STAMPEDE_HUB_URL: this.manager.hubUrl, STAMPEDE_AGENT_TOKEN: c.token } } } : {} });
    const hook = (event: string) => ({ type: 'command', command: `"${process.execPath}" "${path.join(path.dirname(this.manager.cliEntry), 'hook.js')}" ${event} --backend claude`, timeout: 5 });
    // Other agents' worktrees are closed to a Claude agent, but for reading
    // the ones its call names in readWorktrees (a reviewer of an integrator's
    // branch); Codex's sandbox limits writes, not reads.
    const readable = new Set(c.opts.readWorktrees ?? []);
    const otherWorktrees = await Promise.all(this.run.agents.filter(p => p.name !== a.name && p.workspace.kind === 'worktree').map(async p => ({ name: p.name, root: p.workspace.repo ? p.workspace.path : path.join(await repoRoot(p.workspace.path) ?? p.workspace.path, '.stampede', 'worktrees', this.run.id.slice(-10).toLowerCase(), p.name) })));
    const denied: [string, string[]][] = [[this.manager.store.home, ['Read', 'Edit', 'Write']], ...otherWorktrees.map(({ name, root }): [string, string[]] => [root, readable.has(name) ? ['Edit', 'Write'] : ['Read', 'Edit', 'Write']])];
    await this.manager.store.write(settingsPath, { enabledPlugins: { 'stampede@stampede': false }, permissions: { deny: denied.flatMap(([root, tools]) => tools.map(tool => `${tool}(${root.replaceAll('\\', '/')}/**)`)) }, ...(a.comms.enabled ? { hooks: { PostToolUse: [{ matcher: '*', hooks: [hook('post-tool-use')] }], Stop: [{ hooks: [hook('stop')] }] } } : {}) });
    const agentType = c.opts.agentType && a.backend === 'codex' ? this.config.codex.agentTypes[c.opts.agentType] : undefined;
    const schemaPath = c.opts.schema ? path.join(dir, 'schema.json') : undefined;
    if (schemaPath) await this.manager.store.write(schemaPath, a.backend === 'codex' ? codexSchema(c.opts.schema!).schema : c.opts.schema);
    c.launch = { backend: a.backend, binary: backend.binary!, entry: backend.entry, developerInstructionsFlag: backend.capabilities.developerInstructionsFlag !== false, cwd: a.workspace.path, access: a.access, model: c.opts.model ?? agentType?.model ?? (a.backend === 'codex' ? this.config.codex.defaultModel : undefined), effort: c.opts.effort ?? agentType?.effort ?? (a.backend === 'codex' ? this.config.codex.defaultEffort : undefined), agentType: c.opts.agentType, schema: c.opts.schema, schemaPath, mcpPath, settingsPath, contract: contract({ ...a, cwd: a.workspace.path, schema: c.opts.schema, comms: a.comms.enabled, peers: [...this.contexts.keys()], canMessage: a.comms.canMessage, team: Boolean(a.teamId) }) + '\n' + (agentType?.developerInstructions ?? '') + '\n' + (c.opts.appendSystemPrompt ?? ''), comms: a.comms.enabled, hubUrl: this.manager.hubUrl, token: c.token, cliEntry: this.manager.cliEntry, windowsSandbox: this.config.codex.windowsSandbox, timeoutMs: c.opts.timeoutMs ?? this.config.limits.turnTimeoutMs, stdoutPath: '', stderrPath: '', inheritMcpServers: this.config.claude.inheritMcpServers, persistNonComms: this.config.claude.persistNonComms, settingSources: this.config.claude.isolateUserHooks ? 'project,local' : this.config.claude.settingSources, editShellAllow: this.config.claude.editShellAllow, denyTools: this.config.claude.denyTools, skills: this.config.claude.skills, maxUsd: this.config.limits.claudeTurnMaxUsd ?? undefined, disableHooks: a.backend === 'codex' && this.config.codex.disableUserHooks, approvalsReviewer: a.backend === 'codex' ? this.config.codex.approvalsReviewer ?? undefined : undefined };
    // The model asked for shows until the backend reports the one it resolved.
    a.model ??= c.launch.model;
    // An edit agent on Claude with no shell rule can change files but not build or test them.
    if (a.backend === 'claude' && a.access === 'edit' && !c.launch.editShellAllow?.length) await this.note(`${a.name}: edit access with no shell (claude.editShellAllow is empty), so it cannot run builds or tests`);
  }
  private async turn(c: AgentContext, initialPrompt: string, resume: boolean) {
    const a = c.agent;
    let prompt = initialPrompt, attempts = 0, repairs = 0, kind = resume ? 'resume' : 'start';
    for (;;) {
      if (c.abort.signal.aborted || this.abort.signal.aborted) { await this.finish(c, 'cancelled'); return; }
      while (this.run.status === 'paused') await sleep(50, c.abort.signal);
      if (!this.budgetAvailable()) { a.error = { kind: 'budget', message: 'budget exhausted' }; await this.finish(c, 'failed'); return; }
      const n = a.turns.length + 1; const dir = this.agentDir(a);
      const launch = { ...c.launch!, stdoutPath: path.join(dir, `turn-${n}.stdout.jsonl`), stderrPath: path.join(dir, `turn-${n}.stderr.log`), lastMessagePath: path.join(dir, `turn-${n}.last.txt`) };
      const claim = a.comms.enabled ? await this.bus.claim(a.name, resume ? 'resume' : 'read', n, 50) : undefined;
      if (claim?.messages.length) { this.sharedUse(a.name, resume ? 'delivery:resume' : 'delivery:stdin'); prompt += '\n' + envelopes(claim.messages, claim.deliveries, this.peers); }
      // The turn's prompt beside its stream, for the transcript the pane shows.
      await writeFile(path.join(dir, `turn-${n}.prompt.txt`), prompt, { mode: 0o600 }).catch(() => {});
      const turn = { n, kind, startedAt: now(), stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath } as Agent['turns'][number];
      a.turns.push(turn); a.stopBlocks = 0;
      await this.status(c, resume ? 'resuming' : 'starting');
      await this.event('agent.turn.start', { name: a.name, n, kind });
      this.run.counters.agentsRunning++;
      // A resumed session's transcript already holds earlier turns, so this one counts from its end.
      const resumed = resume || kind === 'schema-repair' ? a.sessionId : undefined;
      if (a.backend === 'claude') this.claudeRead.set(a.id, { offset: resumed ? await claudeTranscriptSize(resumed, a.workspace.path) : 0, replies: new Map(), at: 0, reading: false });
      c.handle = launchTurn(launch, prompt, { resumeSessionId: resume || kind === 'schema-repair' ? a.sessionId : undefined, onSpawn: pid => this.manager.processStarted?.(pid, a) ?? Promise.resolve(), onHanded: async () => { if (claim?.claimId) await this.bus.ack(a.name, claim.claimId); }, onEvent: event => {
        a.lastActivityAt = now();
        // Saved as soon as known: a hub killed mid-turn leaves only what is on disk to continue from.
        const session = event.thread_id ?? event.session_id;
        if (session && session !== a.sessionId) { a.sessionId = session; void this.event('agent.session', { name: a.name }).catch(() => {}); }
        const tools = externalTools(event);
        if (tools.length) a.externalTools = [...new Set([...(a.externalTools ?? []), ...tools])].slice(0, 100);
        if (a.backend === 'claude') {
          if (event.type === 'system' && typeof event.model === 'string') a.model = event.model;
          if (event.type === 'system' && event.subtype === 'init' && typeof event.apiKeySource === 'string') a.billing = event.apiKeySource === 'none' ? 'subscription' : 'api';
          const context = claudeContext(event), window = claudeWindow(event);
          if (context || window) a.context = { tokens: context?.tokens ?? a.context?.tokens ?? 0, ...((window ?? a.context?.window) ? { window: window ?? a.context?.window } : {}) };
          // The stream's own usage counts output as each request starts; the transcript has its final count.
          this.claudeOutput(a);
        } else if (event.type === 'item.completed' || event.type === 'turn.completed') this.codexContext(a, event.type === 'turn.completed');
      } });
      await this.status(c, 'running');
      const outcome = await c.handle.done; c.handle = undefined; this.run.counters.agentsRunning--;
      if (a.access !== 'read-only') await invalidateFingerprint(a.workspace.path, a.access === 'full');
      turn.endedAt = now(); turn.outcome = outcome; delete a.liveTokens; a.sessionId = outcome.sessionId ?? a.sessionId;
      if (a.backend === 'codex') this.codexContext(a, true);
      for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const) a.usage[key] += outcome.usage[key];
      const pricing = a.backend === 'codex' ? this.config.pricing.codex?.[launch.model!] : undefined;
      if (pricing) outcome.usage.usd = (Math.max(0, outcome.usage.inputTokens - outcome.usage.cachedInputTokens) * pricing.inputPerMTok + outcome.usage.cachedInputTokens * pricing.cachedPerMTok + outcome.usage.outputTokens * pricing.outputPerMTok) / 1e6;
      // Codex has no USD of its own: one priced from the user's configured rates is treated as billed.
      if (pricing) a.billing = 'api';
      if (outcome.usage.usd !== null) { a.usage.usd = (a.usage.usd ?? 0) + outcome.usage.usd; this.run.budget.spentUsd += outcome.usage.usd; }
      // Both backends count reasoning inside output tokens; `reasoningTokens` is its share, for information.
      this.run.budget.spentTokens += outcome.usage.outputTokens;
      this.runtime?.setSpent(this.run.budget.spentTokens);
      for (const child of this.childRuntimes) child.setSpent(this.run.budget.spentTokens);
      await this.event('agent.usage', { name: a.name, usage: outcome.usage, budget: this.run.budget });
      if (!this.budgetAvailable()) await this.event('budget.exhausted', this.run.budget);
      await this.bus.endTurn(a.name, n, outcome.ok);
      await this.event('agent.turn.end', { name: a.name, n, outcome: outcome.ok ? 'ok' : 'error' });
      if (agentTerminal(a.status)) return;
      if (c.retryRequested) { c.retryRequested = false; kind = 'retry'; prompt = initialPrompt; continue; }
      if (outcome.ok) {
        try {
          let result: unknown = outcome.text;
          if (c.opts.schema) {
            // A Claude answer with no structured output (its tools left the
            // structured-output tool out) is read from its text, as Codex's is.
            const parsed = a.backend === 'claude' && outcome.structured === undefined ? jsonAnswer(outcome.text) : undefined;
            result = a.backend === 'claude' ? outcome.structured ?? parsed : codexSchema(c.opts.schema).decode(jsonAnswer(outcome.text));
            const validate = validateSchema(c.opts.schema); if (!validate(result)) throw new Error(JSON.stringify(validate.errors).slice(0, 1024));
            if (parsed !== undefined) await this.note(`${a.name}: no structured output, so its answer's JSON was used; an agent type's tools may leave out the structured-output tool`);
          }
          if (result === undefined) throw new Error('missing final output');
          // A turn that stored a result supersedes an earlier attempt's error.
          a.result = result; a.resultStoredAtTurn = n; delete a.error;
          if (!a.comms.enabled || a.markedDone || c.autoDone && this.bus.uncommitted([a.name]) === 0) await this.finish(c, 'done');
          else { await this.status(c, 'idle'); this.scheduleResumes(); }
          return;
        } catch (error) {
          // The repair resumes the thread or session that gave the answer, so its work is kept; a
          // Claude session that was not kept (persistNonComms off) cannot be resumed.
          const resumable = a.backend === 'codex' || a.comms.enabled || c.launch!.persistNonComms !== false;
          if (resumable && a.sessionId && repairs++ < this.config.limits.schemaRepairs) { await this.note(`${a.name}: its answer did not match the schema; asking it to correct it`); kind = 'schema-repair'; resume = true; prompt = `Your final message did not match the required JSON schema. Errors: ${(error as Error).message}. Reply with only the corrected JSON object.`; continue; }
          outcome.error = { kind: 'schema', message: (error as Error).message };
        }
      }
      const error = outcome.error ?? { kind: 'unknown', message: 'backend returned no result' }; a.error = error;
      if (['auth', 'spawn'].includes(error.kind)) await this.backendUnavailable(a.backend, error);
      const limited = ['rate_limit', 'overloaded'].includes(error.kind);
      if (limited) { this.manager.scheduler.rateLimited(a.backend); await this.event('scheduler.cooldown', { backend: a.backend }); }
      const maxAttempts = limited ? 6 : ['crash', 'unknown'].includes(error.kind) ? 3 : ['schema', 'timeout'].includes(error.kind) ? 2 : 1;
      if (++attempts >= maxAttempts) {
        await this.finish(c, c.abort.signal.aborted ? 'cancelled' : 'failed');
        // Its agent() has resolved null and the script goes on without it, so the orchestrator hears now
        // rather than at run end; an unavailable backend has already said so for auth and spawn errors.
        if (a.status === 'failed' && !['auth', 'spawn'].includes(error.kind)) await this.event('agent.failed', { name: a.name, label: a.label, phase: a.phase, attempts, error: { kind: error.kind, message: error.message.slice(0, 300) } });
        return;
      }
      if (!a.comms.enabled) { c.release?.(a.id); c.release = undefined; }
      if (limited) await sleep(Math.min(120000, [5000, 15000, 45000][attempts - 1] ?? 120000) + parseInt(hash(a.id).slice(0, 4), 16) % 1000, c.abort.signal);
      if (!a.comms.enabled) c.release = await this.manager.scheduler.acquire([this.slot(c)], c.abort.signal);
      await this.note(`${a.name}: attempt ${attempts} failed (${error.kind}): ${error.message.slice(0, 160)}; retrying${resume ? '' : ' from the start'}`);
      kind = 'retry'; if (!resume) a.sessionId = undefined;
      prompt = initialPrompt;
    }
  }
  private finish(c: AgentContext, status: Agent['status']) {
    if (!c.finishing) c.finishing = this.finishNow(c, c.requestedTerminal ?? status);
    return c.finishing;
  }
  private async finishNow(c: AgentContext, status: Agent['status']) {
    if (agentTerminal(c.agent.status)) return;
    if (status === 'done' && c.agent.result === undefined) throw new Error('cannot complete agent without stored result');
    if (!c.cached) {
      c.agent.workspace = await finishWorkspace(c.agent.workspace, c.agent.name, status === 'done' && c.agent.access === 'edit');
      if (c.agent.workspace.kind === 'worktree' && c.agent.workspace.repo) await this.event(c.agent.workspace.kept ? 'worktree.kept' : 'worktree.removed', { name: c.agent.name, workspace: c.agent.workspace });
    }
    await this.status(c, status); await this.bus.terminate(c.agent.name); c.release?.(c.agent.id); c.release = undefined;
    if (c.key !== undefined) await this.manager.store.append(path.join(this.manager.store.runDir(this.run.id), 'journal.jsonl'), { key: c.key, occ: c.occ, agentId: c.agent.id, backend: c.agent.backend, status, result: c.agent.result ?? null, inputs: c.inputs, cacheable: c.cacheable ?? false, tainted: c.tainted, shared: c.shared, externalTools: c.agent.externalTools ?? [], effects: c.agent.workspace, usage: c.agent.usage });
    c.token = ''; c.resolve(status === 'done' ? c.agent.result : null);
    // An opted-in agent's own work wakes the orchestrator; a result replayed from the cache does not.
    if (status === 'done' && !c.cached && (c.opts.notify ?? this.run.notifyAgents)) await this.event('agent.done', { name: c.agent.name, label: c.agent.label, phase: c.agent.phase });
  }
  scheduleResumes() {
    if (this.run.status !== 'running' || this.draining || !this.budgetAvailable()) return;
    for (const c of this.contexts.values()) {
      const a = c.agent;
      if (a.status !== 'idle' || a.markedDone || c.resumeScheduled || !this.bus.pending(a.name)) continue;
      if (a.resumes >= (c.opts.maxResumes ?? this.config.limits.maxResumesPerAgent)) {
        if (!c.resumeLimitNotified) { c.resumeLimitNotified = true; void this.notifyBudget('resumes', a.name).catch(e => this.fail(e)); }
        continue;
      }
      c.resumeScheduled = true;
      c.task = (async () => {
        await sleep(this.config.delivery.resumeDebounceMs, c.abort.signal);
        if (a.status !== 'idle' || this.run.status !== 'running' || this.draining || !this.bus.pending(a.name)) return;
        a.resumes++; await this.turn(c, 'You were idle and received new messages. Act on them and end your turn with your final answer; repeat your previous answer if unchanged.', true);
      })().catch(async error => { if (!agentTerminal(a.status)) { a.error = { kind: 'cancelled', message: error.message }; await this.finish(c, 'cancelled'); } }).finally(() => { c.resumeScheduled = false; this.scheduleResumes(); });
    }
  }
  async releaseIdle() {
    for (const team of this.teams.values()) if (team.releaseIdleAfterMs !== undefined) {
      for (const name of team.names) {
        const c = this.contexts.get(name)!;
        if (c.agent.status === 'idle' && !c.resumeScheduled && this.bus.uncommitted([name]) === 0 && Date.now() - Date.parse(c.agent.lastActivityAt) >= team.releaseIdleAfterMs) await this.finish(c, 'done');
      }
    }
  }
  cancel(status: Run['status'] = 'cancelled'): Promise<void> {
    if (this.cancellation) return this.cancellation;
    if (runTerminal(this.run.status)) return Promise.resolve();
    this.cancellation = this.cancelNow(status); return this.cancellation;
  }
  private async cancelNow(status: Run['status']) {
    const cut = [...this.contexts.values()].filter(c => !agentTerminal(c.agent.status));
    this.run.status = status; this.run.endedAt = now(); this.abort.abort();
    await Promise.all([...this.contexts.values()].map(async c => { c.abort.abort(); const handle = c.handle; await handle?.kill(); await handle?.done; await c.task?.catch(() => {}); await c.finishing; if (!agentTerminal(c.agent.status)) await this.finish(c, 'cancelled'); }));
    await Promise.allSettled([...this.teams.values()].map(team => team.admission));
    if (status === 'interrupted') for (const c of cut) if (c.agent.status === 'cancelled') c.agent.error = { ...INTERRUPTED };
    this.manager.scheduler.pause(this.run.id, false); await this.event('run.status', { status });
  }
  async controlAgent(name: string, action: string) {
    const c = this.contexts.get(name); if (!c) throw new Error('unknown agent');
    if (agentTerminal(c.agent.status)) throw new Error('agent is terminal');
    if (action === 'retry') {
      if (c.handle) { c.retryRequested = true; await c.handle.kill(); }
      else if (c.agent.status === 'idle') { c.task = this.turn(c, c.prompt, Boolean(c.agent.sessionId)); void c.task.catch(e => this.fail(e)); }
      else throw new Error('agent has no active or idle turn to retry');
    } else if (action === 'skip' || action === 'cancel') {
      c.requestedTerminal = action === 'skip' ? 'skipped' : 'cancelled'; c.abort.abort(); const handle = c.handle; await handle?.kill(); await handle?.done; await c.task?.catch(() => {}); await this.finish(c, c.requestedTerminal);
    } else throw new Error('invalid agent action');
    return { status: c.agent.status };
  }
  async stopMembers(names: string[]) {
    const members = names.map(n => this.contexts.get(n)!);
    const deadline = Date.now() + this.config.limits.drainMs;
    while (members.some(c => c.agent.markedDone && !agentTerminal(c.agent.status) && c.agent.status !== 'idle') && Date.now() < deadline) await sleep(25);
    for (const c of members) c.abort.abort();
    const stoppedTeams = [...this.teams.values()].filter(team => team.names.every(name => {
      const c = this.contexts.get(name)!; return c.abort.signal.aborted || agentTerminal(c.agent.status);
    }));
    for (const team of stoppedTeams) team.admissionAbort?.abort();
    await Promise.allSettled(stoppedTeams.map(team => team.admission));
    for (const c of members) {
      const handle = c.handle; await handle?.kill(); await handle?.done;
      await c.task?.catch(() => {});
      await c.finishing;
      if (agentTerminal(c.agent.status)) continue;
      await this.finish(c, c.agent.status === 'idle' && c.agent.result !== undefined ? 'done' : 'cancelled');
    }
  }
  async spawnTeam(members: (AgentOpts & { name: string; prompt: string })[], opts: any) {
    if (!Array.isArray(members) || !members.length || this.run.counters.agentsStarted + members.length > 1000) throw new Error('invalid team size');
    if (new Set(members.map(m => m.name)).size !== members.length || members.some(m => !m.name)) throw new Error('team names must be unique');
    if (opts.releaseIdleAfterMs !== undefined && (!Number.isFinite(opts.releaseIdleAfterMs) || opts.releaseIdleAfterMs < 0)) throw new Error('invalid releaseIdleAfterMs');
    for (const member of members) this.validate(member.prompt, member, true);
    const topology = opts.topology;
    if (topology !== undefined && topology !== 'mesh' && topology !== 'star' &&
      (!topology || typeof topology !== 'object' || Array.isArray(topology) || Object.values(topology).some(peers => !Array.isArray(peers) || peers.some(peer => typeof peer !== 'string')))) throw new Error('invalid team topology');
    const id = `team_${ulid()}`, names = members.map(m => m.name);
    if (opts.topology === 'star' && !names.includes(opts.lead)) throw new Error('star topology requires a lead member');
    this.manager.scheduler.validate(members.map(m => ({ id: m.name, name: m.name, runId: this.run.id, backend: m.backend ?? this.run.defaultBackend, comms: true })));
    const team: Team = { id, names, createdAt: Date.now(), lastOrchestratorMessage: 0, releaseIdleAfterMs: opts.releaseIdleAfterMs };
    this.teams.set(id, team);
    const contexts = members.map(m => {
      const allowed = topology === 'star' ? m.name === opts.lead ? names.filter(n => n !== m.name) : [opts.lead] : typeof topology === 'object' ? Object.hasOwn(topology, m.name) ? topology[m.name] : [] : names.filter(n => n !== m.name);
      return this.prepare(m.prompt, { ...m, phase: m.phase ?? opts.phase, comms: { canMessage: [...allowed, 'orchestrator'], autoDoneOnIdle: false } }, id);
    });
    for (const c of contexts) await this.identifyCall(c);
    team.key = hash(canonical({ keys: contexts.map(c => c.key), topology: opts.topology ?? 'mesh', lead: opts.lead }));
    team.occ = this.cache.next('team:' + team.key);
    const replay = await this.cache.lookupTeam(team.key, team.occ);
    if (replay && contexts.every(c => c.cacheable)) {
      team.replay = replay;
      for (const c of contexts) {
        const member = replay.members.find(m => m.name === c.agent.name)!;
        c.cached = true; c.agent.result = member.result; c.agent.markedDone = member.markedDone; c.agent.workspace = member.effects;
        c.agent.externalTools = member.externalTools;
        if (member.externalTools?.length) this.cache.cachedExternalTools.push({ label: c.agent.label, tools: member.externalTools });
        this.run.cacheHits++; await this.finish(c, 'done');
      }
      for (const entry of replay.boardEntries) await this.bus.post(entry.author, { title: entry.title, body: entry.body, topic: entry.topic, data: entry.data, replayedFrom: replay.runId });
      await this.recordTeam(team);
      return { id, names };
    }
    team.admissionAbort = new AbortController();
    const admission = this.manager.scheduler.acquire(contexts.map(c => this.slot(c)), AbortSignal.any([this.abort.signal, team.admissionAbort.signal]));
    team.admission = admission.then(async release => {
      try {
        for (const c of contexts) await this.identifyCall(c, true);
        const key = hash(canonical({ keys: contexts.map(c => c.key), topology: opts.topology ?? 'mesh', lead: opts.lead }));
        if (key !== team.key) { team.key = key; team.occ = this.cache.next('team:' + key); }
        for (const c of contexts) { c.task = this.dispatch(c, release); void c.task.catch(e => this.fail(e)); }
      } catch (error) { release(); throw error; }
    }).catch(async error => {
      for (const c of contexts) { c.agent.error = { kind: error instanceof AdmissionError ? 'admission_timeout' : error.kind ?? 'cancelled', message: error.message, blockedBy: error.blockedBy, waitedMs: error.waitedMs }; await this.finish(c, error instanceof AdmissionError || error.kind ? 'failed' : 'cancelled'); }
      if (error instanceof AdmissionError) await this.event('team.admission_blocked', { names, blockedBy: error.blockedBy });
    });
    return { id, names };
  }
  async teamCall(method: string, params: any): Promise<any> {
    const team = this.teams.get(params.id); if (!team) throw new Error('unknown team');
    const selected = params.names ?? team.names;
    if (!Array.isArray(selected) || selected.some((n: string) => !team.names.includes(n))) throw new Error('unknown team member');
    const members = selected.map((n: string) => this.contexts.get(n)!);
    if (method === 'results') return Object.fromEntries(members.map(c => [c.agent.name, { status: c.agent.status, result: c.agent.result ?? null, markedDone: c.agent.markedDone }]));
    if (method === 'messages') return team.replay?.messages ?? this.bus.messages.filter(m => team.names.includes(m.from) || team.names.includes(m.to) || m.to === '*');
    if (method === 'stop') { await this.stopMembers(team.names); await this.recordTeam(team); return; }
    if (!['untilQuiet', 'untilDone'].includes(method)) throw new Error('unknown team method');
    const maxMs = Math.min(params.opts?.maxMs ?? this.config.limits.teamMaxMs, this.config.limits.teamMaxMs), idleMs = params.opts?.idleMs ?? 30000;
    const maxMessages = Math.min(params.opts?.maxMessages ?? this.config.limits.teamMaxMessages, this.config.limits.teamMaxMessages);
    if (!Number.isFinite(maxMs) || maxMs < 0 || !Number.isFinite(idleMs) || idleMs < 0) throw new Error('invalid team observation duration');
    if (!Number.isInteger(maxMessages) || maxMessages < 0) throw new Error('invalid team message limit');
    const start = Date.now(); let quietSince: number | undefined;
    for (;;) {
      const admissionFailed = members.filter(c => c.agent.error?.kind === 'admission_timeout').map(c => c.agent.name);
      const notTerminal = members.filter(c => !agentTerminal(c.agent.status)).map(c => c.agent.name);
      if (admissionFailed.length) return { reason: 'admission-timeout', admissionFailed, ...(method === 'untilDone' ? { notTerminal: [] } : {}) };
      if (!notTerminal.length) { await Promise.all(members.map(c => c.finishing)); await this.recordTeam(team); return { reason: method === 'untilDone' ? 'all-terminal' : 'all-done', admissionFailed: [], ...(method === 'untilDone' ? { notTerminal: [] } : {}) }; }
      if (Date.now() - start >= maxMs) return { reason: 'max-ms', admissionFailed: [], ...(method === 'untilDone' ? { notTerminal } : {}) };
      if (method === 'untilQuiet') {
        if (!this.budgetAvailable()) return { reason: 'budget', admissionFailed: [] };
        if (this.bus.messages.filter(m => team.names.includes(m.from)).length >= maxMessages) return { reason: 'max-messages', admissionFailed: [] };
        const quiet = !members.some(c => ['queued', 'starting', 'running', 'resuming'].includes(c.agent.status) || c.resumeScheduled) && this.bus.uncommitted(team.names) === 0;
        quietSince = quiet ? quietSince ?? Date.now() : undefined;
        if (quietSince !== undefined && Date.now() - quietSince >= idleMs) {
          const deadlock = members.some(c => c.agent.status === 'waiting') && Date.now() - team.lastOrchestratorMessage >= idleMs;
          await this.recordTeam(team); await this.event(deadlock ? 'team.deadlock' : 'team.quiet', { teamId: team.id }); return { reason: deadlock ? 'deadlock' : 'quiet', admissionFailed: [] };
        }
      }
      await sleep(25, this.abort.signal);
    }
  }
  private async recordTeam(team: Team) {
    const contexts = team.names.map(name => this.contexts.get(name)!);
    const record: TeamRecord = { teamKey: team.key!, occ: team.occ!, runId: this.run.id, status: contexts.every(c => agentTerminal(c.agent.status)) ? 'complete' : 'partial',
      members: contexts.map(c => ({ name: c.agent.name, status: c.agent.status, result: c.agent.result ?? null, markedDone: c.agent.markedDone, effects: c.agent.workspace, cacheable: c.cacheable ?? false, externalTools: c.agent.externalTools })),
      boardEntries: this.bus.entries.filter(e => team.names.includes(e.author)), messages: team.replay?.messages ?? this.bus.messages.filter(m => team.names.includes(m.from) || team.names.includes(m.to) || m.to === '*') };
    await this.manager.store.append(path.join(this.manager.store.runDir(this.run.id), 'teams.jsonl'), record);
  }
}
