import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '../../src/runtime/parse.js';
import { executeWorkflow } from '../../src/runtime/hooks.js';

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
  await assert.rejects(run('return parallel(Array(4097).fill(() => 1));').result, /4096/);
  await assert.rejects(run('return pipeline(Array(4097), x => x);').result, /4096/);
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
