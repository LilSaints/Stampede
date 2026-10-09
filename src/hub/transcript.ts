import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Agent } from './model.js';

/**
 * One line of an agent's transcript as the pane draws it: the prompt a turn
 * began with, the agent's text, a tool it used (its name and what it acted
 * on), an error, or the start of a later turn.
 */
export interface TranscriptEntry {
  kind: 'prompt' | 'text' | 'tool' | 'error' | 'turn'; text: string; tool?: string;
  /** A tool call's own detail, drawn when the person opens it as the chat draws its calls: the command run, what it printed, an edit as unified-diff hunks. */
  command?: string; output?: string; diff?: string;
  /** A Claude call's tool_use id, by which its result finds it; not sent to the pane. */
  id?: string;
}
/** A Claude tool result, joined to its call by id rather than drawn on its own. */
type StreamEntry = TranscriptEntry | { kind: 'result'; id: string; text: string };

const TEXT = 2000, DETAIL = 240, COMMAND = 2000, OUTPUT = 1500, DIFF = 4000, BUDGET = 40000;
const clip = (value: unknown, max: number) => { const text = String(value ?? '').replace(/\r/g, ''); return text.length > max ? text.slice(0, max) + '…' : text; };
/** A diff cut mid-hunk does not parse, so a long one keeps its whole first hunks only. */
const clipDiff = (diff: string) => { if (diff.length <= DIFF) return diff; const hunks = diff.split(/(?=^@@ )/m); let kept = ''; for (const hunk of hunks) { if (kept.length + hunk.length > DIFF) break; kept += hunk; } return kept || undefined; };
/**
 * One edit as a unified-diff hunk: the lines both sides share at the start and
 * end are context (three at most), the rest removed then added. The tool gives
 * no line numbers, so the hunk counts from 1.
 */
