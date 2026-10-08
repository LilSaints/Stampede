import type { Usage, TurnOutcome } from '../backends/adapter.js';
import type { Workspace } from './workspaces.js';
import type { Meta } from '../runtime/parse.js';
export type AgentStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'idle' | 'resuming' | 'done' | 'failed' | 'cancelled' | 'skipped';
export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export const agentTerminal = (status: string) => ['done', 'failed', 'cancelled', 'skipped'].includes(status);
export const runTerminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export interface AgentOpts {
  backend?: 'claude' | 'codex'; label?: string; name?: string; role?: string; phase?: string; schema?: Record<string, any>; model?: string; effort?: string;
  isolation?: 'worktree' | 'shared'; access?: 'read-only' | 'edit' | 'full'; cwd?: string; agentType?: string; timeoutMs?: number; maxResumes?: number;
  comms?: boolean | { canMessage?: string[] | '*'; autoDoneOnIdle?: boolean }; cache?: 'auto' | 'never'; cacheInputs?: string[]; appendSystemPrompt?: string;
}
export interface Agent {
  id: string; runId: string; name: string; label: string; phase?: string; role?: string; backend: 'claude' | 'codex'; mode: 'oneshot';
  comms: { enabled: boolean; canMessage: string[] | '*' }; access: 'read-only' | 'edit' | 'full'; workspace: Workspace;
  status: AgentStatus; sessionId?: string; markedDone: boolean; result?: unknown; resultStoredAtTurn?: number; teamId?: string;
  usage: Usage; resumes: number; stopBlocks: number; lastActivityAt: string; error?: { kind: string; message: string; blockedBy?: string[]; waitedMs?: number };
  externalTools?: string[];
  turns: { n: number; kind: string; startedAt: string; endedAt?: string; outcome?: TurnOutcome; stdoutPath: string; stderrPath: string }[];
}
export interface Run {
  id: string; name: string; cwd: string; scriptPath: string; scriptSha256: string; args: unknown; status: RunStatus; resumeOf?: string;
  phases: NonNullable<Meta['phases']>; createdAt: string; startedAt?: string; endedAt?: string; result?: unknown; error?: { message: string; stack?: string };
  budget: { totalTokens: number | null; spentTokens: number; totalUsd: number | null; spentUsd: number };
  counters: { agentsStarted: number; agentsRunning: number; messages: number }; orchestratorSessionId?: string;
  agents: Agent[]; log: string[]; phase?: string; defaultBackend: 'claude' | 'codex'; seenSeq: Record<string, number>; readSeq: Record<string, number>;
  cacheHits: number; liveCalls: number;
  cacheReport?: { notCacheable: { label: string; reason: string }[]; verificationFailures: string[]; cachedExternalTools?: { label: string; tools: string[] }[] };
  notifications?: { hubSeq: number; runId: string; type: string; at: string; data: any }[];
}
