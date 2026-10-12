import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../src/hub/store.js';
import { collectRuns, initialShellAllow, suggestedTestCommand } from '../../src/hub/maintenance.js';
import { defaults } from '../../src/hub/config.js';
import { ulid } from 'ulid';
test('retention keeps summaries and active runs, and never traverses to worktrees', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-retention-'));
  try {
    const store = new Store(home); await store.initialize();
    const old = `run_${ulid()}`, active = `run_${ulid()}`, recent = `run_${ulid()}`;
    for (const [id, status, age] of [[old, 'completed', 40], [active, 'running', 40], [recent, 'completed', 1]] as const) {
      await store.write(path.join(store.runDir(id), 'run.json'), { status, endedAt: new Date(Date.now() - age * 86400000).toISOString() });
      await store.write(path.join(store.runDir(id), 'result.json'), {});
      await store.write(path.join(store.runDir(id), 'agents', 'fixture', 'transcript.json'), {});
    }
    assert.deepEqual(await collectRuns(store, defaults()), [old]);
    assert.deepEqual((await readdir(store.runDir(old))).sort(), ['result.json', 'run.json']);
    assert.ok((await readdir(store.runDir(active))).includes('agents'));
    assert.ok((await readdir(store.runDir(recent))).includes('agents'));
    const config = defaults(); config.store.keepSummaries = false;
    await collectRuns(store, config);
    assert.ok(!(await store.runs()).includes(old));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('init allows Claude shell commands only when the user, asked on a terminal, chooses them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-init-shell-'));
  const answers = (...lines: string[]) => { const asked: string[] = []; return { asked, ask: async (question: string) => { asked.push(question); return lines.shift() ?? ''; } }; };
  try {
    // --yes or no terminal: nothing is asked and nothing allowed.
    assert.deepEqual(await initialShellAllow(defaults(), dir, undefined), []);
    // A folder with no toolchain: no suggestion; a bare command becomes a Bash rule, rules split outside parentheses.
    assert.equal(await suggestedTestCommand(dir), undefined);
    const typed = answers('npm test, Bash(git log --format=%h,%s)');
    assert.deepEqual(await initialShellAllow(defaults(), dir, typed.ask), ['Bash(npm test)', 'Bash(git log --format=%h,%s)']);
    assert.match(typed.asked[0]!, /as trusted as you are/);
    // An npm project: y takes the suggestion, Enter or none allows nothing.
    await writeFile(path.join(dir, 'package.json'), '{}');
    assert.equal(await suggestedTestCommand(dir), 'Bash(npm test)');
    const accepted = answers('y');
    assert.deepEqual(await initialShellAllow(defaults(), dir, accepted.ask), ['Bash(npm test)']);
    assert.match(accepted.asked[0]!, /Allow Bash\(npm test\)\?/);
    assert.deepEqual(await initialShellAllow(defaults(), dir, answers('').ask), []);
    assert.deepEqual(await initialShellAllow(defaults(), dir, answers('none').ask), []);
    // A rule the hub would refuse is asked again, saying why; three refusals allow nothing.
    const unsafe = answers('Bash(node:*)', 'Bash(npm test:*)');
    assert.deepEqual(await initialShellAllow(defaults(), dir, unsafe.ask), ['Bash(npm test:*)']);
    assert.match(unsafe.asked[1]!, /unsafe editShellAllow requires allowFullAccess: Bash\(node:\*\)/);
    assert.deepEqual(await initialShellAllow(defaults(), dir, answers('Bash(*)', 'Bash(*)', 'Bash(*)').ask), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
