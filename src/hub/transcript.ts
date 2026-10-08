import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Agent } from './model.js';

/**
 * One line of an agent's transcript as the pane draws it: the prompt a turn
 * began with, the agent's text, a tool it used (its name and what it acted
 * on), an error, or the start of a later turn.
 */
export interface TranscriptEntry { kind: 'prompt' | 'text' | 'tool' | 'error' | 'turn'; text: string; tool?: string }

const TEXT = 2000, DETAIL = 160, BUDGET = 40000;
const clip = (value: unknown, max: number) => { const text = String(value ?? '').replace(/\r/g, ''); return text.length > max ? text.slice(0, max) + '…' : text; };
/** What a Claude tool acted on: its file, command, pattern, address or query, else its first string input. */
function subject(input: any) {
  const value = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.to ?? Object.values(input ?? {}).find(item => typeof item === 'string');
  return clip(String(value ?? '').replace(/\s+/g, ' '), DETAIL);
}
const toolName = (name: string) => name.startsWith('mcp__stampede__') ? `Stampede ${name.slice(15)}` : name.startsWith('mcp__') ? name.slice(5).replace('__', ' ') : name;
/** A backend's stream events as transcript entries: Claude's stream-json, or Codex's exec --json. */
export function streamEntries(backend: Agent['backend'], event: any): TranscriptEntry[] {
  if (backend === 'claude') {
    if (event?.parent_tool_use_id) return [];
    if (event?.type === 'assistant') return (event.message?.content ?? []).flatMap((block: any): TranscriptEntry[] =>
      block?.type === 'text' && block.text?.trim() ? [{ kind: 'text', text: clip(block.text, TEXT) }]
        : block?.type === 'tool_use' ? [{ kind: 'tool', tool: toolName(String(block.name)), text: subject(block.input) }] : []);
    if (event?.type === 'user' && Array.isArray(event.message?.content)) return event.message.content.filter((block: any) => block?.type === 'tool_result' && block.is_error)
      .map((block: any): TranscriptEntry => ({ kind: 'error', text: clip(Array.isArray(block.content) ? block.content.map((part: any) => part?.text ?? '').join(' ') : block.content, 600) }));
    if (event?.type === 'result' && event.is_error) return [{ kind: 'error', text: clip(event.result ?? event.subtype, 600) }];
    return [];
  }
  if (event?.type === 'turn.failed') return [{ kind: 'error', text: clip(event.error?.message ?? 'turn failed', 600) }];
  if (event?.type !== 'item.completed') return [];
  const item = event.item ?? {};
  if (item.type === 'agent_message') return item.text?.trim() ? [{ kind: 'text', text: clip(item.text, TEXT) }] : [];
  if (item.type === 'command_execution') return [{ kind: 'tool', tool: 'Shell', text: clip(String(item.command ?? '').replace(/\s+/g, ' '), DETAIL) }, ...(item.exit_code ? [{ kind: 'error' as const, text: `exit ${item.exit_code}: ${clip(item.aggregated_output, 400)}` }] : [])];
  if (item.type === 'file_change') return [{ kind: 'tool', tool: 'Edit', text: clip((item.changes ?? []).map((change: any) => change?.path).filter(Boolean).join(', '), DETAIL) }];
  if (item.type === 'mcp_tool_call') return [{ kind: 'tool', tool: toolName(`mcp__${item.server}__${item.tool}`), text: subject(item.arguments) }];
  if (item.type === 'web_search') return [{ kind: 'tool', tool: 'Web search', text: clip(item.query, DETAIL) }];
  return [];
}

/** A turn's stream, read on from where the last read stopped: its whole lines only, so a growing file is parsed once. */
const streams = new Map<string, { offset: number; entries: TranscriptEntry[] }>();
async function turnStream(file: string, backend: Agent['backend']) {
  const known = streams.get(file) ?? { offset: 0, entries: [] };
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return known.entries;
  try {
    const { size } = await handle.stat();
    if (size > known.offset) {
      const buffer = Buffer.alloc(size - known.offset);
      await handle.read(buffer, 0, buffer.length, known.offset);
      const end = buffer.lastIndexOf(10) + 1;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        known.entries.push(...streamEntries(backend, event));
      }
      known.offset += end;
    }
  } finally { await handle.close(); }
  streams.set(file, known);
  return known.entries;
}

/**
 * An agent's transcript across its turns: each turn's prompt (saved beside
 * its stream), then what it wrote and did. The newest entries are kept, up to
 * 40,000 characters, so the pane stays within its payload.
 */
export async function agentTranscript(agent: Agent, agentDir: string) {
  const entries: TranscriptEntry[] = [];
  for (const turn of agent.turns) {
    if (agent.turns.length > 1) entries.push({ kind: 'turn', text: `Turn ${turn.n} · ${turn.kind}` });
    const prompt = await readFile(path.join(agentDir, `turn-${turn.n}.prompt.txt`), 'utf8').catch(() => undefined);
    if (prompt?.trim()) entries.push({ kind: 'prompt', text: clip(prompt.trim(), TEXT) });
    if (turn.stdoutPath) entries.push(...await turnStream(turn.stdoutPath, agent.backend));
  }
  let used = 0, first = entries.length;
  while (first > 0 && used + entries[first - 1]!.text.length <= BUDGET) used += entries[--first]!.text.length;
  return { entries: entries.slice(first), omitted: first };
}
