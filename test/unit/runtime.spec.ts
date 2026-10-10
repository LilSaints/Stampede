import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '../../src/runtime/parse.js';
import { executeWorkflow } from '../../src/runtime/hooks.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunExecution, RunManager } from '../../src/hub/runs.js';
import { defaults, lowerConfig } from '../../src/hub/config.js';
import { Store } from '../../src/hub/store.js';
import type { Run } from '../../src/hub/model.js';

const meta = `export const meta = {name: 'test', description: 'runtime contract'};\n`;
function run(body: string, call: (method: string, params: any) => Promise<unknown> = async () => null, extra = {}) { return executeWorkflow({ source: meta + body, call, ...extra }); }
test('parser accepts top-level await/return and requires literal first metadata', () => {
  assert.equal(parseWorkflow(meta + 'return await agent("hello");').meta.name, 'test');
  for (const source of ['const x = 1;' + meta, `export const meta = {name: Math.random(), description: ''}`, meta + `import('fs')`, meta + 'export const x = 1;', meta + 'let x: string;']) assert.throws(() => parseWorkflow(source));
  assert.throws(() => parseWorkflow(meta + 'const x: number = 1'), /plain JavaScript/);
});
test('runtime hooks, arguments and synchronous budget view', async () => {
  const runtime = run('await log(args.message); return { spent: budget.spent(), left: budget.remaining(), total: budget.total, result: await agent("p") };', async (method, params) => method === 'agent' ? params.prompt : undefined, { args: { message: 'hello' }, budgetTokens: 100 });
  runtime.setSpent(17);
  assert.deepEqual(await runtime.result, { spent: 17, left: 83, total: 100, result: 'p' });
});
test('parallel and pipeline preserve slots, null failures and original items without stage barriers', async () => {
  const value = await run(`
const calls = [];
const result = await parallel([() => 1, () => {throw new Error('no')}, async () => 3]);
const pipe = await pipeline([2, 4, 6], (p, original, index) => {if(index === 1) throw new Error('bad'); return p + 1}, (p, original, index) => [p, original, index]);
return {result, pipe};`).result;
  assert.deepEqual(value, { result: [1, null, 3], pipe: [[3, 2, 0], null, [7, 6, 2]] });
});
test('caps reject before invoking callbacks', async () => {
  assert.equal((await run('return parallel(Array(4096).fill(() => 1));').result as number[]).length, 4096);
  assert.equal((await run('return pipeline(Array(4096).fill(1), x => x + 1);').result as number[]).length, 4096);
  const calls: string[] = [];
  const call = async (method: string) => { calls.push(method); return null; };
  await assert.rejects(run('return parallel(Array(4097).fill(() => log("unexpected callback")));', call).result, /4096/);
  await assert.rejects(run('return pipeline(Array(4097).fill(1), x => log("unexpected callback"));', call).result, /4096/);
  assert.deepEqual(calls, []);
});
test('the 1000-agent lifetime ceiling includes terminal members and rejects partial teams', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-lifetime-cap-'));
  const config = defaults(), unavailable = { available: false, capabilities: {} };
  const manager = new RunManager(new Store(home), config, { claude: unavailable, codex: unavailable }, 'unused');
  const record: Run = {
    id: 'run_cap', name: 'lifetime', cwd: home, scriptPath: 'cap.js', scriptSha256: '', args: null, status: 'running',
    phases: [], createdAt: new Date().toISOString(), budget: { totalTokens: null, spentTokens: 0, totalUsd: null, spentUsd: 0 },
    counters: { agentsStarted: 0, agentsRunning: 0, messages: 0 }, agents: [], log: [], defaultBackend: 'claude', seenSeq: {}, readSeq: {}, cacheHits: 0, liveCalls: 0
  };
  const execution = new RunExecution(manager, record, config);
  try {
    // Exercise actual admission records without launching 1000 processes.
    for (let i = 0; i < 999; i++) {
      const context = execution.prepare('fixture', {});
      context.agent.status = 'done'; context.agent.result = 'fixture';
      execution.peers.get(context.agent.name)!.status = 'done';
    }
    await assert.rejects(execution.spawnTeam([{ name: 'a', prompt: 'fixture' }, { name: 'b', prompt: 'fixture' }], {}), /invalid team size/);
    assert.equal(record.counters.agentsStarted, 999);
    assert.equal(execution.teams.size, 0);
    execution.prepare('last permitted', {});
    assert.equal(record.agents.length, 1000);
    await assert.rejects(run('return await agent("overflow");', (method, params) => execution.call(method, params)).result, /1000-agent cap reached/);
    assert.equal(record.counters.agentsStarted, 1000);
    assert.equal(execution.contexts.size, 1000);
    assert.equal(manager.scheduler.snapshot().held.length, 0);
    assert.equal(manager.scheduler.snapshot().queued.length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('a slot parallel() or pipeline() turns to null logs why, and a refused agent() call wakes the orchestrator once per reason', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-refused-'));
  const config = defaults(), unavailable = { available: false, capabilities: {} };
  const manager = new RunManager(new Store(home), config, { claude: unavailable, codex: unavailable }, 'unused');
  const record = (id: string): Run => ({
    id, name: 'refused', cwd: home, scriptPath: 'refused.js', scriptSha256: '', args: null, status: 'running',
    phases: [], createdAt: new Date().toISOString(), budget: { totalTokens: null, spentTokens: 0, totalUsd: null, spentUsd: 0 },
    counters: { agentsStarted: 0, agentsRunning: 0, messages: 0 }, agents: [], log: [], defaultBackend: 'claude', seenSeq: {}, readSeq: {}, cacheHits: 0, liveCalls: 0
  });
  const run1 = record('run_01M4KJZSSMTPVZ3ENGRBVBPJE0');
  await mkdir(manager.store.runDir(run1.id), { recursive: true });
  const execution = new RunExecution(manager, run1, config);
  try {
    const result = await run(`return [
  await parallel([() => agent('x', { name: 'reviewer', timeoutMs: 1e12 }), () => agent('y', { timeoutMs: 1e12 }), () => { throw new Error('no'); }]),
  await pipeline([1], x => x + 1, () => agent('z', { label: 'Fix tests', maxResumes: 21 }))
];`, (method, params) => execution.call(method, params)).result;
    assert.deepEqual(result, [[null, null, null], [null]]);
    const timeout = `timeoutMs 1000000000000 ms (277777.8 h) exceeds limits.turnTimeoutMs, 14400000 ms (4 h): ask for less, or raise limits.turnTimeoutMs in ${path.join(home, 'config.json')} and restart the hub`;
    const resumes = `maxResumes 21 exceeds limits.maxResumesPerAgent, 20: ask for less, or raise limits.maxResumesPerAgent in ${path.join(home, 'config.json')} and restart the hub`;
    assert.deepEqual([...run1.log].sort(), [
      'parallel() slot 0 is null: agent() "reviewer" was refused: ' + timeout,
      'parallel() slot 1 is null: agent() was refused: ' + timeout,
      'parallel() slot 2 is null: no',
      'pipeline() item 0 (stage 2 of 2 threw) is null: agent() "Fix tests" was refused: ' + resumes
    ]);
    // The second refusal for the same reason is in the log only.
    assert.deepEqual(run1.notifications!.filter(n => n.type === 'agent.refused').map(n => n.data), [{ name: 'reviewer', error: { message: timeout } }, { label: 'Fix tests', error: { message: resumes } }]);
    // A limit the project or the run lowered says so, since raising the hub's would not help.
    const lowered = new RunExecution(manager, record('run_01M4KJZSSMTPVZ3ENGRBVBPJE1'), lowerConfig(config, { limits: { turnTimeoutMs: 3600000 } }));
    assert.throws(() => lowered.prepare('fixture', { timeoutMs: 7200000 }), { message: "timeoutMs 7200000 ms (2 h) exceeds limits.turnTimeoutMs, 3600000 ms (1 h), which this run's limits or the project's .stampede/config.json set below the hub's 14400000 ms (4 h): ask for less" });
    assert.throws(() => lowered.prepare('fixture', { timeoutMs: 0 }), /timeoutMs must be a positive number of milliseconds/);
    assert.throws(() => lowered.prepare('fixture', { maxResumes: 1.5 }), /maxResumes must be a non-negative integer/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('nondeterministic APIs and host globals are unavailable', async () => {
  for (const expression of ['Date.now()', 'new Date()', 'Date()', 'Math.random()']) await assert.rejects(run(`return ${expression};`).result, /non-deterministic API/);
  assert.deepEqual(await run('return [new Date("2026-01-01").getUTCFullYear(), typeof process, typeof fetch, typeof setTimeout, typeof require];').result, [2026, 'undefined', 'undefined', 'undefined', 'undefined']);
  await assert.rejects(run('return Function("return 1")();').result, /Code generation/);
});
test('watchdog terminates a blocked worker and abort terminates pending RPC', async () => {
  await assert.rejects(run('while(true) {}', undefined, { cpuBlockMs: 500 }).result, /blocked the event loop/);
  const controller = new AbortController();
  const execution = run('return agent("pending")', () => new Promise(() => {}), { signal: controller.signal });
  controller.abort();
  await assert.rejects(execution.result, /run cancelled/);
});
