import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';

const meta = 'export const meta={name:"runtime acceptance",description:"fake backend checks"};\n';
test('USD admission and accounting use the effective agent-type model', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-budget-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'claude';
  config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4;
  config.codex.defaultModel = 'base';
  config.codex.agentTypes = { priced: { developerInstructions: '', model: 'priced' }, unknown: { developerInstructions: '', model: 'unpriced' } };
  config.pricing.codex = { base: { inputPerMTok: 1, cachedPerMTok: 1, outputPerMTok: 1 }, priced: { inputPerMTok: 2, cachedPerMTok: 1, outputPerMTok: 4 } };
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
  const run = async (opts: object) => {
    const started = await hub.manager.start({ cwd, budgetUsd: 1, args: opts, script: meta + 'return await agent("fixture",args);' });
    await hub.manager.active.get(started.runId)!.task; return hub.manager.get(started.runId);
  };
  try {
    const rejected = await run({ backend: 'codex', agentType: 'unknown' });
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.agents.length, 0);
    assert.match(rejected.error!.message, /budgetUsd requires pricing for codex model unpriced/);
    delete config.pricing.codex.base;
    const priced = await run({ backend: 'codex', agentType: 'priced' });
    assert.equal(priced.status, 'completed', JSON.stringify(priced.error));
    assert.ok(Math.abs(priced.budget.spentUsd - 0.000034) < 1e-12);
    const override = await run({ backend: 'codex', agentType: 'unknown', model: 'priced' });
    assert.equal(override.status, 'completed');
    assert.ok(Math.abs(override.budget.spentUsd - 0.000034) < 1e-12);
    await assert.rejects(hub.manager.start({ cwd, budgetUsd: 1, defaultBackend: 'codex', script: meta + 'return 1;' }), /pricing for codex model base/);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('child workflows share live budgets and cancellation while keeping phase groups scoped', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-child-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const child = path.join(root, 'child.js');
  await writeFile(child, 'export const meta={name:"child",description:"scoped child"}; phase("Inspect"); const value=await agent(args.value); return {value,spent:budget.spent()};');
  const config = defaults(); config.defaultBackend = 'codex'; config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
  try {
    const started = await hub.manager.start({ cwd, budgetTokens: 12, args: { child }, script: meta + 'phase("Parent"); const nested=await workflow({scriptPath:args.child},{value:"child-value"}); const parent=await agent("parent-value"); return {nested,parent,spent:budget.spent()};' });
    await hub.manager.active.get(started.runId)!.task;
    const run = hub.manager.get(started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.deepEqual(run.result, { nested: { value: 'child-value', spent: 4 }, parent: 'parent-value', spent: 8 });
    assert.deepEqual(run.agents.map(a => a.phase), ['▸ child / Inspect', 'Parent']);
    assert.equal(run.phase, 'Parent');
    assert.deepEqual(run.phases.map(p => p.title), ['Parent', '▸ child / Inspect']);
    await writeFile(child, 'export const meta={name:"nested",description:"nesting rejected"}; return await workflow("third-level");');
    const nested = await hub.manager.start({ cwd, args: { child }, script: meta + 'return await workflow({scriptPath:args.child});' });
    await hub.manager.active.get(nested.runId)!.task;
    assert.match(hub.manager.get(nested.runId).error!.message, /nested workflow/);
    assert.equal(hub.manager.get(nested.runId).agents.length, 0);
    await writeFile(child, 'export const meta={name:"waiting-child",description:"cancelled with parent"}; return await agent("hang");');
    const waiting = await hub.manager.start({ cwd, args: { child }, script: meta + 'return await workflow({scriptPath:args.child});' });
    const execution = hub.manager.active.get(waiting.runId)!;
    const deadline = Date.now() + 10000;
    while (execution.run.agents[0]?.status !== 'running') { if (Date.now() > deadline) throw new Error('child did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
    await hub.manager.control(waiting.runId, 'cancel'); await execution.task;
    assert.equal(execution.run.agents[0].status, 'cancelled');
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
