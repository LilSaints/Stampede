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
