import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../src/hub/store.js';
import { collectRuns } from '../../src/hub/maintenance.js';
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
