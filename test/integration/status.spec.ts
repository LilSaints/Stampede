import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import type { BackendInfo } from '../../src/hub/capabilities.js';

test('status preserves the orchestrator inbox, idle blockers and durable undeliverable counts', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede status '));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex';
  config.scheduler.maxConcurrent = 3; config.scheduler.perRun = 3; config.scheduler.codex.maxConcurrent = 3;
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
  const call = async (name: string, input: unknown) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/v1/orch/${name}`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const result: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const script = 'export const meta={name:"status fixture",description:"status",phases:[{title:"Review"}]}; const t=await spawnTeam([{name:"a",prompt:"ready",phase:"Review"},{name:"b",prompt:"ready",phase:"Review"}]); return await t.untilDone(undefined,{maxMs:20000});';
  try {
    const first = await call('workflow_run', { cwd, script, orchestratorSessionId: 'owner' });
    const execution = hub.manager.active.get(first.runId)!;
    execution.bus.limits.rateCount = 100;
    await until(() => execution.run.agents.length === 2 && execution.run.agents.every(a => a.status === 'idle'));
    const second = await call('workflow_run', { cwd, script });
    await until(() => hub.manager.scheduler.snapshot().queued.some(slots => slots[0]?.runId === second.runId));
    const queued = await call('workflow_status', { runId: second.runId });
    assert.deepEqual(queued.admission[0].blockedBy.map((a: any) => [a.runId, a.name, a.status]), [[first.runId, 'a', 'idle'], [first.runId, 'b', 'idle']]);
    for (let i = 0; i < 6; i++) await execution.bus.send('a', 'orchestrator', `owner-${i}`);
    await execution.controlAgent('b', 'skip');
    for (let i = 0; i < 25; i++) await execution.bus.send('a', 'b', `peer-${i}`);
    const status = await call('workflow_status', { runId: first.runId, orchestratorSessionId: 'observer' });
    assert.deepEqual(status.latestMessages.map((m: any) => m.text), ['owner-1', 'owner-2', 'owner-3', 'owner-4', 'owner-5']);
    assert.equal(status.unreadForOrchestrator, 6); assert.equal(status.undeliverableMessages, 25);
    assert.equal(status.phases[0].agents.idle, 1);
    await call('workflow_messages', { runId: first.runId, orchestratorSessionId: 'observer' });
    assert.equal(execution.run.readSeq.owner, undefined); assert.equal(execution.run.seenSeq.owner, undefined);
    assert.equal((await call('workflow_status', { runId: first.runId, orchestratorSessionId: 'owner' })).unreadForOrchestrator, 6);
    await call('workflow_control', { runId: second.runId, action: 'cancel' });
    await call('workflow_control', { runId: first.runId, action: 'cancel' });
    await execution.task;
    assert.equal((await call('workflow_status', { runId: first.runId })).undeliverableMessages, 25);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
