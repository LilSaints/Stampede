import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * An agent type's `tools` line keeps every other tool from a Claude worker,
 * the structured-output tool a schema needs and Stampede's own tools among
 * them. Such a worker runs a copy of the type, under a name of its own,
 * with the tools it needs added; a type that lists no tools keeps them all.
 */
type Fields = Record<string, string | string[]>;
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
const list = (value: string | string[] | undefined) => Array.isArray(value) ? value : value?.trim().startsWith('[') ? value.trim().slice(1, -1).split(',').map(unquote).filter(Boolean) : value?.split(',').map(unquote).filter(Boolean);
/** An agent file's frontmatter (scalars, comma lists, inline and block lists) and its body, the prompt. */
export function parseAgentFile(text: string): { fields: Fields; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!match) return undefined;
  const fields: Fields = {};
  let block: string[] | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && block) { block.push(unquote(item[1]!)); continue; }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (pair[2] === '') { block = []; fields[pair[1]!] = block; } else { block = undefined; fields[pair[1]!] = unquote(pair[2]!); }
  }
  return { fields, body: match[2]!.trim() };
}
/** The agent type's file as Claude finds it: in `.claude/agents` of the folder or one above it, then the user's. */
export async function findAgentFile(type: string, cwd: string, home = os.homedir()) {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) { dirs.push(path.join(dir, '.claude', 'agents')); if (path.dirname(dir) === dir) break; }
  dirs.push(path.join(home, '.claude', 'agents'));
  for (const dir of [...new Set(dirs)]) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files.filter(f => f.endsWith('.md')).sort((a, b) => Number(b === `${type}.md`) - Number(a === `${type}.md`))) {
      const parsed = parseAgentFile(await readFile(path.join(dir, file), 'utf8').catch(() => ''));
      if (parsed && (parsed.fields.name ?? file.slice(0, -3)) === type) return parsed;
    }
  }
  return undefined;
}
/** The type's definition with `needed` tools added, for `--agents`; undefined when it lists no tools or already has them. */
export function withTools(found: { fields: Fields; body: string }, type: string, needed: string[]) {
  const { fields, body } = found, tools = list(fields.tools);
  if (!tools || tools.includes('*')) return undefined;
  const missing = needed.filter(tool => !tools.includes(tool));
  if (!missing.length) return undefined;
  const definition: Record<string, unknown> = { description: typeof fields.description === 'string' && fields.description ? fields.description : type, prompt: body, tools: [...tools, ...missing] };
  for (const key of ['model', 'effort', 'permissionMode', 'memory'] as const) if (typeof fields[key] === 'string') definition[key] = fields[key];
  for (const key of ['disallowedTools', 'skills'] as const) if (fields[key] !== undefined) definition[key] = list(fields[key]);
  if (typeof fields.maxTurns === 'string' && /^\d+$/.test(fields.maxTurns)) definition.maxTurns = Number(fields.maxTurns);
  if (typeof definition.effort === 'string' && /^\d+$/.test(definition.effort)) definition.effort = Number(definition.effort);
  return definition;
}
