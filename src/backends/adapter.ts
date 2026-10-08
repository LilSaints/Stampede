import type { Schema } from './codexSchema.js';
export type ErrorKind = 'rate_limit' | 'auth' | 'overloaded' | 'context_overflow' | 'schema' | 'spawn' | 'crash' | 'timeout' | 'cancelled' | 'admission_timeout' | 'unknown';
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; usd: number | null }
export const zeroUsage = (): Usage => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: null });
export interface AgentLaunch {
  backend: 'claude' | 'codex'; binary: string; entry?: string; cwd: string;
  access: 'read-only' | 'edit' | 'full'; model?: string; effort?: string; agentType?: string;
  schema?: Schema; schemaPath?: string; lastMessagePath?: string;
  mcpPath: string; settingsPath: string; contract: string; comms: boolean;
  hubUrl: string; token?: string; cliEntry: string;
  windowsSandbox: string; timeoutMs: number; stdoutPath: string; stderrPath: string;
  inheritMcpServers?: boolean; settingSources?: string; editShellAllow?: string[]; maxUsd?: number; persistNonComms?: boolean;
  disableHooks?: boolean; extraEnv?: Record<string, string>; mcpEnv?: Record<string, string>;
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
