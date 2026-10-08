import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaults, loadConfig, lowerConfig } from '../../src/hub/config.js';

test('home configuration cannot raise the Workflow per-run ceiling', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-config-'));
  const write = (scheduler: object) => writeFile(path.join(home, 'config.json'), JSON.stringify({ scheduler }));
  try {
    await write({ maxConcurrent: 100, perRun: 100, claude: { maxConcurrent: 100 }, codex: { maxConcurrent: 100 } });
    const capped = await loadConfig(home);
    assert.equal(capped.scheduler.perRun, Math.max(1, Math.min(16, os.cpus().length - 2)));
    assert.equal(capped.scheduler.maxConcurrent, 100);
    assert.throws(() => lowerConfig(capped, { scheduler: { perRun: 100 } }), /only lower limits/);
    await write({ perRun: 1 });
    assert.equal((await loadConfig(home)).scheduler.perRun, 1);
    // Clamping must not silently leave a reserve that cannot fit the run.
    await write({ maxConcurrent: 100, perRun: 100, claude: { maxConcurrent: 100 }, codex: { maxConcurrent: 100 }, nonCommsReserve: defaults().scheduler.perRun + 1 });
    await assert.rejects(loadConfig(home), /nonCommsReserve must fit every cap/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
