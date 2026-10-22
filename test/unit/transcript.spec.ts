import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentTranscript, editHunk, streamEntries, unwrapShell } from '../../src/hub/transcript.js';

test('Claude stream events become transcript entries: text, tools by what they act on, errors; subagents and thinking left out', () => {
  assert.deepEqual(streamEntries('claude', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Reading it.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }, { type: 'tool_use', name: 'mcp__stampede__send_message', input: { to: 'critic', text: 'look' } }] } }), [
    { kind: 'text', text: 'Reading it.' }, { kind: 'tool', tool: 'Read', text: 'src/a.ts' }, { kind: 'tool', tool: 'Stampede send_message', text: 'critic' }]);
  assert.deepEqual(streamEntries('claude', { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'subagent' }] } }), []);
  assert.deepEqual(streamEntries('claude', { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'not found' }] }, { type: 'tool_result', tool_use_id: 'toolu_2', content: 'fine\n' }] } }), [{ kind: 'error', text: 'not found' }, { kind: 'result', id: 'toolu_2', text: 'fine' }]);
});
test('a Claude call keeps what the chat shows of it: a command, an edit as hunks, a new file', () => {
  const [bash, edit, write] = streamEntries('claude', { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
    { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'a.ts', old_string: 'one\ntwo\nthree\nfour\nfive', new_string: 'one\ntwo\n3\nfour\nfive' } },
    { type: 'tool_use', id: 'toolu_3', name: 'Write', input: { file_path: 'b.ts', content: 'x\ny\n' } }] } });
  assert.deepEqual(bash, { kind: 'tool', tool: 'Bash', text: 'npm test', command: 'npm test', id: 'toolu_1' });
  assert.equal((edit as any).diff, '@@ -1,5 +1,5 @@\n one\n two\n-three\n+3\n four\n five\n');
  assert.equal((write as any).diff, '@@ -0,0 +1,2 @@\n+x\n+y\n');
  assert.equal(editHunk('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nd\nE\nf\ng'), '@@ -2,6 +2,6 @@\n b\n c\n d\n-e\n+E\n f\n g\n');
});
test('a transcript joins a shell\'s output to its call and leaves read results out', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-transcript-'));
  try {
    const stdout = path.join(dir, 'turn-1.stdout.jsonl');
    await writeFile(stdout, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'clean' }, { type: 'tool_result', tool_use_id: 't2', content: 'file body' }] } }
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const agent: any = { backend: 'claude', turns: [{ n: 1, kind: 'initial', stdoutPath: stdout }] };
    const { entries } = await agentTranscript(agent, dir);
    assert.deepEqual(entries, [{ kind: 'tool', tool: 'Bash', text: 'git status', command: 'git status', output: 'clean' }, { kind: 'tool', tool: 'Read', text: 'a.ts' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Codex stream items become transcript entries, a failed command with its exit code', () => {
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }), [{ kind: 'text', text: 'Done.' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'npm  test', exit_code: 1, aggregated_output: 'failed' } }), [{ kind: 'tool', tool: 'Shell', text: 'npm test', command: 'npm  test' }, { kind: 'error', text: 'exit 1: failed' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'git status', exit_code: 0, aggregated_output: 'clean\n' } }), [{ kind: 'tool', tool: 'Shell', text: 'git status', command: 'git status', output: 'clean' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } }), [{ kind: 'tool', tool: 'Edit', text: 'a.ts, b.ts' }]);
  assert.deepEqual(streamEntries('codex', { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }), []);
});
test('a Codex command reads as written, without the shell it runs in', () => {
  assert.equal(unwrapShell(String.raw`"C:\\Users\\Fixture\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "rg -n 'a|b' C:\\src; git status --short"`), String.raw`rg -n 'a|b' C:\src; git status --short`);
  assert.equal(unwrapShell(String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Write-Output \"hi\""`), 'Write-Output "hi"');
  assert.equal(unwrapShell(`/bin/bash -lc 'npm test -- --grep "pane"'`), 'npm test -- --grep "pane"');
  assert.equal(unwrapShell('npm  test'), 'npm  test');
  assert.equal(unwrapShell('git -c core.pager=cat log'), 'git -c core.pager=cat log');
});
