import type { Schema } from './codexSchema.js';
export type ErrorKind = 'rate_limit' | 'auth' | 'overloaded' | 'context_overflow' | 'schema' | 'spawn' | 'crash' | 'timeout' | 'cancelled' | 'admission_timeout' | 'unknown';
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; usd: number | null }
export const zeroUsage = (): Usage => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: null });
export interface AgentLaunch {
  backend: 'claude' | 'codex'; binary: string; entry?: string; cwd: string;
  access: 'read-only' | 'edit' | 'full'; model?: string; effort?: string; agentType?: string;
  /** Folders outside `cwd` an edit worker may also write: its scratch folders. */
  writableDirs?: string[];
  schema?: Schema; schemaPath?: string; lastMessagePath?: string;
  mcpPath: string; settingsPath: string; contract: string; comms: boolean;
  /** The Stampede tools the worker gets: every one with comms, else at most `cleanup`, `lock` and `unlock`; none, no Stampede server. */
  mcpTools?: string[];
  /** A file of Claude agent definitions (`--agents`): the agent type copied with the tools it needs added. */
  agentsPath?: string;
  hubUrl: string; token?: string; cliEntry: string;
  windowsSandbox: string; timeoutMs: number; stdoutPath: string; stderrPath: string;
  inheritMcpServers?: boolean; settingSources?: string; editShellAllow?: string[]; maxUsd?: number; persistNonComms?: boolean;
  /** Claude tools removed beyond the recursion tools; `skills: false` also removes skills and custom commands. */
  denyTools?: string[]; skills?: boolean;
  /** The call's built-in Claude tools (`--tools`); without it, all of them. */
  tools?: string[];
  /** The call's other MCP servers, resolved and in the backend's shape: Claude's are in `mcpPath` beside Stampede's, Codex's go on its argv. */
  mcpServers?: Record<string, Record<string, unknown>>;
  disableHooks?: boolean; extraEnv?: Record<string, string>; mcpEnv?: Record<string, string>;
  /** Codex's approvals_reviewer ("user", "auto_review"); Codex's own default without one. */
  approvalsReviewer?: string;
  codexHookCommand?: string; trustCodexHooks?: boolean; developerInstructionsFlag?: boolean;
}
export interface TurnOutcome { ok: boolean; sessionId?: string; text?: string; structured?: unknown; usage: Usage; error?: { kind: ErrorKind; message: string }; code: number | null; signal?: string | null }
export interface TurnHandle { done: Promise<TurnOutcome>; kill(): Promise<void>; pid?: number }
export function classify(text: string, status?: number): ErrorKind {
  if (status === 429 || /rate.?limit|\b429\b/i.test(text)) return 'rate_limit';
  if (status === 401 || status === 403 || /unauthori[sz]ed|authentication|not logged in|invalid.*(?:api.?key|token)|\b401\b/i.test(text)) return 'auth';
  if (status === 503 || status === 529 || /overloaded|\b(?:503|529)\b/i.test(text)) return 'overloaded';
  if (/context.*(?:exceed|long|full)|maximum context/i.test(text)) return 'context_overflow';
  if (/schema|structured.output/i.test(text)) return 'schema';
  return 'unknown';
}
