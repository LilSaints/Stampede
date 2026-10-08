import { open, readdir } from 'node:fs/promises';
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
