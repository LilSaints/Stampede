import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { VERSION, UI_API_VERSION, type Config } from './config.js';
import { Security, type Identity } from './security.js';
import { Store, readJson, readJournal } from './store.js';
import { RunManager } from './runs.js';
import { type Run, runTerminal, agentTerminal } from './model.js';
import { probeBackends, type BackendInfo } from './capabilities.js';
import { hash } from './workspaces.js';
import { validateTool } from '../mcp/tools.js';
import { parseWorkflow } from '../runtime/parse.js';
import { envelopes } from './bus.js';
import { collectRuns } from './maintenance.js';

const truncate = (value: string, max: number) => value.length > max ? value.slice(0, max) + `…(+${value.length - max} chars)` : value;
export function summary(run: Run, session?: string) {
  return { runId: run.id, name: run.name, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, orchestratorSessionId: run.orchestratorSessionId,
    phases: run.phases.map(p => ({ ...p, counts: Object.fromEntries(['queued', 'running', 'waiting', 'idle', 'done', 'failed'].map(s => [s, run.agents.filter(a => a.phase === p.title && a.status === s).length])) })),
    agents: run.agents.map(a => ({ name: a.name, backend: a.backend, status: a.status, phase: a.phase, role: a.role, comms: a.comms.enabled, markedDone: a.markedDone, tokens: a.usage.outputTokens + (a.backend === 'codex' ? a.usage.reasoningTokens : 0), lastActivity: a.lastActivityAt, error: a.error, workspace: a.workspace })),
    budget: { spent: run.budget.spentTokens, total: run.budget.totalTokens }, log: run.log.slice(-10).map(s => truncate(s, 300)), seenSeq: session ? run.seenSeq[session] ?? 0 : 0,
    resultPath: path.join(path.dirname(run.scriptPath), 'result.json'), error: run.error, notifications: run.notifications ?? [] };
}
export async function startHub(options: { home: string; config: Config; cliEntry: string; backends?: Record<'claude' | 'codex', BackendInfo>; security?: Security }) {
  const { home, config } = options;
  const security = options.security ?? new Security();
  await security.start(home, config.security.ancestryCheck);
  const lockPath = path.join(home, 'hub.lock');
  let ownsLock = false;
  try {
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const saved = await readJson<{ pid: number; startFileTime?: string }>(lockPath);
    const live = saved ? await security.identity(saved.pid) : undefined;
    if (live && live.startFileTime === saved?.startFileTime) { await security.close(); throw new Error('hub already running'); }
    if (saved && !saved.startFileTime) { await security.close(); throw new Error('hub lock has no verifiable process identity; inspect before removing'); }
    await rm(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  ownsLock = true;
  const identity = await security.identity(process.pid);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startFileTime: identity?.startFileTime })); await lock.sync(); await lock.close();
  const store = new Store(home);
  const manager = new RunManager(store, config, options.backends ?? await probeBackends(config, home), options.cliEntry);
  manager.on('internalError', error => { void store.appendLog(path.join(home, 'hub.log'), { at: new Date().toISOString(), level: 'error', message: String(error) }).catch(() => {}); });
  manager.processStarted = async (pid, agent) => {
    const identity = await security.track(pid);
    if (identity) await store.write(path.join(store.runDir(agent.runId), 'agents', agent.id, 'pids.json'), identity);
  };
  manager.recoverAgent = async agent => {
    const identity = await readJson<Identity>(path.join(store.runDir(agent.runId), 'agents', agent.id, 'pids.json'));
    if (identity) await security.killVerified(identity);
  };
  await manager.restore();
  const token = randomBytes(32).toString('hex');
  await writeFile(path.join(home, 'hub.token'), token, { mode: 0o600 });
  let stopping = false, lastRequest = Date.now(), nextCollection = Date.now() + 86400000;
  const matches = (value: string, expected: string) => value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  async function body(request: IncomingMessage) {
    let size = 0; const parts: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('request body too large'); parts.push(chunk); }
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  }
  async function messages(run: Run) { const execution = manager.active.get(run.id); if (execution) return execution.bus.messages; return (await readJournal<any>(path.join(store.runDir(run.id), 'messages.jsonl'))).filter(r => r.kind === 'message.accepted').map(r => r.value.message); }
  async function runSummary(run: Run, session?: string) {
    const all = await messages(run); const inbox = all.filter(m => m.to === 'orchestrator' || m.to === '*' && m.from !== 'orchestrator');
    return { ...summary(run, session), unreadForOrchestrator: inbox.filter(m => m.seq > (run.readSeq[session ?? 'anonymous'] ?? 0)).length, messages: all.slice(-20).map(m => ({ ...m, text: truncate(m.text, 300) })) };
  }
  async function orch(name: string, input: any, ui = false): Promise<any> {
    validateTool(name, input, 'orchestrator');
    const run = input.runId ? manager.get(input.runId) : undefined;
    const execution = run && manager.active.get(run.id);
    let result: any, observedSeq = manager.hubSeq;
    if (name === 'workflow_run') result = await manager.start(input);
    else if (name === 'workflow_resume') result = await manager.resume(input.runId, input);
    else if (name === 'workflow_control') result = await manager.control(input.runId, input.action);
    else if (name === 'workflow_send') { if (!execution) throw new Error('run is terminal'); result = await execution.sendOrchestrator(input.to, input.text); }
    else if (name === 'workflow_status' || name === 'workflow_wait') {
      let woke;
      if (name === 'workflow_wait') {
        const deadline = Date.now() + (input.timeoutSec ?? 45) * 1000;
        while (!runTerminal(run!.status) && Date.now() < deadline) {
          const view = await runSummary(run!, input.orchestratorSessionId);
          if (input.wakeOnMessage !== false && view.unreadForOrchestrator) { woke = 'message'; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        woke ??= runTerminal(run!.status) ? 'terminal' : 'timeout';
      }
      observedSeq = manager.hubSeq;
      const view = await runSummary(run!, input.orchestratorSessionId);
      result = { status: run!.status, phase: run!.phase, phases: view.phases, ...(input.verbose ? { agents: view.agents } : {}), log: view.log, budget: run!.budget, startedAt: run!.startedAt, elapsedSec: (Date.parse(run!.endedAt ?? new Date().toISOString()) - Date.parse(run!.startedAt!)) / 1000, unreadForOrchestrator: view.unreadForOrchestrator, latestMessages: view.messages.slice(-5), error: run!.error, ...(woke ? { woke } : {}) };
    } else if (name === 'workflow_result') { if (!runTerminal(run!.status)) throw new Error('not_finished'); result = { status: run!.status, result: run!.result, error: run!.error, resultPath: path.join(store.runDir(run!.id), 'result.json'), cacheHits: run!.cacheHits, liveCalls: run!.liveCalls, ...run!.cacheReport, effects: run!.agents.filter(a => a.workspace.kept).map(a => ({ name: a.name, ...a.workspace })) }; }
    else if (name === 'workflow_messages') {
      const key = input.orchestratorSessionId ?? 'anonymous';
      const inbox = (await messages(run!)).filter(m => (m.to === 'orchestrator' || m.to === '*' && m.from !== 'orchestrator') && (input.unreadOnly === false || m.seq > (run!.readSeq[key] ?? 0))).slice(0, input.max ?? 20);
      if (inbox.length) run!.readSeq[key] = Math.max(run!.readSeq[key] ?? 0, inbox.at(-1).seq);
      result = { messages: inbox };
    } else if (name === 'workflow_list') result = { runs: [...manager.runs.values()].filter(r => !input.status || r.status === input.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, input.limit ?? 20).map(r => ({ runId: r.id, name: r.name, status: r.status, createdAt: r.createdAt })) };
    else if (name === 'agent_control') {
      if (!execution) throw new Error('run is terminal');
      result = await execution.controlAgent(input.agent, input.action);
    } else if (name === 'workflow_saved') {
      const directory = path.join(home, 'workflows'); await mkdir(directory, { recursive: true });
      if (input.action === 'list') result = { workflows: (await readdir(directory)).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)) };
      else {
        if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(input.name ?? '')) throw new Error('invalid saved workflow name');
        const file = path.join(directory, input.name + '.js');
        if (input.action === 'save') { if (!input.scriptPath) throw new Error('scriptPath required'); const source = await readFile(path.resolve(input.scriptPath), 'utf8'); parseWorkflow(source); await writeFile(file, source, { mode: 0o600 }); }
        result = { name: input.name, scriptPath: file, ...(input.action === 'show' ? { script: await readFile(file, 'utf8') } : {}) };
      }
    } else if (name === 'stampede_doctor') result = { version: VERSION, node: process.version, backends: manager.backends, security: { aclVerified: security.aclVerified, ancestryActive: security.ancestryActive, warnings: security.warnings }, hub: { url: manager.hubUrl, activeRuns: manager.active.size } };
    if (run && !ui && input.orchestratorSessionId && ['workflow_status', 'workflow_wait', 'workflow_result', 'workflow_messages'].includes(name)) { run.seenSeq[input.orchestratorSessionId] = observedSeq; await store.write(path.join(store.runDir(run.id), 'run.json'), run); }
    if (run && ui) await manager.event(run, 'orchestrator.action', { tool: name, action: input.action, agent: input.agent });
    return result;
  }
  async function agentRoute(token: string, name: string, input: any, signal: AbortSignal) {
    let found;
    for (const execution of manager.active.values()) for (const c of execution.contexts.values()) if (!agentTerminal(c.agent.status) && c.agent.comms.enabled && matches(hash(token), c.tokenHash)) found = { execution, c };
    if (!found) throw Object.assign(new Error('unauthorized agent'), { statusCode: 401 });
    const { execution, c } = found; const a = c.agent; const bus = execution.bus;
    if (name === 'claim-ack') { if (typeof input.claimId !== 'string') throw new Error('claimId required'); return { ok: await bus.ack(a.name, input.claimId) }; }
    if (name === 'claim') {
      if (input.event === 'stop' && (a.markedDone || a.stopBlocks >= config.limits.maxStopBlocks)) return { messages: [] };
      const batch = await bus.claim(a.name, input.event === 'stop' ? 'stop-hook' : 'hook', a.turns.length, config.delivery.hookBatchMax, 24 * 1024);
      if (batch.claimId) { c.tainted = true; if (input.event === 'stop') a.stopBlocks++; }
      return { ...batch, context: batch.messages.length ? envelopes(batch.messages, batch.deliveries, execution.peers) : '' };
    }
    validateTool(name, input, 'agent');
    if (!['whoami', 'mark_done'].includes(name)) c.tainted = true;
    if (name === 'whoami') return { name: a.name, role: a.role, backend: a.backend, runId: a.runId, team: a.teamId, canMessage: a.comms.canMessage === '*' ? [...execution.peers.keys(), 'orchestrator'].filter(n => n !== a.name) : a.comms.canMessage };
    if (name === 'list_agents') return { agents: [...execution.peers.values()].filter(p => p.name === a.name || a.comms.canMessage === '*' || a.comms.canMessage.includes(p.name)).map(p => ({ ...p, unreadFromMe: bus.deliveries.filter(d => d.recipient === p.name && d.state !== 'committed' && bus.messages.find(m => m.seq === d.seq)?.from === a.name).length })).concat([{ name: 'orchestrator', backend: 'claude', comms: true, canMessage: '*', status: 'running', markedDone: false, turn: 0, unreadFromMe: 0 }]) };
    if (name === 'send_message') return bus.send(a.name, input.to, input.text, input.replyTo);
    if (name === 'read_messages') return bus.claim(a.name, 'read', a.turns.length, input.max);
    if (name === 'wait_for_message') {
      await execution.status(c, 'waiting');
      try { const result = await bus.wait(a.name, a.turns.length, (input.timeoutSec ?? 45) * 1000, input.from, AbortSignal.any([signal, c.abort.signal])); return { ...result, teamQuiet: ![...execution.peers.values()].some(p => p.name !== a.name && ['queued', 'starting', 'running', 'resuming'].includes(p.status)) }; }
      finally { if (a.status === 'waiting') await execution.status(c, 'running'); }
    }
    if (name === 'post_finding') { const entry = await bus.post(a.name, input); await execution.event('board.posted', entry); return { seq: entry.seq, id: entry.id }; }
    if (name === 'read_board') return { entries: bus.board(input.topic, input.sinceSeq, input.max), lastSeq: bus.entries.at(-1)?.seq ?? 0 };
    if (name === 'mark_done') { a.markedDone = true; execution.peers.get(a.name)!.markedDone = true; await execution.event('agent.status', { name: a.name, markedDone: true }); return { ok: true, reminder: 'End your turn now with your final answer, matching the schema if supplied. mark_done does not store your result.' }; }
  }
  const requests = new Set<Promise<void>>();
  const maintenance = new Set<Promise<unknown>>();
  function track(set: Set<Promise<unknown>>, task: Promise<unknown>) {
    set.add(task); void task.finally(() => set.delete(task)).catch(error => manager.emit('internalError', error));
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (stopping) { response.writeHead(503); response.end('hub is shutting down'); return; }
    track(requests, handleRequest(request, response));
  });
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    lastRequest = Date.now();
    const abort = new AbortController(); response.once('close', () => { if (!response.writableFinished) abort.abort(); });
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
      const agent = url.pathname.startsWith('/v1/agent/');
      if (!agent && !matches(bearer, token)) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      if (!agent && url.pathname !== '/health') {
        const verdict = await security.allowed(request.socket.remotePort!, (server.address() as any).port);
        await store.appendLog(path.join(home, 'hub.log'), { at: new Date().toISOString(), route: url.pathname, client: verdict.client, allowed: verdict.allowed });
        if (!verdict.allowed) throw Object.assign(new Error('worker ancestry cannot access orchestrator routes'), { statusCode: 403 });
      }
      let result: any;
      if (request.method === 'GET' && url.pathname === '/health') result = { ok: true, version: VERSION };
      else if (request.method === 'POST' && url.pathname === '/v1/hub/shutdown') {
        const input = await body(request);
        if (manager.active.size && input.force !== true) throw new Error('active runs prevent restart; use --force to interrupt them');
        result = { stopping: true }; setTimeout(() => { void close(); }, 50);
      }
      else if (request.method === 'POST' && url.pathname.startsWith('/v1/orch/')) { if (stopping) throw new Error('hub shutting down'); result = await orch(url.pathname.slice(9), await body(request), request.headers['x-stampede-ui'] === '1'); }
      else if (request.method === 'POST' && agent) result = await agentRoute(bearer, url.pathname.slice(10), await body(request), abort.signal);
      else if (request.method === 'GET' && url.pathname === '/v1/ui/snapshot') result = { uiApiVersion: UI_API_VERSION, version: VERSION, hubSeq: manager.hubSeq, uiConfig: config.ui, runs: await Promise.all([...manager.runs.values()].filter(r => !runTerminal(r.status) || Date.now() - Date.parse(r.endedAt!) < config.ui.recentRunsMin * 60000).map(r => runSummary(r, url.searchParams.get('session') ?? undefined))) };
      else if (request.method === 'GET' && url.pathname === '/v1/ui/events') {
        const since = Number(url.searchParams.get('since') ?? 0), max = Math.min(500, Math.max(1, Number(url.searchParams.get('max') ?? 500)));
        const events = manager.events.filter(e => e.hubSeq > since);
        const selected = events.slice(0, max);
        result = { hubSeq: selected.at(-1)?.hubSeq ?? manager.hubSeq, events: selected, truncated: events.length > max || since < (manager.events[0]?.hubSeq ?? manager.hubSeq + 1) - 1 };
      } else throw Object.assign(new Error('route not found'), { statusCode: 404 });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result ?? {}));
    } catch (error) { if (!response.headersSent) response.writeHead((error as any).statusCode ?? 400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: (error as Error).message, code: (error as any).code ?? 'request_failed' })); }
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port; manager.hubUrl = `http://127.0.0.1:${port}`;
  await store.write(path.join(home, 'hub.json'), { pid: process.pid, port, token_sha256: hash(token), started_at: new Date().toISOString(), version: VERSION });
  const interval = setInterval(() => {
    manager.scheduler.tick();
    if (Date.now() >= nextCollection) { nextCollection = Date.now() + 86400000; track(maintenance, collectRuns(store, config).catch(error => { security.warnings.push(`retention failed: ${error.message}`); })); }
    for (const execution of manager.active.values()) track(maintenance, execution.bus.expire().then(() => execution.releaseIdle()).catch(error => execution.fail(error)));
    if (!manager.active.size && Date.now() - lastRequest > config.hub.idleShutdownMin * 60000) void close();
  }, 1000);
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true; clearInterval(interval);
    closing = (async () => {
      await manager.shutdown(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...requests, ...maintenance]);
      await manager.shutdown(); await rm(lockPath, { force: true }); await security.close();
    })();
    return closing;
  }
  return { manager, server, token, port, security, close };
  } catch (error) {
    if (ownsLock) await rm(lockPath, { force: true });
    await security.close(); throw error;
  }
}
