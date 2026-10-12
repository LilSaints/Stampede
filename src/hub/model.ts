import type { Usage, TurnOutcome } from '../backends/adapter.js';
import type { Workspace } from './workspaces.js';
import type { Meta } from '../runtime/parse.js';
import type { McpServerEntry } from '../backends/userConfig.js';
export type AgentStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'idle' | 'resuming' | 'done' | 'failed' | 'cancelled' | 'skipped';
export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export const agentTerminal = (status: string) => ['done', 'failed', 'cancelled', 'skipped'].includes(status);
export const runTerminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export interface AgentOpts {
  backend?: 'claude' | 'codex'; label?: string; name?: string; role?: string; phase?: string; schema?: Record<string, any>; model?: string; effort?: string;
  isolation?: 'worktree' | 'shared'; access?: 'read-only' | 'edit' | 'full'; cwd?: string; agentType?: string; timeoutMs?: number; maxResumes?: number;
  comms?: boolean | { canMessage?: string[] | '*'; autoDoneOnIdle?: boolean }; cache?: 'auto' | 'never' | 'commit'; cacheInputs?: string[]; appendSystemPrompt?: string;
  /** Wake the orchestrator when this agent is done; overrides the run's `notifyAgents`. Not part of the cache key. */
  notify?: boolean;
  /** Other agents of the run whose worktrees this Claude agent may read (a reviewer of an integrator's branch); all others stay closed. */
  readWorktrees?: string[];
  /** Where this agent's worktree starts: a git ref, or another agent's finished worktree (`{ agent: name }`); default the checkout's HEAD. */
  baseRef?: string | { agent: string };
  /** Folders this agent may use for scratch files: it may delete inside them (the cleanup tool), and they are removed when it is done. Relative to its workspace. */
  scratch?: string[];
  /** Environment variables for the worker and the shells it runs, over the hub's own. Part of the cache key. */
  env?: Record<string, string>;
  /** Hub-wide locks this agent may take with the lock tool, for a resource only one worker may use at a time (a real desktop window). */
  locks?: string[];
  /** Claude only: the built-in tools the worker has (Claude's --tools), within what its access level allows; [] for none. MCP tools are not in it. */
  tools?: string[];
  /** MCP servers the worker gets beside Stampede's: names from the backend's own config, or `{ name: config }` in Claude's shape. A script may pass one `{ name: config, … }` map instead, which validate makes this list. */
  mcpServers?: McpServerEntry[];
  /** Claude only: plugins turned on or off for this worker by id (name@marketplace), bare name, or `*` for every one the user has. */
  plugins?: Record<string, boolean>;
  /** Claude only, `access: 'read-only'` with `isolation: 'worktree'`: the worker may run the claude.editShellAllow commands; its worktree is thrown away at its end whatever it holds. */
  shell?: boolean;
  /** Files the worker must not change, as paths or globs from its worktree's root (`HANDOFF.md`, `docs/**`): Claude's file tools are denied them, and at its end the hub puts any change to them back as it was at its base. */
  protect?: string[];
}
export interface Agent {
  id: string; runId: string; name: string; label: string; phase?: string; role?: string; backend: 'claude' | 'codex'; mode: 'oneshot';
  comms: { enabled: boolean; canMessage: string[] | '*' }; access: 'read-only' | 'edit' | 'full'; workspace: Workspace;
  status: AgentStatus; sessionId?: string; markedDone: boolean; result?: unknown; resultStoredAtTurn?: number; teamId?: string;
  usage: Usage; resumes: number; stopBlocks: number; lastActivityAt: string; error?: { kind: string; message: string; blockedBy?: string[]; waitedMs?: number };
  externalTools?: string[];
  /** The resolved model, its reasoning effort and its latest request's size, for the UI. */
  model?: string; effort?: string; context?: { tokens: number; window?: number };
  /** The call's cache key and occurrence, by which a resumed run finds this agent again. */
  callKey?: string; callOcc?: number;
  /** Hashes of what the call key is made of (call, base, reads, args, workspace, backend version, settings), so a resumed run can say which changed. */
  callParts?: Record<string, string>;
  /** The interrupted agent of an earlier run whose session (and worktree) this one continued instead of starting again. */
  continues?: { runId: string; agentId: string };
  /** Tokens the turn in flight has spent so far, counted as `usage` counts them; `usage` takes them over when it ends. */
  liveTokens?: number;
  /** How the worker pays: an API key's spend is real; a subscription's USD is only an estimate. */
  billing?: 'api' | 'subscription';
  turns: { n: number; kind: string; startedAt: string; endedAt?: string; outcome?: TurnOutcome; stdoutPath: string; stderrPath: string }[];
}
export interface Run {
  id: string; name: string; cwd: string; scriptPath: string; scriptSha256: string; args: unknown; status: RunStatus; resumeOf?: string;
  phases: NonNullable<Meta['phases']>; createdAt: string; startedAt?: string; endedAt?: string; result?: unknown; error?: { message: string; stack?: string };
  budget: { totalTokens: number | null; spentTokens: number; totalUsd: number | null; spentUsd: number };
  counters: { agentsStarted: number; agentsRunning: number; messages: number }; orchestratorSessionId?: string;
  /** Wake the orchestrator as each agent is done, unless its call says `notify: false`. */
  notifyAgents?: boolean;
  /** The run's own name, given at workflow_run; `name` is it, or the script's meta.name without one. */
  title?: string;
  /** false: a resume starts every interrupted agent again rather than continuing its session and worktree. */
  continueInterrupted?: boolean;
  agents: Agent[]; log: string[];
  /** Every log line ever written (`log` keeps the last 100), and how many of them each orchestrator session has been shown. */
  logCount?: number; logSeen?: Record<string, number>;
  phase?: string; defaultBackend: 'claude' | 'codex'; seenSeq: Record<string, number>; readSeq: Record<string, number>;
  cacheHits: number; liveCalls: number;
  cacheReport?: { notCacheable: { label: string; reason: string }[]; verificationFailures: string[]; cachedExternalTools?: { label: string; tools: string[] }[]; misses?: { label: string; reason: string }[] };
  notifications?: { hubSeq: number; runId: string; type: string; at: string; data: any }[];
  /** The script's checkpoint() calls, in order: what each asked and how it was answered. */
  checkpoints?: Checkpoint[];
}
/** A script's `checkpoint(name, data)`: it waits for the orchestrator's answer (workflow_answer), its timeout, or a replay from the run it resumes. */
export interface Checkpoint { name: string; occ: number; data: unknown; status: 'waiting' | 'answered' | 'timed_out'; askedAt: string; timeoutMs: number; answeredAt?: string; answer?: unknown; replayedFrom?: string }
/** Each cancelled agent of a run and, for one with a worktree, where its work is: branch, commit and path. */
export const cancelledAgents = (run: Run) => run.agents.filter(a => a.status === 'cancelled').map(a => ({ name: a.name, ...(a.workspace.kind === 'worktree' ? { branch: a.workspace.branch ?? null, commit: a.workspace.commit ?? null, worktree: a.workspace.path, kept: a.workspace.kept ?? null, ...(a.workspace.releasedAt ? { releasedAt: a.workspace.releasedAt } : {}) } : {}) }));
/** A run's effects: each worktree it kept, and each one since released, whose branch and commit still hold its work. */
export const worktreeEffects = (run: Run) => run.agents.filter(a => a.workspace.kept || a.workspace.releasedAt).map(a => ({ name: a.name, ...a.workspace }));
