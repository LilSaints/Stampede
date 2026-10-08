import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { codexArgv } from '../../src/backends/codex.js';
import { launchTurn, workerEnv } from '../../src/backends/procs.js';
import type { AgentLaunch } from '../../src/backends/adapter.js';
function launch(dir: string): AgentLaunch { return { backend: 'codex', binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), cwd: dir, access: 'read-only', model: 'fixture', effort: 'low', mcpPath: '', settingsPath: '', contract: 'fixture', comms: false, hubUrl: '', cliEntry: '', windowsSandbox: 'elevated', timeoutMs: 3000, stdoutPath: path.join(dir, 'stdout.jsonl'), stderrPath: path.join(dir, 'stderr.txt') }; }
test('Codex resume preserves all options before the resume tail', () => {
  const a = { ...launch('.'), comms: true, token: 'test-token' };
  const start = codexArgv(a, { platform: 'win32' });
  const resume = codexArgv(a, { platform: 'win32', resumeThreadId: 'thread' });
  assert.deepEqual(resume, [...start.slice(0, -1), 'resume', 'thread', '-']);
  assert.ok(start.indexOf('windows.sandbox="elevated"') > start.indexOf('--ignore-user-config'));
  assert.ok(start.includes('mcp_servers.stampede.default_tools_approval_mode="approve"'));
  assert.ok(start.includes('approval_policy="never"'));
});
test('shell-free backend receives a long UTF-8 prompt over stdin and preserves resume session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-adapter-'));
  try {
    const a = launch(dir); const prompt = 'é'.repeat(50000);
    const first = await launchTurn(a, prompt).done;
    assert.equal(first.ok, true); assert.equal(first.text, prompt);
    assert.equal(first.usage.reasoningTokens, 1);
    const next = await launchTurn(a, 'continued', { resumeSessionId: first.sessionId }).done;
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.text, 'continued');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('worker environment strips desktop identity and hub home; token logs are redacted', async () => {
  const before = process.env.STAMPEDE_HOME; process.env.STAMPEDE_HOME = 'private';
  try { assert.equal(workerEnv().STAMPEDE_HOME, undefined); } finally { if (before === undefined) delete process.env.STAMPEDE_HOME; else process.env.STAMPEDE_HOME = before; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-redact-'));
  try { const a = { ...launch(dir), token: 'fixture-secret' }; await launchTurn(a, 'fixture-secret').done; assert.ok(!(await readFile(a.stdoutPath, 'utf8')).includes('fixture-secret')); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
