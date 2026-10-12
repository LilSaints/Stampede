import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import type { BackendInfo } from '../../src/hub/capabilities.js';
import { readJson } from '../../src/hub/store.js';

const meta = 'export const meta = { name: "steering", description: "orchestrator controls" };\n';
const until = async (check: () => boolean, what: string, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < deadline, `timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const exists = (file: string) => access(file).then(() => true, () => false);

test('the orchestrator steers workers without comms, answers checkpoints, passes args by file and hears of cancelled work', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-steering-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  for (const args of [['init', '-q'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'base']]) execFileSync('git', args, { cwd, windowsHide: true });
  const config = defaults(); config.delivery.resumeDebounceMs = 10;
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
  const orch = async (name: string, input: unknown) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/v1/orch/${name}`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { ok: response.ok, value: await response.json() as any };
  };
  try {
    // A Codex worker started without comms is cut right after a tool call and resumed with the message.
    const steer = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:steer", { name: "coder", backend: "codex" });' });
    const steerRun = hub.manager.active.get(steer.runId)!;
    await until(() => steerRun.run.agents[0]?.status === 'running' && Boolean(steerRun.run.agents[0]?.sessionId), 'the coder to run');
    const sent = await orch('workflow_send', { runId: steer.runId, to: 'coder', text: 'use the new API' });
    assert.ok(sent.ok, JSON.stringify(sent.value)); assert.deepEqual(sent.value.deliveredTo, ['coder']);
    await steerRun.task;
    assert.equal(steerRun.run.result, 'steered: use the new API');
    assert.deepEqual(steerRun.run.agents[0]!.turns.map(t => t.kind), ['start', 'steer']);
    assert.ok(steerRun.run.log.some(line => line.includes('to deliver the orchestrator')));
    // A peer still needs comms to reach it, and an unknown name says so.
    assert.match((await orch('workflow_send', { runId: (await hub.manager.start({ cwd, script: meta + 'await agent("hang", { name: "idle-one", backend: "codex" }); return 1;' })).runId, to: 'nobody', text: 'x' })).value.error, /no agent named nobody/);

    // A message that comes too late for the turn is read in a resumed one before the agent is done.
    const late = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:slow", { name: "slow", backend: "codex" });' });
    const lateRun = hub.manager.active.get(late.runId)!;
    await until(() => lateRun.run.agents[0]?.status === 'running', 'the slow agent to run');
    await lateRun.sendOrchestrator('slow', 'add the summary');
    await lateRun.task;
    assert.equal(lateRun.run.result, 'resumed: add the summary');

    // A checkpoint waits for the orchestrator, wakes it, and a resumed run replays its answer.
    const script = meta + 'const scope = await checkpoint("scope", { files: 2 }); const late = await checkpoint("late", null, { timeoutMs: 100, default: "fallback" }); return { scope, late };';
    const asked = await hub.manager.start({ cwd, script });
    const askedRun = hub.manager.active.get(asked.runId)!;
    await until(() => askedRun.run.checkpoints?.[0]?.status === 'waiting', 'the checkpoint');
    assert.ok(askedRun.run.notifications?.some(n => n.type === 'checkpoint.waiting' && n.data.name === 'scope'));
    const status = await orch('workflow_status', { runId: asked.runId });
    assert.deepEqual(status.value.checkpoints.map((c: any) => [c.name, c.data]), [['scope', { files: 2 }]]);
    assert.match((await orch('workflow_answer', { runId: asked.runId, name: 'other', answer: true })).value.error, /no checkpoint named other/);
    assert.ok((await orch('workflow_answer', { runId: asked.runId, name: 'scope', answer: { include: ['a.ts'] } })).ok);
    await askedRun.task;
    assert.deepEqual(askedRun.run.result, { scope: { include: ['a.ts'] }, late: 'fallback' });
    assert.deepEqual(askedRun.run.checkpoints!.map(c => c.status), ['answered', 'timed_out']);
    const replay = await hub.manager.resume(asked.runId, {});
    const replayRun = hub.manager.active.get(replay.runId)!; await replayRun.task;
    assert.deepEqual(replayRun.run.result, { scope: { include: ['a.ts'] }, late: 'fallback' });
    assert.equal(replayRun.run.checkpoints![0]!.replayedFrom, asked.runId);
    // Data too long for the wake keeps its keys and summary there, so the wake still reads it; workflow_status has all of it.
    const big = await hub.manager.start({ cwd, script: meta + 'return await checkpoint("big", { summary: "B9 is ready to land", findings: "x".repeat(3000) });' });
    const bigRun = hub.manager.active.get(big.runId)!;
    await until(() => Boolean(bigRun.run.notifications?.some(n => n.type === 'checkpoint.waiting')), 'the long checkpoint');
    assert.deepEqual(bigRun.run.notifications!.find(n => n.type === 'checkpoint.waiting')!.data.data, { summary: 'B9 is ready to land', findings: '…' });
    assert.equal((await orch('workflow_status', { runId: big.runId })).value.checkpoints[0].data.findings.length, 3000);
    assert.ok((await orch('workflow_answer', { runId: big.runId, name: 'big', answer: 'land' })).ok);
    await bigRun.task; assert.equal(bigRun.run.result, 'land');

    // Args come from a file as well as inline, never both.
    const argsFile = path.join(root, 'args.json'); await writeFile(argsFile, '\uFEFF{"path":"C:\\\\temp","n":30}');
    const fromFile = await hub.manager.start({ cwd, argsPath: argsFile, script: meta + 'return args;' });
    await hub.manager.active.get(fromFile.runId)?.task;
    assert.deepEqual(hub.manager.get(fromFile.runId).result, { path: 'C:\\temp', n: 30 });
    assert.match((await orch('workflow_run', { cwd, argsPath: argsFile, args: {}, script: meta + 'return 1;' })).value.error, /not both/);
    await writeFile(argsFile, '{"n":31}');
    const reread = await hub.manager.resume(fromFile.runId, { argsPath: argsFile });
    await hub.manager.active.get(reread.runId)?.task;
    assert.deepEqual(hub.manager.get(reread.runId).result, { n: 31 });

    // A run whose only agent was cancelled is cancelled, and says where that agent's work is.
    const cut = await hub.manager.start({ cwd, script: meta + 'return await agent("hang", { name: "fixer", backend: "codex", access: "edit" });' });
    const cutRun = hub.manager.active.get(cut.runId)!;
    await until(() => cutRun.run.agents[0]?.status === 'running', 'the fixer to run');
    await cutRun.controlAgent('fixer', 'cancel'); await cutRun.task;
    assert.equal(cutRun.run.status, 'cancelled');
    const ended = cutRun.run.notifications!.find(n => n.type === 'run.status')!;
    assert.equal(ended.data.cancelled[0].name, 'fixer'); assert.match(ended.data.cancelled[0].branch, /fixer/);
    assert.equal((await readJson<any>(path.join(root, 'state', 'runs', cut.runId, 'result.json')))!.cancelledAgents[0].name, 'fixer');
    assert.equal((await orch('workflow_result', { runId: cut.runId })).value.cancelledAgents[0].name, 'fixer');

    // The hub deletes for a worker inside its scratch folder only, and removes that folder when it is done.
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside.txt'); await writeFile(outside, 'keep');
    const cleaned = await hub.manager.start({ cwd, script: meta + `return await agent(${JSON.stringify(`fixture:cleanup:${scratch}|${outside}`)}, { name: "tidy", backend: "claude", access: "edit", isolation: "shared", scratch: [${JSON.stringify(scratch)}] });` });
    await hub.manager.active.get(cleaned.runId)?.task;
    const report = JSON.parse(hub.manager.get(cleaned.runId).result as string);
    assert.deepEqual(report.tools, ['cleanup']); assert.equal(report.removed.length, 1); assert.match(report.refused[0].reason, /outside your worktree and scratch/);
    assert.equal(await exists(outside), true); assert.equal(await exists(scratch), false);
    // A scratch folder outside the worktree exists before an edit worker starts and is writable to it.
    const away = path.join(root, 'away', 'tmp');
    const roots = await hub.manager.start({ cwd, script: meta + `return await agent("fixture:argv", { name: "away", backend: "codex", access: "edit", scratch: [${JSON.stringify(away)}] });` });
    await hub.manager.active.get(roots.runId)?.task;
    const codexArgs: string[] = JSON.parse(hub.manager.get(roots.runId).result as string).argv;
    assert.ok(codexArgs.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([away])}`));
    assert.ok(hub.manager.get(roots.runId).log.includes('away: removed 1 scratch folder'), 'the folder was made, then removed when the worker was done');
    assert.equal(await exists(away), false);
    // A scratch folder the worker already deleted is not reported as kept.
    const gone = path.join(root, 'gone', 'tmp');
    const goneRun = await hub.manager.start({ cwd, script: meta + `return await agent(${JSON.stringify(`fixture:rm-scratch:${gone}`)}, { name: "gone", backend: "codex", access: "edit", scratch: [${JSON.stringify(gone)}] });` });
    await hub.manager.active.get(goneRun.runId)?.task;
    assert.equal(hub.manager.get(goneRun.runId).result, 'removed');
    assert.ok(!hub.manager.get(goneRun.runId).log.some(line => line.startsWith('gone: removed')), 'nothing to remove, so no line');
    // A scratch folder over 100 characters is noted once a run (on Windows), however many agents use one.
    const deepRoot = path.join(root, 'd'.repeat(Math.max(1, 101 - root.length)));
    const deepRun = await hub.manager.start({ cwd, script: meta + `return await parallel(["a", "b", "c"].map(n => () => agent("fixture:argv", { name: "deep-" + n, backend: "codex", access: "edit", isolation: "shared", scratch: [${JSON.stringify(deepRoot)} + "/" + n] })));` });
    await hub.manager.active.get(deepRun.runId)?.task;
    assert.equal(hub.manager.get(deepRun.runId).status, 'completed');
    assert.equal(hub.manager.get(deepRun.runId).log.filter(line => / is over 100 characters/.test(line)).length, process.platform === 'win32' ? 1 : 0, hub.manager.get(deepRun.runId).log.join('\n'));
    // A worker takes a hub-wide lock its call names, waits behind another holder, and the hub takes it back when its turn ends.
    const lockScript = meta + 'return await agent("fixture:lock:desktop-ui", { name: "prober", backend: "claude", locks: ["desktop-ui"] });';
    assert.equal(await hub.manager.locks.acquire('desktop-ui', { id: 'other', label: 'other-agent (run_x)' }, 0), true);
    const blocked = await hub.manager.start({ cwd, script: lockScript });
    await hub.manager.active.get(blocked.runId)?.task;
    const waited = JSON.parse(hub.manager.get(blocked.runId).result as string);
    assert.deepEqual(waited.tools, ['lock', 'unlock']); assert.match(waited.refused, /not one this agent's call names/);
    assert.equal(waited.lock.acquired, false); assert.equal(waited.lock.heldBy, 'other-agent (run_x)');
    assert.equal(hub.manager.locks.release('desktop-ui', 'other'), true);
    const locked = await hub.manager.start({ cwd, script: lockScript });
    await hub.manager.active.get(locked.runId)?.task;
    assert.equal(JSON.parse(hub.manager.get(locked.runId).result as string).lock.acquired, true);
    assert.ok(hub.manager.get(locked.runId).log.includes('prober: released lock desktop-ui (its turn ended)'));
    assert.equal(hub.manager.locks.holder('desktop-ui'), undefined);
    // `env` reaches the worker; Stampede's own variables cannot be set.
    const envRun = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:env:STAMPEDE_TEST_ENV_FREE", { name: "envy", backend: "claude", env: { STAMPEDE_TEST_ENV_FREE: "x" } });' });
    await hub.manager.active.get(envRun.runId)?.task;
    assert.match(String(hub.manager.get(envRun.runId).error?.message), /env cannot set STAMPEDE_TEST_ENV_FREE/);
    const envOk = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:env:MSBUILDDISABLENODEREUSE", { name: "envy", backend: "claude", env: { MSBUILDDISABLENODEREUSE: "1" } });' });
    await hub.manager.active.get(envOk.runId)?.task;
    assert.equal(hub.manager.get(envOk.runId).result, '1');

    // A Claude agent type that lists its tools runs as a copy with the structured-output tool added; every Claude worker gets the inbox hooks.
    await mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(cwd, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\nmodel: opus\ntools: Read, Grep, Bash\n---\nReview the change.\n');
    const typed = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:argv", { name: "rev", backend: "claude", agentType: "reviewer", schema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } }, required: ["argv"] } });' });
    await hub.manager.active.get(typed.runId)?.task;
    const argv: string[] = (hub.manager.get(typed.runId).result as any).argv;
    assert.equal(argv[argv.indexOf('--agent') + 1], 'stampede-reviewer');
    const agents = JSON.parse(await readFile(argv[argv.indexOf('--agents') + 1]!, 'utf8'));
    assert.deepEqual(agents['stampede-reviewer'].tools, ['Read', 'Grep', 'Bash', 'StructuredOutput']);
    assert.equal(agents['stampede-reviewer'].prompt, 'Review the change.'); assert.equal(agents['stampede-reviewer'].model, 'opus');
    const hooked = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:settings", { name: "plain", backend: "claude" });' });
    await hub.manager.active.get(hooked.runId)?.task;
    const settings = JSON.parse(hub.manager.get(hooked.runId).result as string);
    assert.ok(settings.hooks.PostToolUse && settings.hooks.Stop, 'a worker without comms still reads its inbox');
  } finally { await hub.close(); }
});
