import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { claudeContext, claudeReplies, claudeTranscriptSize, claudeWindow, codexContext } from '../../src/backends/context.js';

test('Claude context is the latest request, not the summed result', () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 10942, cache_read_input_tokens: 35769, output_tokens: 158 };
  assert.deepEqual(claudeContext({ type: 'assistant', message: { usage } }), { tokens: 46871 });
  assert.equal(claudeContext({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { usage } }), undefined);
  assert.equal(claudeContext({ type: 'result', usage }), undefined);
  assert.equal(claudeWindow({ type: 'result', modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } } }), 1000000);
});

test('Codex context comes from the rollout tail of the right thread', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-codex-'));
  try {
    const thread = '01a11c1e-d5aa-78d0-b645-d384c8c7f800', day = path.join(home, 'sessions', '2026', '10', '08');
    await mkdir(day, { recursive: true });
    const lines = [
      { type: 'turn_context', payload: { model: 'gpt-fixture' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 16250 }, last_token_usage: { total_tokens: 16250 }, model_context_window: 258400 } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 33039, output_tokens: 900, reasoning_output_tokens: 300 }, last_token_usage: { total_tokens: 16789 }, model_context_window: 258400 } } }
    ];
    await writeFile(path.join(day, `rollout-2026-10-08T16-25-47-${thread}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    await writeFile(path.join(day, 'rollout-2026-10-08T16-25-47-other.jsonl'), JSON.stringify(lines[1]) + '\n');
    assert.deepEqual(await codexContext(thread, home), { tokens: 16789, window: 258400, model: 'gpt-fixture', spent: 900 });
    assert.equal(await codexContext('missing-thread', home), undefined);
    assert.equal(await codexContext('../escape', home), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('Claude live output comes from the transcript, read on from where the last read stopped', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-claude-'));
  try {
    const session = 'c33c6cb1-538c-4f45-b82d-5818cdd7527e', cwd = path.join('C:', 'Dev', 'Knive', '.stampede', 'worktrees', 'b2a-history');
    const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')), file = path.join(dir, `${session}.jsonl`);
    await mkdir(dir, { recursive: true });
    const reply = (id: string, output: number, extra = {}) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: output } }, ...extra }) + '\n';
    // A reply written twice keeps its last count; a subagent's sidechain is not this agent's output; a half-written line waits.
    await writeFile(file, reply('a', 217) + reply('b', 618) + reply('b', 618) + reply('s', 900, { isSidechain: true }) + JSON.stringify({ type: 'user' }) + '\n' + '{"type":"assis');
    const first = await claudeReplies(session, cwd, 0, home);
    assert.deepEqual([...first!.replies], [['a', 217], ['b', 618]]);
    await appendFile(file, 'tant","message":{"id":"c","usage":{"output_tokens":806}}}\n');
    const next = await claudeReplies(session, cwd, first!.next, home);
    assert.deepEqual([...next!.replies], [['c', 806]]);
    assert.equal(await claudeTranscriptSize(session, cwd, home), next!.next);
    assert.deepEqual([...(await claudeReplies(session, cwd, next!.next, home))!.replies], []);
    // A folder named otherwise (a long path) is found by looking through the projects.
    const other = 'd44d7dc2-0000-4000-8000-000000000000';
    await mkdir(path.join(home, 'projects', 'shortened-name'), { recursive: true });
    await writeFile(path.join(home, 'projects', 'shortened-name', `${other}.jsonl`), reply('d', 5));
    assert.deepEqual([...(await claudeReplies(other, cwd, 0, home))!.replies], [['d', 5]]);
    assert.equal(await claudeReplies('missing-session', cwd, 0, home), undefined);
    assert.equal(await claudeReplies('../escape', cwd, 0, home), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});
