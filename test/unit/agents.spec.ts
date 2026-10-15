import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findAgentFile, parseAgentFile, withTools } from '../../src/backends/claudeAgents.js';
import { contract } from '../../src/contract/prompts.js';

test('an agent type that lists its tools gets the ones a worker needs added; one that lists none keeps them all', async () => {
  const parsed = parseAgentFile('---\nname: reviewer\ndescription: "Reviews: one commit"\nmodel: opus\neffort: max\ntools: Read, Grep, Bash\nskills:\n  - review\n---\nReview it.\n')!;
  assert.deepEqual(withTools(parsed, 'reviewer', ['StructuredOutput', 'mcp__stampede__cleanup']), { description: 'Reviews: one commit', prompt: 'Review it.', tools: ['Read', 'Grep', 'Bash', 'StructuredOutput', 'mcp__stampede__cleanup'], model: 'opus', effort: 'max', skills: ['review'] });
  assert.equal(withTools(parseAgentFile('---\ntools: [Read, StructuredOutput]\n---\nx')!, 't', ['StructuredOutput']), undefined);
  assert.equal(withTools(parseAgentFile('---\nname: open\ndescription: All tools\n---\nx')!, 'open', ['StructuredOutput']), undefined);
  // Found in .claude/agents of the folder or one above it, by its name rather than its file's.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-agents-'));
  await mkdir(path.join(root, '.claude', 'agents'), { recursive: true }); await mkdir(path.join(root, 'deep', 'er'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'agents', 'file-name.md'), '---\nname: critic\ndescription: d\ntools: Read\n---\nCriticize.');
  assert.equal((await findAgentFile('critic', path.join(root, 'deep', 'er'), root))?.body, 'Criticize.');
  assert.equal(await findAgentFile('nobody', path.join(root, 'deep'), root), undefined);
});
test('every worker learns it may be steered; a comms worker messages the orchestrator only when something is wrong or it needs a decision', () => {
  const base = { name: 'w', backend: 'codex', cwd: '.', access: 'edit' };
  const plain = contract({ ...base, comms: false, cleanup: true, scratch: ['C:/tmp/fixtures'] });
  assert.match(plain, /orchestrator may steer you mid-task/); assert.match(plain, /cleanup tool.*scratch folders: C:\/tmp\/fixtures/); assert.doesNotMatch(plain, /progress reports/);
  // A worker never trims its task to fit an effort estimate or a turn; only a blocker it can show leaves part undone.
  for (const comms of [false, true]) assert.match(contract({ ...base, comms }), /Do the whole task\. Never shrink it or defer part of it because of an effort or time estimate; your turn limit bounds a turn, not the task\. Leave a part undone only for a blocker you can show with evidence/);
  assert.match(contract({ ...base, comms: true }), /Message the orchestrator only when something is wrong or you need a decision or clarification; never send it progress reports/);
  // mark_done ends a member for good, so one told to stay available for follow-ups is not ordered to call it.
  assert.match(contract({ ...base, comms: true, team: true }), /Call mark_done when coordination is complete, unless your task says to stay available for follow-ups \(mark_done ends you for good\)/);
});
