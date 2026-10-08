import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';

import { fixtures, review, loop, panel } from '../fixtures/reference.js';

test('installed Workflow reference review, dry-loop and judge-panel patterns run on both fake backends', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-reference-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  config.scheduler.claude.maxConcurrent = 6; config.scheduler.codex.maxConcurrent = 6;
  const adapter = (backend: string) => ({ available: true, binary: process.execPath, entry: path.resolve(`test/fake-backends/fake-${backend}.mjs`), version: backend === 'claude' ? '2.1.292' : '0.159.2', capabilities: {} });
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: adapter('claude'), codex: adapter('codex') } });
  try {
    for (const backend of ['claude', 'codex'] as const) {
      for (const [script, expected, count] of [
        [review, { confirmed: [{ title: 'fixture-real', file: 'a.ts', verdict: { isReal: true } }] }, 4],
        [loop, [{ desc: 'fixture-real' }], 12],
        [panel, { winner: 'B', runnersUp: ['C', 'A'] }, 7]
      ] as const) {
        const started = await hub.manager.start({ cwd, defaultBackend: backend, script, args: fixtures });
        await hub.manager.active.get(started.runId)!.task;
        const run = hub.manager.get(started.runId);
        assert.equal(run.status, 'completed', JSON.stringify(run.error));
        assert.deepEqual(run.result, expected); assert.equal(run.agents.length, count);
        assert.ok(run.agents.every(a => a.status === 'done' && a.backend === backend));
        assert.ok(run.agents.every(a => !a.phase || run.phases.some(phase => phase.title === a.phase)), 'explicit agent phases must be visible in the pane');
        if (script === panel) assert.deepEqual(run.agents.map(a => a.phase), ['Design','Design','Design','Judge','Judge','Judge','Synthesize']);
        if (script === review) assert.deepEqual(run.agents.filter(a => a.phase === 'Verify').map(a => a.label).sort(), ['verify:a.ts','verify:b.ts']);
      }
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
