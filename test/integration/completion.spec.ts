import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import type { BackendInfo } from '../../src/hub/capabilities.js';
import { readJson } from '../../src/hub/store.js';

test('mark_done waits for 30-second final output in agent, untilDone and run-end drain', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede completion '));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  config.scheduler.claude.maxConcurrent = 3; config.scheduler.codex.maxConcurrent = 3;
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
  const meta = 'export const meta={name:"delayed final",description:"30-second completion"};';
  const prompt = 'fixture:team-delayed-30s';
  try {
    const began = Date.now();
    const direct = await hub.manager.start({ cwd, script: meta + `return await agent('${prompt}',{backend:'claude',comms:true});` });
    const done = await hub.manager.start({ cwd, script: meta + `const t=await spawnTeam([{name:'late',backend:'codex',prompt:'${prompt}'}]); const observed=await t.untilDone(undefined,{maxMs:60000}); return {observed,results:await t.results()};` });
    const drain = await hub.manager.start({ cwd, script: meta + `const t=await spawnTeam([{name:'a',backend:'claude',prompt:'${prompt}'},{name:'b',backend:'codex',prompt:'${prompt}'}]); while(!Object.values(await t.results()).every(r=>r.markedDone)) await t.untilDone(undefined,{maxMs:50}); const observed=await t.untilQuiet({idleMs:0,maxMs:100}); return {observed,results:await t.results()};` });
    const executions = [direct, done, drain].map(r => hub.manager.active.get(r.runId)!);
    const deadline = Date.now() + 20000;
    while (!executions.every(e => e.run.agents.length && e.run.agents.every(a => a.markedDone)) || !executions[2].draining) {
      assert.ok(Date.now() < deadline, 'workers must mark done and the drain script must return before final output');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(executions.reduce((sum, e) => sum + e.run.agents.length, 0), 4);
    for (const execution of executions) {
      assert.equal(execution.run.status, 'running');
      assert.ok(execution.run.agents.every(a => a.result === undefined && a.status === 'running'));
    }
    await Promise.all(executions.map(e => e.task));
    assert.ok(Date.now() - began >= 30000, 'completion must not race mark_done');
    for (const execution of executions) {
      assert.equal(execution.run.status, 'completed', JSON.stringify(execution.run.error));
      assert.ok(execution.run.agents.every(a => a.status === 'done' && a.result === prompt));
      const stored = await readJson<any>(path.join(hub.manager.store.runDir(execution.run.id), 'run.json'));
      assert.ok(stored.agents.every((a: any) => a.result === prompt && a.resultStoredAtTurn === 1), 'the delayed final output must be stored durably before the run finishes');
    }
    assert.equal(executions[0].run.result, prompt);
    assert.equal((executions[1].run.result as any).observed.reason, 'all-terminal');
    assert.equal((executions[1].run.result as any).results.late.result, prompt);
    assert.equal((executions[2].run.result as any).observed.reason, 'max-ms');
    assert.ok(Object.values((executions[2].run.result as any).results).every((r: any) => r.result === null && r.markedDone));
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
