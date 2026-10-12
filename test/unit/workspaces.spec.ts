import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { git, createWorkspace, finishWorkspace, fingerprint, invalidateFingerprint, type FingerprintMemo } from '../../src/hub/workspaces.js';
import { defaults, lowerConfig, validateConfig } from '../../src/hub/config.js';
import { launchTurn } from '../../src/backends/procs.js';
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
test('eight worktree workers snapshot edits without git lock errors and unchanged branches clean up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede worktree space '));
  try {
    await git(dir, ['init']); await git(dir, ['config', 'user.name', 'Stampede fixture']); await git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(dir, 'input.txt'), 'base'); await git(dir, ['add', '.']); await git(dir, ['commit', '-m', 'fixture']);
    const worktrees = await Promise.all(Array.from({ length: 8 }, (_, i) => createWorkspace(dir, 'run_01TEST00000000000000000000', `worker-${i}`)));
    assert.equal(new Set(worktrees.map(w => w.path)).size, 8);
    const outcomes = await Promise.all(worktrees.map((w, i) => launchTurn({ backend: i % 2 ? 'claude' : 'codex', binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), cwd: w.path, access: 'edit', model: 'fixture', effort: 'low', mcpPath: '', settingsPath: '', contract: 'fixture', comms: false, hubUrl: '', cliEntry: '', windowsSandbox: 'elevated', timeoutMs: 10000, stdoutPath: path.join(dir, `stdout-${i}.jsonl`), stderrPath: path.join(dir, `stderr-${i}.txt`) }, 'fixture:edit').done));
    assert.ok(outcomes.every(outcome => outcome.ok), JSON.stringify(outcomes));
    await Promise.all(worktrees.map(w => finishWorkspace(w, 'fixture', { snapshot: true })));
    for (const w of worktrees) {
      assert.equal(w.kept, true); assert.notEqual(w.commit, w.baseCommit);
      assert.equal(await readFile(path.join(w.path, 'fixture-output.txt'), 'utf8'), 'verified fixture edit\n');
      assert.equal(await git(w.path, ['status', '--porcelain']), '');
    }
    // These are fixture-owned snapshots in the newly created temporary repo.
    for (const w of worktrees) { await git(dir, ['worktree', 'remove', w.path]); await git(dir, ['branch', '-D', w.branch!]); }
    const unchanged = await createWorkspace(dir, 'run_01TEST00000000000000000000', 'unchanged');
    await finishWorkspace(unchanged, 'unchanged', { snapshot: true }); assert.equal(unchanged.kept, false);
    assert.equal((await git(dir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 1);
    const limits = { maxFingerprintFiles: 100, maxFingerprintBytes: 100000 };
    const before = await fingerprint(dir, 'shared', [], limits);
    await writeFile(path.join(dir, 'input.txt'), 'changed');
    const after = await fingerprint(dir, 'shared', [], limits);
    assert.notEqual(before.workspace, after.workspace);
    const isolated = await fingerprint(dir, 'worktree', [], limits);
    assert.equal(isolated.workspace, await git(dir, ['rev-parse', 'HEAD']));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('protected files are restored as at the base on the branch, and a discarded worktree goes whatever it holds', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-protect-'));
  try {
    await git(dir, ['init']); await git(dir, ['config', 'user.name', 'Stampede fixture']); await git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    await mkdir(path.join(dir, 'docs'));
    for (const [file, text] of [['HANDOFF.md', 'handoff'], ['docs/guide.md', 'guide'], ['docs/old.md', 'old'], ['README.md', 'readme']]) await writeFile(path.join(dir, file), text);
    await git(dir, ['add', '.']); await git(dir, ['commit', '-m', 'base']);
    const w = await createWorkspace(dir, 'run_01TEST00000000000000000000', 'coder');
    const write = (file: string, text: string) => writeFile(path.join(w.path, file), text);
    // Committed: HANDOFF.md changed, docs/old.md renamed away, docs/added.md new. Uncommitted: docs/guide.md, a new
    // untracked docs/scratch.md, and README.md, which is not protected and stays the agent's work.
    await write('HANDOFF.md', 'agent'); await write('docs/added.md', 'agent'); await git(w.path, ['mv', 'docs/old.md', 'docs/moved.md']);
    await git(w.path, ['add', '-A']); await git(w.path, ['commit', '-m', 'agent work']);
    await write('docs/guide.md', 'agent'); await write('docs/scratch.md', 'agent'); await write('README.md', 'agent');
    const notes: string[] = [];
    await finishWorkspace(w, 'coder', { snapshot: true, protect: ['HANDOFF.md', 'docs/**'], note: async message => { notes.push(message); } });
    assert.deepEqual(w.restored, ['HANDOFF.md', 'docs/added.md', 'docs/guide.md', 'docs/moved.md', 'docs/old.md', 'docs/scratch.md']);
    assert.deepEqual(notes, ['coder: changed protected files HANDOFF.md, docs/added.md, docs/guide.md, docs/moved.md, docs/old.md, docs/scratch.md, restored as at its base']);
    assert.equal(w.kept, true);
    assert.equal(await git(dir, ['diff', '--name-only', `${w.baseCommit}..${w.commit}`]), 'README.md');
    assert.equal(await git(w.path, ['status', '--porcelain']), '');
    await git(dir, ['worktree', 'remove', w.path]); await git(dir, ['branch', '-D', w.branch!]);
    // A read-only agent's worktree, with build output and even a commit, is removed with its branch.
    const r = await createWorkspace(dir, 'run_01TEST00000000000000000000', 'tester');
    await writeFile(path.join(r.path, 'build.log'), 'output'); await writeFile(path.join(r.path, 'README.md'), 'changed');
    await finishWorkspace(r, 'tester', { discard: true, protect: ['README.md'] });
    assert.equal(r.kept, false); assert.equal(r.restored, undefined);
    await assert.rejects(readFile(path.join(r.path, 'build.log')));
    assert.equal(await git(dir, ['branch', '--list', r.branch!]), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
