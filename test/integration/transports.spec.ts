import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import { probeBackends } from '../../src/hub/capabilities.js';

const meta = 'export const meta={name:"transport qualification",description:"fake CLIs with real MCP"};\n';
const schema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture condition timed out'); await pause(20); }
}

test('both fake CLI adapters execute schema pipelines, judge panels and bounded loops', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-parity-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  config.claude.binary = path.resolve('test/fake-backends/fake-claude.mjs');
  config.codex.entry = path.resolve('test/fake-backends/fake-codex.mjs');
  const backends = await probeBackends(config);
  assert.equal(backends.claude.available, true); assert.equal(backends.codex.available, true);
  const hub = await startHub({ home: path.join(root, 'state'), config, backends, cliEntry: path.resolve('dist/cli.js') });
  try {
    for (const backend of ['claude', 'codex'] as const) {
      const started = await hub.manager.start({ cwd, defaultBackend: backend, args: { schema }, script: meta + `
await phase('Review');
const review=await pipeline([1,2,3], item=>agent(JSON.stringify({value:item}),{schema:args.schema}), result=>result.value*2);
const panel=await parallel([()=>agent('{"value":8}',{schema:args.schema}),()=>agent('crash'),()=>agent('{"value":9}',{schema:args.schema})]);
let value=0; while(value<2) value=(await agent(JSON.stringify({value:value+1}),{schema:args.schema})).value;
return {review,panel,value};` });
      await hub.manager.active.get(started.runId)!.task;
      const run = hub.manager.get(started.runId);
      assert.equal(run.status, 'completed', JSON.stringify(run.error));
      assert.deepEqual(run.result, { review: [2, 4, 6], panel: [{ value: 8 }, null, { value: 9 }], value: 2 });
      assert.ok(run.agents.every(agent => agent.backend === backend));
      assert.equal(run.agents.find(agent => agent.status === 'failed')?.turns.length, 3);
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('four mixed workers use real MCP for 600 ordered deliveries, then reserve progress and idle resume', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-transport-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex';
  config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  config.scheduler.claude.maxConcurrent = 3; config.scheduler.codex.maxConcurrent = 3;
  config.delivery.resumeDebounceMs = 50; config.limits.turnTimeoutMs = 60000;
  const backends = {
    claude: { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-claude.mjs'), version: '2.1.292', capabilities: {} },
    codex: { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} }
  };
  const hub = await startHub({ home: path.join(root, 'state'), config, backends, cliEntry: path.resolve('dist/cli.js') });
  const members = ['claude', 'codex', 'claude', 'codex'].map((backend, i) => ({ name: `peer-${i}`, backend, prompt: 'fixture:burst', schema: { type: 'object', properties: { received: { type: 'integer' }, ordered: { type: 'boolean' }, unique: { type: 'integer' } }, required: ['received', 'ordered', 'unique'], additionalProperties: false } }));
  try {
    const burst = await hub.manager.start({ cwd, args: { members }, script: meta + 'const t=await spawnTeam(args.members); const observed=await t.untilDone(undefined,{maxMs:60000}); return {observed,results:await t.results()};' });
    const execution = hub.manager.active.get(burst.runId)!;
    // The bucket itself has unit coverage. This probe isolates transport order
    // and acknowledges all 600 worker deliveries without rate-limit sleeps.
    execution.bus.limits.rateCount = 1000;
    await execution.task;
    const burstRun = hub.manager.get(burst.runId), result = burstRun.result as any;
    assert.equal(burstRun.status, 'completed', JSON.stringify(burstRun.error));
    assert.equal(result.observed.reason, 'all-terminal');
    for (const member of Object.values(result.results) as any[]) {
      assert.equal(member.status, 'done', JSON.stringify(burstRun.agents.map(a => a.error)));
      assert.deepEqual(member.result, { received: 150, ordered: true, unique: 150 });
    }
    const deliveries = execution.bus.deliveries.filter(d => d.recipient !== 'orchestrator');
    assert.equal(deliveries.length, 600); assert.ok(deliveries.every(d => d.state === 'committed'));
    const waiting = await hub.manager.start({ cwd, args: { members: members.map(({ schema: _, ...member }) => ({ ...member, prompt: 'fixture:wait' })) }, script: meta + 'const t=await spawnTeam(args.members); const quiet=await t.untilQuiet({idleMs:50,maxMs:15000}); const reserved=await agent("reserve survived"); await t.stop(); return {quiet,reserved};' });
    await hub.manager.active.get(waiting.runId)!.task;
    const progress = hub.manager.get(waiting.runId).result as any;
    assert.equal(progress.quiet.reason, 'deadlock'); assert.equal(progress.reserved, 'reserve survived');
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
    const idle = await hub.manager.start({ cwd, script: meta + 'await spawnTeam([{name:"sleeper",prompt:"idle"}]); await new Promise(()=>{});' });
    const resumed = hub.manager.active.get(idle.runId)!;
    await until(() => resumed.run.agents[0]?.status === 'idle');
    await hub.manager.control(idle.runId, 'pause');
    await resumed.sendOrchestrator('sleeper', 'burst-one');
    await resumed.sendOrchestrator('sleeper', 'burst-two');
    assert.equal(resumed.run.agents[0].resumes, 0);
    await hub.manager.control(idle.runId, 'resume');
    await until(() => resumed.run.agents[0].resultStoredAtTurn === 2 && resumed.run.agents[0].status === 'idle');
    assert.equal(resumed.run.agents[0].resumes, 1);
    assert.equal(resumed.run.agents[0].turns.length, 2);
    assert.match(String(resumed.run.agents[0].result), /burst-one/); assert.match(String(resumed.run.agents[0].result), /burst-two/);
    assert.equal(resumed.bus.uncommitted(['sleeper']), 0);
    const queued = await hub.manager.start({ cwd, script: meta + 'const t=await spawnTeam([{name:"blocked-a",prompt:"idle"},{name:"blocked-b",prompt:"idle"}]); await t.stop(); return "stopped";' });
    await hub.manager.active.get(queued.runId)!.task;
    assert.equal(hub.manager.get(queued.runId).result, 'stopped');
    assert.equal(hub.manager.get(queued.runId).liveCalls, 0);
    assert.equal(hub.manager.scheduler.snapshot().queued.length, 0);
    assert.ok(hub.manager.get(queued.runId).agents.every(a => a.status === 'cancelled'));
    await hub.manager.control(idle.runId, 'cancel');
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
