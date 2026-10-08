import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { claudeContext, claudeWindow, codexContext } from '../../src/backends/context.js';

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
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 33039 }, last_token_usage: { total_tokens: 16789 }, model_context_window: 258400 } } }
    ];
    await writeFile(path.join(day, `rollout-2026-10-08T16-25-47-${thread}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    await writeFile(path.join(day, 'rollout-2026-10-08T16-25-47-other.jsonl'), JSON.stringify(lines[1]) + '\n');
    assert.deepEqual(await codexContext(thread, home), { tokens: 16789, window: 258400, model: 'gpt-fixture' });
    assert.equal(await codexContext('missing-thread', home), undefined);
    assert.equal(await codexContext('../escape', home), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});
