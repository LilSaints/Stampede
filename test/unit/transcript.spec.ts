import test from 'node:test';
import assert from 'node:assert/strict';
import { streamEntries, unwrapShell } from '../../src/hub/transcript.js';

test('Claude stream events become transcript entries: text, tools by what they act on, errors; subagents and thinking left out', () => {
  assert.deepEqual(streamEntries('claude', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Reading it.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }, { type: 'tool_use', name: 'mcp__stampede__send_message', input: { to: 'critic', text: 'look' } }] } }), [
    { kind: 'text', text: 'Reading it.' }, { kind: 'tool', tool: 'Read', text: 'src/a.ts' }, { kind: 'tool', tool: 'Stampede send_message', text: 'critic' }]);
  assert.deepEqual(streamEntries('claude', { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'subagent' }] } }), []);
  assert.deepEqual(streamEntries('claude', { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'not found' }] }, { type: 'tool_result', content: 'fine' }] } }), [{ kind: 'error', text: 'not found' }]);
});
test('Codex stream items become transcript entries, a failed command with its exit code', () => {
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }), [{ kind: 'text', text: 'Done.' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'npm  test', exit_code: 1, aggregated_output: 'failed' } }), [{ kind: 'tool', tool: 'Shell', text: 'npm test' }, { kind: 'error', text: 'exit 1: failed' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } }), [{ kind: 'tool', tool: 'Edit', text: 'a.ts, b.ts' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }), []);
});
test('a Codex command reads as written, without the shell it runs in', () => {
  assert.equal(unwrapShell(String.raw`"C:\\Users\\Marco\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "rg -n 'a|b' C:\\src; git status --short"`), String.raw`rg -n 'a|b' C:\src; git status --short`);
  assert.equal(unwrapShell(String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Write-Output \"hi\""`), 'Write-Output "hi"');
  assert.equal(unwrapShell(`/bin/bash -lc 'npm test -- --grep "pane"'`), 'npm test -- --grep "pane"');
  assert.equal(unwrapShell('npm  test'), 'npm  test');
  assert.equal(unwrapShell('git -c core.pager=cat log'), 'git -c core.pager=cat log');
});