export function editHunk(before: string, after: string) {
  const a = before.replace(/\r/g, '').split('\n'), b = after.replace(/\r/g, '').split('\n');
  let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lead = a.slice(Math.max(0, head - 3), head), trail = a.slice(a.length - tail, a.length - tail + 3);
  const removed = a.slice(head, a.length - tail), added = b.slice(head, b.length - tail);
  const lines = [...lead.map(l => ` ${l}`), ...removed.map(l => `-${l}`), ...added.map(l => `+${l}`), ...trail.map(l => ` ${l}`)];
  const start = Math.max(0, head - 3) + 1;
  return `@@ -${start},${lead.length + removed.length + trail.length} +${start},${lead.length + added.length + trail.length} @@\n${lines.join('\n')}\n`;
}
/** A whole new file as one hunk of added lines. */
export function fileHunk(content: string) {
  const lines = content.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;
}
/** A Claude call's detail: the command of a shell, the hunks of an edit or a new file. */
function claudeDetail(name: string, input: any): Pick<TranscriptEntry, 'command' | 'diff'> {
  if (/^(Bash|PowerShell)$/.test(name) && typeof input?.command === 'string') return { command: clip(input.command, COMMAND) };
  const diff = name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string' ? editHunk(input.old_string, input.new_string)
    : name === 'MultiEdit' && Array.isArray(input?.edits) ? input.edits.filter((e: any) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string').map((e: any) => editHunk(e.old_string, e.new_string)).join('')
    : name === 'Write' && typeof input?.content === 'string' ? fileHunk(input.content)
    : undefined;
  const clipped = diff ? clipDiff(diff) : undefined;
  return clipped ? { diff: clipped } : {};
}
/** What a Claude tool acted on: its file, command, pattern, address or query, else its first string input. */
function subject(input: any) {
  const value = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.to ?? Object.values(input ?? {}).find(item => typeof item === 'string');
  return clip(String(value ?? '').replace(/\s+/g, ' '), DETAIL);
}
/**
 * A command as it was written, without the shell Codex runs it in
 * (`"C:\\…\\pwsh.exe" -Command "…"`, `/bin/bash -lc '…'`). Codex escapes `\` and
 * `"` inside a double-quoted argument, so those are unescaped there.
 */
export function unwrapShell(command: string) {
  const match = /^\s*("[^"]+"|\S+)\s+((?:-(?:NoProfile|NoLogo|NonInteractive|ExecutionPolicy\s+\S+)\s+)*)(?:-Command|-c|-lc|\/c)\s+([\s\S]+)$/i.exec(command);
  const shell = match?.[1]!.replace(/"/g, '').split(/[\\/]+/).pop() ?? '';
  if (!match || !/^(pwsh|powershell|bash|zsh|sh|cmd)(\.exe)?$/i.test(shell)) return command;
  const inner = match[3]!.trim();
  if (inner.length > 1 && inner.startsWith('"') && inner.endsWith('"')) return inner.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (inner.length > 1 && inner.startsWith("'") && inner.endsWith("'")) return inner.slice(1, -1);
  return inner;
}
const toolName = (name: string) => name.startsWith('mcp__stampede__') ? `Stampede ${name.slice(15)}` : name.startsWith('mcp__') ? name.slice(5).replace('__', ' ') : name;
/** A backend's stream events as transcript entries: Claude's stream-json, or Codex's exec --json. */
export function streamEntries(backend: Agent['backend'], event: any): StreamEntry[] {
  if (backend === 'claude') {
    if (event?.parent_tool_use_id) return [];
    if (event?.type === 'assistant') return (event.message?.content ?? []).flatMap((block: any): StreamEntry[] =>
      block?.type === 'text' && block.text?.trim() ? [{ kind: 'text', text: clip(block.text, TEXT) }]
        : block?.type === 'tool_use' ? [{ kind: 'tool', tool: toolName(String(block.name)), text: subject(block.input), ...claudeDetail(String(block.name), block.input), ...(typeof block.id === 'string' ? { id: block.id } : {}) } as StreamEntry] : []);
    // A failed call's result is an error of its own; a shell's output joins its call.
    if (event?.type === 'user' && Array.isArray(event.message?.content)) return event.message.content.filter((block: any) => block?.type === 'tool_result')
      .map((block: any): StreamEntry => {
        const text = Array.isArray(block.content) ? block.content.map((part: any) => part?.text ?? '').join(block.is_error ? ' ' : '\n') : String(block.content ?? '');
        return block.is_error ? { kind: 'error', text: clip(text, 600) } : { kind: 'result', id: String(block.tool_use_id), text: clip(text.trimEnd(), OUTPUT) };
      });
    if (event?.type === 'result' && event.is_error) return [{ kind: 'error', text: clip(event.result ?? event.subtype, 600) }];
    return [];
  }
  if (event?.type === 'turn.failed') return [{ kind: 'error', text: clip(event.error?.message ?? 'turn failed', 600) }];
  if (event?.type !== 'item.completed') return [];
  const item = event.item ?? {};
  if (item.type === 'agent_message') return item.text?.trim() ? [{ kind: 'text', text: clip(item.text, TEXT) }] : [];
  if (item.type === 'command_execution') {
    const command = unwrapShell(String(item.command ?? '')), output = String(item.aggregated_output ?? '').trimEnd();
    return [{ kind: 'tool', tool: 'Shell', text: clip(command.replace(/\s+/g, ' '), DETAIL), command: clip(command, COMMAND), ...(output && !item.exit_code ? { output: clip(output, OUTPUT) } : {}) }, ...(item.exit_code ? [{ kind: 'error' as const, text: `exit ${item.exit_code}: ${clip(item.aggregated_output, 400)}` }] : [])];
  }
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
        for (const entry of streamEntries(backend, event)) {
          if (entry.kind !== 'result') { known.entries.push(entry); continue; }
          // Only a shell's output is drawn, as the chat draws a command's; what a read or search returned is not.
          const call = known.entries.findLast(e => e.id === entry.id);
          if (call?.command !== undefined && entry.text) call.output = entry.text;
        }
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
    if (turn.stdoutPath) entries.push(...(await turnStream(turn.stdoutPath, agent.backend)).map(({ id: _id, ...entry }) => entry));
  }
  const size = (e: TranscriptEntry) => e.text.length + (e.command?.length ?? 0) + (e.output?.length ?? 0) + (e.diff?.length ?? 0);
  let used = 0, first = entries.length;
  while (first > 0 && used + size(entries[first - 1]!) <= BUDGET) used += size(entries[--first]!);
  return { entries: entries.slice(first), omitted: first };
}
