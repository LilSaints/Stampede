import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { git } from '../../src/hub/workspaces.js';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';

const meta = 'export const meta={name:"runtime acceptance",description:"fake backend checks"};\n';
test('invalid teams leave no partial members, counters or reservations', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-team-validation-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-claude.mjs'), capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: { ...fake, capabilities: { mcpViaFlags: false } } } });
  try {
    const started = await hub.manager.start({ cwd, script: meta + `
const errors=[];
const members=[{name:'first',prompt:'unused',backend:'claude'},{name:'second',prompt:'unused',backend:'claude'}];
for(const [roster,opts] of [
  [[members[0],{...members[1],backend:'codex'}],{}],
  [members,{topology:null}],
  [members,{topology:{first:['second'],second:42}}],
  [[members[0],{...members[1],name:123}],{}],
  [[members[0],{...members[1],cwd:123}],{}]
]) {try {await spawnTeam(roster,opts);} catch(error) {errors.push(error.message);}}
return {errors,result:await agent('recovered',{name:'first',backend:'claude'})};` });
    const execution = hub.manager.active.get(started.runId)!;
    await execution.task;
    assert.equal(execution.run.status, 'completed', JSON.stringify(execution.run.error));
    const result = execution.run.result as any;
    assert.equal(result.errors.length, 5);
    assert.match(result.errors[0], /messaging is not qualified/);
    assert.match(result.errors[1], /topology/);
    assert.match(result.errors[2], /topology/);
    assert.match(result.errors[3], /agent name/);
    assert.match(result.errors[4], /cwd must be a string/);
    assert.equal(result.result, 'recovered');
    assert.equal(execution.run.counters.agentsStarted, 1);
    assert.deepEqual(execution.run.agents.map(agent => agent.name), ['first']);
    assert.equal(execution.teams.size, 0);
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
    assert.equal(hub.manager.scheduler.snapshot().queued.length, 0);
    const named = await hub.manager.start({ cwd, script: meta + 'const t=await spawnTeam([{name:"constructor",prompt:"fixture:team",backend:"claude"}],{topology:{}}); await t.untilDone(undefined,{maxMs:10000}); return await t.results();' });
    await hub.manager.active.get(named.runId)!.task;
    const namedRun = hub.manager.get(named.runId);
    assert.equal(namedRun.status, 'completed', JSON.stringify(namedRun.error));
    assert.equal((namedRun.result as any).constructor.status, 'done', 'topology lookup must not use inherited object properties');
    assert.deepEqual(namedRun.agents[0].comms.canMessage, ['orchestrator']);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('the last rate-limited attempt still cools down the backend', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-rate-limit-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex';
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
  const timer = globalThis.setTimeout, waits: number[] = [];
  let backoffPending = false;
  hub.manager.on('event', event => { if (event.type === 'scheduler.cooldown') backoffPending = true; });
  // Advance only retry backoff. Process timeouts, watchdogs and hub timers keep
  // real time; actual fake workers still traverse the adapter/error path.
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (backoffPending && [5000, 15000, 45000, 120000].some(base => ms >= base && ms < base + 1000)) { backoffPending = false; waits.push(ms); return timer(callback, 0, ...args); }
    return timer(callback, ms, ...args);
  }) as typeof setTimeout);
  try {
    const started = await hub.manager.start({ cwd, script: meta + 'return await agent("rate-limit");' });
    await hub.manager.active.get(started.runId)!.task;
    const run = hub.manager.get(started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.equal(run.result, null);
    assert.equal(run.agents[0].turns.length, 6);
    assert.equal(run.agents[0].error?.kind, 'rate_limit');
    assert.equal(hub.manager.events.filter(event => event.runId === run.id && event.type === 'scheduler.cooldown').length, 6);
    assert.equal(waits.length, 5);
    const jitter = waits[0] - 5000;
    assert.deepEqual(waits, [5000, 15000, 45000, 120000, 120000].map(base => base + jitter));
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
  } finally { t.mock.restoreAll(); await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

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
    // (10 - 2 cached) × 2 + 2 × 1 + 3 output (its 1 reasoning included) × 4, per million.
    assert.ok(Math.abs(priced.budget.spentUsd - 0.00003) < 1e-12);
    const override = await run({ backend: 'codex', agentType: 'unknown', model: 'priced' });
    assert.equal(override.status, 'completed');
    assert.ok(Math.abs(override.budget.spentUsd - 0.00003) < 1e-12);
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
    assert.deepEqual(run.result, { nested: { value: 'child-value', spent: 3 }, parent: 'parent-value', spent: 6 });
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
test('a Claude answer without structured output is read from its text, or repaired in its own session', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-claude-schema-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-claude.mjs'), capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: { available: false, capabilities: {} } } });
  try {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
    const started = await hub.manager.start({ cwd, defaultBackend: 'claude', args: { schema }, script: meta + 'return { fenced: await agent("fixture:fenced-json", { name: "fenced", schema: args.schema }), prose: await agent("fixture:prose", { name: "prose", schema: args.schema }) };' });
    const execution = hub.manager.active.get(started.runId)!;
    await execution.task;
    const run = hub.manager.get(started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.deepEqual(run.result, { fenced: { verdict: 'fix' }, prose: { verdict: 'fix' } });
    // The fenced answer is used as it stands; the prose one is repaired by resuming, never re-run.
    assert.deepEqual(run.agents.map(a => a.turns.map(t => t.kind)), [['start'], ['start', 'schema-repair']]);
    assert.ok(run.log.some(line => line.startsWith('fenced: no structured output')));
    assert.ok(run.log.some(line => line.startsWith('prose: its answer did not match the schema')));
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('an agent continues another\'s worktree from its commit, a reviewer reads it, and a bad base fails that agent alone', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-base-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  await git(cwd, ['init']); await git(cwd, ['config', 'user.name', 'Stampede fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'input.txt'), 'base'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'fixture']);
  const config = defaults(); config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4;
  const fake = (name: string) => ({ available: true, binary: process.execPath, entry: path.resolve(`test/fake-backends/fake-${name}.mjs`), version: '0.159.2', capabilities: {} });
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake('claude'), codex: fake('codex') } });
  try {
    const started = await hub.manager.start({ cwd, script: meta + `
const writer = await agent("fixture:edit", { name: "writer", backend: "codex", access: "edit" });
const settings = JSON.parse(await agent("fixture:settings", { name: "reader", backend: "claude", readWorktrees: ["writer"] }));
await agent("next", { name: "next", backend: "codex", access: "edit", baseRef: { agent: "writer" } });
let bad = null; try { await agent("x", { name: "bad", backend: "codex", baseRef: "-x" }); } catch (error) { bad = error.message; }
const missing = await agent("y", { name: "missing", backend: "codex", access: "edit", baseRef: "no-such-ref" });
return { writer: await workspace("writer"), next: await workspace("next"), reader: await workspace("reader"), deny: settings.permissions.deny, bad, missing, after: await agent("after", { name: "after", backend: "codex" }) };` });
    await hub.manager.active.get(started.runId)!.task;
    const run = hub.manager.get(started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const result = run.result as any, writerRoot = result.writer.path.replaceAll('\\', '/');
    assert.match(result.writer.branch, /\/writer$/); assert.equal(result.writer.kept, true); assert.ok(result.writer.commit);
    // The next agent starts where the writer finished, not at the checkout's HEAD.
    assert.equal(result.next.baseCommit, result.writer.commit);
    assert.equal(result.reader, null);
    // The reviewer may read the named worktree, never write it.
    assert.ok(!result.deny.includes(`Read(${writerRoot}/**)`));
    assert.ok(result.deny.includes(`Edit(${writerRoot}/**)`) && result.deny.includes(`Write(${writerRoot}/**)`));
    assert.match(result.bad, /baseRef must be a git ref/);
    // A base that names no commit fails that agent alone: the backend stays available.
    assert.equal(result.missing, null); assert.equal(result.after, 'after');
    assert.ok(run.log.some(line => line.startsWith('missing: baseRef no-such-ref names no commit')));
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
