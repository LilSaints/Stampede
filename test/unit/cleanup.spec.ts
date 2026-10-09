import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanup, scratchFolders, within } from '../../src/hub/cleanup.js';

const exists = (file: string) => access(file).then(() => true, () => false);
test('a worker deletes inside its worktree and scratch folders only, never through a link', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-cleanup-'));
  const worktree = path.join(root, 'worktree'), scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside');
  for (const dir of [path.join(worktree, 'fixtures'), scratch, outside]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(worktree, '.git'), 'gitdir: elsewhere'); await writeFile(path.join(worktree, 'fixtures', 'a.txt'), 'x');
  await writeFile(path.join(outside, 'precious.txt'), 'keep');
  // A junction (a symbolic link elsewhere) inside the worktree that points outside it.
  await symlink(outside, path.join(worktree, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const roots = [{ path: worktree, allowRoot: false }, { path: scratch, allowRoot: true }];
  const result = await cleanup(['fixtures', path.join('escape', 'precious.txt'), 'escape', '.git', '.', outside, scratch, 'missing'], worktree, roots);
  assert.deepEqual(result.removed, ['fixtures', 'escape', scratch]);
  assert.deepEqual(result.refused.map(r => r.path), [path.join('escape', 'precious.txt'), '.git', '.', outside, 'missing']);
  assert.equal(await exists(path.join(outside, 'precious.txt')), true, 'deleting the link leaves what it points to');
  assert.equal(await exists(path.join(worktree, '.git')), true);
  assert.equal(await exists(scratch), false);
  assert.match((await cleanup(['x'], root, [])).refused[0]!.reason, /no worktree or scratch folder/);
});
test('scratch folders cannot be a root or hold a folder that must survive', () => {
  const home = os.homedir();
  assert.equal(within(path.join(home, 'a'), home), 'inside'); assert.equal(within(home, home), 'root'); assert.equal(within(path.dirname(home), home), 'outside');
  assert.deepEqual(scratchFolders(['tmp/fixtures'], path.join(home, 'repo', 'wt'), [home]), [path.join(home, 'repo', 'wt', 'tmp', 'fixtures')]);
  assert.throws(() => scratchFolders([path.parse(home).root], home, []), /filesystem root/);
  assert.throws(() => scratchFolders(['..'], path.join(home, 'repo'), [path.join(home, 'repo')]), /would delete/);
  assert.throws(() => scratchFolders([path.dirname(home)], home, [home]), /would delete/);
});
