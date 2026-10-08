import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** What an agent's model holds right now: its latest request's prompt and reply. */
export interface ContextSize { tokens: number; window?: number }

/**
 * Claude reports usage on every assistant message, one per API request, so
 * the latest one's input, cache and output tokens are the current context.
 * The `result` event's usage sums every request of the turn and overstates it.
 */
export function claudeContext(event: any): ContextSize | undefined {
  if (event?.type !== 'assistant' || event.parent_tool_use_id) return undefined;
  const u = event.message?.usage;
  if (!u) return undefined;
  return { tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) };
}
export function claudeWindow(event: any): number | undefined {
  if (event?.type !== 'result') return undefined;
  const windows = Object.values(event.modelUsage ?? {}).map((m: any) => m?.contextWindow).filter((w): w is number => Number.isInteger(w) && w > 0);
  return windows.length ? Math.max(...windows) : undefined;
}

/**
 * `codex exec --json` only reports the turn's summed usage. The session's
 * rollout file records each request's `last_token_usage` and the context
 * window, and the turn's model, so the newest of those is read from its tail.
 * Its `total_token_usage` counts the whole thread, so `spent` is the thread's
 * output tokens so far (its reasoning tokens included), as the budget counts them.
 */
const rollouts = new Map<string, string>();
const TAIL_BYTES = 256 * 1024;
export async function codexContext(threadId: string, home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')): Promise<(ContextSize & { model?: string; spent?: number }) | undefined> {
  if (!/^[\w-]+$/.test(threadId)) return undefined;
  const file = rollouts.get(threadId) ?? await findRollout(path.join(home, 'sessions'), threadId);
  if (!file) return undefined;
  rollouts.set(threadId, file);
  const handle = await open(file, 'r');
  let text: string;
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally { await handle.close(); }
  let context: ContextSize | undefined, model: string | undefined, spent: number | undefined;
  for (const line of text.split('\n').reverse()) {
    if (context && model) break;
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    if (!context && payload?.type === 'token_count' && payload.info?.last_token_usage) {
      context = { tokens: payload.info.last_token_usage.total_tokens ?? 0, ...(Number.isInteger(payload.info.model_context_window) ? { window: payload.info.model_context_window } : {}) };
      const total = payload.info.total_token_usage;
      if (total) spent = total.output_tokens ?? 0;
    }
    if (!model && entry?.type === 'turn_context' && typeof payload?.model === 'string') model = payload.model;
  }
  return context ? { ...context, ...(model ? { model } : {}), ...(spent === undefined ? {} : { spent }) } : undefined;
}
/**
 * Claude's stream reports each request's usage as the request starts, so its
 * output count there is a placeholder of a few tokens. The session transcript
 * records each request's final usage: the whole lines from byte `from` on are
 * read, and each main-thread reply's output tokens returned by message id.
 */
const transcripts = new Map<string, string>();
const TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export async function claudeReplies(sessionId: string, cwd: string, from: number, home = claudeHome()): Promise<{ next: number; replies: Map<string, number> } | undefined> {
  const file = await claudeTranscript(sessionId, cwd, home);
  if (!file) return undefined;
  const handle = await open(file, 'r');
  let buffer: Buffer;
  try {
    const { size } = await handle.stat();
    if (size <= from) return { next: from, replies: new Map() };
    buffer = Buffer.alloc(Math.min(size - from, TRANSCRIPT_BYTES));
    await handle.read(buffer, 0, buffer.length, from);
  } finally { await handle.close(); }
  // A line still being written is read next time; one longer than a whole read is passed over.
  const end = buffer.lastIndexOf(10) + 1 || (buffer.length === TRANSCRIPT_BYTES ? buffer.length : 0);
  const replies = new Map<string, number>();
  for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const output = entry?.message?.usage?.output_tokens;
    if (entry?.type === 'assistant' && !entry.isSidechain && typeof entry.message.id === 'string' && Number.isFinite(output)) replies.set(entry.message.id, output);
  }
  return { next: from + end, replies };
}
/** Where a resumed session's transcript ends now, so its new turn counts from there. */
export async function claudeTranscriptSize(sessionId: string, cwd: string, home = claudeHome()) {
  const file = await claudeTranscript(sessionId, cwd, home);
  return file ? (await stat(file).catch(() => undefined))?.size ?? 0 : 0;
}
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
/** Claude names a project's folder after its path, each other character a dash; a long path's differs, so the rest are looked through. */
async function claudeTranscript(sessionId: string, cwd: string, home: string) {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const known = transcripts.get(sessionId);
  if (known) return known;
  const projects = path.join(home, 'projects'), name = `${sessionId}.jsonl`;
  for (const dir of [cwd.replace(/[^a-zA-Z0-9]/g, '-'), ...await readdir(projects).catch(() => [] as string[])]) {
    const file = path.join(projects, dir, name);
    if (await stat(file).then(() => true, () => false)) { transcripts.set(sessionId, file); return file; }
  }
  return undefined;
}
/** Rollouts live under sessions/YYYY/MM/DD; look through the newest week of days. */
async function findRollout(root: string, threadId: string) {
  const newest = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(name => /^\d+$/.test(name)).sort().reverse();
  let days = 0;
  for (const year of await newest(root)) for (const month of await newest(path.join(root, year))) for (const day of await newest(path.join(root, year, month))) {
    if (days++ >= 7) return undefined;
    const dir = path.join(root, year, month, day);
    const match = (await readdir(dir).catch(() => [] as string[])).find(name => name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`));
    if (match) return path.join(dir, match);
  }
  return undefined;
}
