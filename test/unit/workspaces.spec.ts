import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { git, createWorkspace, finishWorkspace, fingerprint, invalidateFingerprint, type FingerprintMemo } from '../../src/hub/workspaces.js';
import { defaults, lowerConfig, validateConfig } from '../../src/hub/config.js';
test('project configuration cannot elevate access, binaries or reserve capacity', () => {
  const config = defaults();
  for (const input of [{ allowFullAccess: true }, { codex: { entry: 'evil' } }, { limits: { messagesPerRun: 3000 } }, { scheduler: { nonCommsReserve: 0 } }]) assert.throws(() => lowerConfig(config, input));
  assert.equal(lowerConfig(config, { limits: { messagesPerRun: 10 } }).limits.messagesPerRun, 10);
  assert.throws(() => validateConfig({ ...config, claude: { ...config.claude, editShellAllow: ['Bash(node:*)'] } }), /allowFullAccess/);
});
test('fingerprint TTL is scoped to a run and writer invalidation reaches other active runs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-fingerprint-'));
  const limits = { maxFingerprintFiles: 10, maxFingerprintBytes: 1000, fingerprintTtlMs: 2000 };
  const first: FingerprintMemo = new Map(), second: FingerprintMemo = new Map();
  try {
    await writeFile(path.join(dir, 'input.txt'), 'original');
    const original = await fingerprint(dir, 'shared', [], limits, first);
    await fingerprint(dir, 'shared', [], limits, second);
    await writeFile(path.join(dir, 'input.txt'), 'writer change');
    assert.equal((await fingerprint(dir, 'shared', [], limits, first)).workspace, original.workspace);
    assert.notEqual((await fingerprint(dir, 'shared', [], limits, new Map())).workspace, original.workspace);
    await invalidateFingerprint(dir);
    const changed = await fingerprint(dir, 'shared', [], limits, first);
    assert.notEqual(changed.workspace, original.workspace);
    assert.equal((await fingerprint(dir, 'shared', [], limits, second)).workspace, changed.workspace);
    await writeFile(path.join(dir, 'input.txt'), 'external change');
    await new Promise(resolve => setTimeout(resolve, 2050));
    assert.notEqual((await fingerprint(dir, 'shared', [], limits, first)).workspace, changed.workspace);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('eight worktrees serialize git mutations and clean up unchanged branches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-worktree-'));
  try {
    await git(dir, ['init']); await git(dir, ['config', 'user.name', 'Stampede fixture']); await git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(dir, 'input.txt'), 'base'); await git(dir, ['add', '.']); await git(dir, ['commit', '-m', 'fixture']);
    const worktrees = await Promise.all(Array.from({ length: 8 }, (_, i) => createWorkspace(dir, 'run_01TEST00000000000000000000', `worker-${i}`)));
    assert.equal(new Set(worktrees.map(w => w.path)).size, 8);
    await Promise.all(worktrees.map(w => finishWorkspace(w, 'fixture', false)));
    assert.equal((await git(dir, ['worktree', 'list', '--porcelain'])).split('worktree ').length - 1, 1);
    const limits = { maxFingerprintFiles: 100, maxFingerprintBytes: 100000 };
    const before = await fingerprint(dir, 'shared', [], limits);
    await writeFile(path.join(dir, 'input.txt'), 'changed');
    const after = await fingerprint(dir, 'shared', [], limits);
    assert.notEqual(before.workspace, after.workspace);
    const isolated = await fingerprint(dir, 'worktree', [], limits);
    assert.equal(isolated.workspace, await git(dir, ['rev-parse', 'HEAD']));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
