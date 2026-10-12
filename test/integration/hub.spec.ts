import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import { capture, type BackendInfo } from '../../src/hub/capabilities.js';
import { atomicJson, readJson, readJournal } from '../../src/hub/store.js';
import { HubClient } from '../../src/mcp/client.js';
const meta = 'export const meta = { name: "fixture", description: "integration" };\n';
test('authenticated hub runs concurrent scripts, resumes from cache, and persists terminal results', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-hub-'));
  const home = path.join(root, 'state'), cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex'; config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6; config.scheduler.codex.maxConcurrent = 3;
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home, config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: { available: false, error: 'fixture disabled', capabilities: {} }, codex: fake } });
  const base = `http://127.0.0.1:${hub.port}`;
  const call = async (name: string, input: unknown) => { const response = await fetch(base + '/v1/orch/' + name, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }); const result: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  // A long-poll timeout is not completion, especially with concurrent process tests.
  const waitRun = async (input: Record<string, unknown>) => {
    const deadline = Date.now() + 20000;
    let observed;
    do {
      observed = await call('workflow_wait', { ...input, wakeOnMessage: false });
      if (observed.woke !== 'timeout') break;
    } while (Date.now() < deadline);
    assert.ok(['completed', 'failed', 'cancelled', 'interrupted'].includes(observed.status), JSON.stringify(observed));
    return observed;
  };
  try {
    assert.equal((await fetch(base + '/v1/ui/snapshot')).status, 401);
    const started = await call('workflow_run', { cwd, script: meta + 'return await parallel([() => agent("one"), () => agent("two")]);', orchestratorSessionId: 'owner' });
    await waitRun({ runId: started.runId, timeoutSec: 10, orchestratorSessionId: 'observer' });
    const result = await call('workflow_result', { runId: started.runId });
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.deepEqual(result.result, ['one', 'two']);
    assert.equal(hub.manager.get(started.runId).seenSeq.owner, undefined);
    assert.ok(hub.manager.get(started.runId).seenSeq.observer > 0);
    // A wake the UI delivered is recorded per session, only ever forward.
    const seen = (session: string, hubSeq: number) => fetch(base + '/v1/ui/seen', { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ session, seen: [{ runId: started.runId, hubSeq }] }) });
    assert.equal((await seen('owner', 2)).status, 200);
    assert.equal(hub.manager.get(started.runId).seenSeq.owner, 2);
    await seen('owner', 1); await seen('owner', Number.MAX_SAFE_INTEGER);
    assert.equal(hub.manager.get(started.runId).seenSeq.owner, 2);
    const resumed = await call('workflow_resume', { runId: started.runId });
    await waitRun({ runId: resumed.runId, timeoutSec: 10 });
    assert.deepEqual((await call('workflow_result', { runId: resumed.runId })).result, ['one', 'two']);
    assert.equal(hub.manager.get(resumed.runId).cacheHits, 2);
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
    const teamScript = meta + 'const team = await spawnTeam([{name:"a",prompt:"fixture:team-a"},{name:"b",prompt:"fixture:team-b"}]); await team.untilDone(undefined, {maxMs:10000}); return {results:await team.results(),board:await board()};';
    const teamRun = await call('workflow_run', { cwd, script: teamScript });
    await waitRun({ runId: teamRun.runId, timeoutSec: 10, wakeOnMessage: false });
    const teamResult = await call('workflow_result', { runId: teamRun.runId });
    assert.equal(teamResult.status, 'completed', JSON.stringify(teamResult));
    assert.equal(teamResult.result.board.length, 2);
    const sharedJournal = await readJournal<any>(path.join(home, 'runs', teamRun.runId, 'journal.jsonl'));
    assert.ok(sharedJournal.every(record => record.shared.writes.includes('post_finding') && record.shared.writes.includes('send_message')));
    const replayed = await call('workflow_resume', { runId: teamRun.runId });
    await waitRun({ runId: replayed.runId, timeoutSec: 10, wakeOnMessage: false });
    const replayResult = await call('workflow_result', { runId: replayed.runId });
    assert.deepEqual(replayResult.result.results, teamResult.result.results);
    assert.equal(hub.manager.get(replayed.runId).cacheHits, 2);
    assert.equal(hub.manager.get(replayed.runId).liveCalls, 0);
    assert.equal(replayResult.result.board.length, 2);
    assert.ok(replayResult.result.board.every((entry: any) => entry.replayedFrom === teamRun.runId));
    const changedArgs = await call('workflow_resume', { runId: teamRun.runId, args: { changed: true } });
    await waitRun({ runId: changedArgs.runId, timeoutSec: 10, wakeOnMessage: false });
    assert.equal(hub.manager.get(changedArgs.runId).cacheHits, 0);
    assert.equal(hub.manager.get(changedArgs.runId).liveCalls, 2);
    const drain = await call('workflow_run', { cwd, script: meta + 'const t=await spawnTeam([{name:"late",prompt:"fixture:team-delayed"}]); while(!(await t.messages()).length) await t.untilDone(undefined,{maxMs:50}); const observed=await t.untilDone(undefined,{maxMs:100}); return {observed,results:await t.results()};' });
    await waitRun({ runId: drain.runId, timeoutSec: 5, wakeOnMessage: false });
    const drained = await call('workflow_result', { runId: drain.runId });
    assert.equal(drained.result.observed.reason, 'max-ms');
    assert.equal(drained.result.results.late.result, null);
    assert.equal(hub.manager.get(drain.runId).agents[0].status, 'done');
    assert.equal(hub.manager.get(drain.runId).agents[0].result, 'fixture:team-delayed');
    config.scheduler.admissionMaxMs = 150;
    const blocked = await call('workflow_run', { cwd, script: meta + 'const first=await spawnTeam([{name:"a",prompt:"idle"},{name:"b",prompt:"idle"}]); await first.untilQuiet({idleMs:0,maxMs:2000}); const second=await spawnTeam([{name:"c",prompt:"idle"},{name:"d",prompt:"idle"}]); const observed=await second.untilQuiet({idleMs:0,maxMs:2000}); await first.stop(); return observed;' });
    await waitRun({ runId: blocked.runId, timeoutSec: 5, wakeOnMessage: false });
    assert.equal((await call('workflow_result', { runId: blocked.runId })).result.reason, 'admission-timeout');
    assert.equal(hub.manager.get(blocked.runId).agents.find(a => a.name === 'c')?.error?.waitedMs, 150);
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
    config.scheduler.admissionMaxMs = 2500;
    const released = await call('workflow_run', { cwd, script: meta + 'const first=await spawnTeam([{name:"a",prompt:"idle"},{name:"b",prompt:"idle"}],{releaseIdleAfterMs:10}); await first.untilQuiet({idleMs:0,maxMs:2000}); const second=await spawnTeam([{name:"c",prompt:"idle"},{name:"d",prompt:"idle"}],{releaseIdleAfterMs:10}); return await second.untilDone(undefined,{maxMs:4000});' });
    await waitRun({ runId: released.runId, timeoutSec: 6, wakeOnMessage: false });
    assert.equal((await call('workflow_result', { runId: released.runId })).result.reason, 'all-terminal');
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
    const timed = await call('workflow_run', { cwd, script: meta + 'return await agent("hang",{timeoutMs:150});' });
    await waitRun({ runId: timed.runId, timeoutSec: 5, wakeOnMessage: false });
    assert.equal(hub.manager.get(timed.runId).agents[0].error?.kind, 'timeout');
    assert.equal((await call('workflow_result', { runId: timed.runId })).result, null);
    const budget = await call('workflow_run', { cwd, budgetTokens: 3, script: meta + 'await agent("first"); return await agent("must not start");' });
    await waitRun({ runId: budget.runId, timeoutSec: 5, wakeOnMessage: false });
    assert.equal(hub.manager.get(budget.runId).status, 'failed');
    assert.equal(hub.manager.get(budget.runId).agents.length, 1);
    assert.match(hub.manager.get(budget.runId).error!.message, /budget exhausted/);
    // A finished agent's result is readable while another still runs.
    const live = await call('workflow_run', { cwd, script: meta + 'return await parallel([() => agent("first", { name: "first" }), () => agent("x".repeat(25000), { name: "big" }), () => agent("hang", { name: "waiting" })]);', orchestratorSessionId: 'owner' });
    for (let i = 0; i < 200 && !['first', 'big'].every(name => hub.manager.get(live.runId).agents.find(a => a.name === name)?.status === 'done'); i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(await call('workflow_result', { runId: live.runId, agent: 'first' }), { agent: 'first', status: 'done', result: 'first' });
    // Its transcript, for the pane: the prompt the turn began with, then what it wrote.
    const transcript: any = await (await fetch(`${base}/v1/ui/transcript?runId=${live.runId}&agent=first`, { headers: { authorization: `Bearer ${hub.token}` } })).json();
    assert.deepEqual(transcript.entries, [{ kind: 'prompt', text: 'first' }, { kind: 'text', text: 'first' }]);
    // A long result comes as a preview, the whole value in its file.
    const big = await call('workflow_result', { runId: live.runId, agent: 'big' });
    assert.match(big.result, /^"x+…\(\+5002 chars\)$/);
    assert.equal(await readJson(big.resultPath), 'x'.repeat(25000));
    assert.equal((await call('workflow_result', { runId: live.runId, agent: 'waiting' })).result, undefined);
    assert.equal(hub.manager.get(live.runId).status, 'running');
    await call('workflow_control', { runId: live.runId, action: 'cancel' });
    // Done agents notify only when opted in: per call, or for the run unless a call opts out.
    const done = (runId: string) => (hub.manager.get(runId).notifications ?? []).filter(n => n.type === 'agent.done').map(n => n.data.name);
    assert.deepEqual(done(live.runId), []);
    const notifyScript = path.join(root, 'notify.js');
    await writeFile(notifyScript, meta + 'return await parallel([() => agent("one", { name: "one" }), () => agent("two", { name: "two", notify: false }), () => agent("three", { name: "three", notify: true })]);');
    const notified = await call('workflow_run', { cwd, scriptPath: notifyScript, notifyAgents: true, orchestratorSessionId: 'owner' });
    await waitRun({ runId: notified.runId, timeoutSec: 5 });
    assert.deepEqual(done(notified.runId).sort(), ['one', 'three']);
    const perCall = await call('workflow_run', { cwd, script: meta + 'return await parallel([() => agent("four", { name: "four", notify: true }), () => agent("five", { name: "five" })]);', orchestratorSessionId: 'owner' });
    await waitRun({ runId: perCall.runId, timeoutSec: 5 });
    assert.deepEqual(done(perCall.runId), ['four']);
    // Results replayed from the cache wake no one, and notify is not part of the cache key.
    await writeFile(notifyScript, meta + 'return await parallel([() => agent("one", { name: "one", notify: true }), () => agent("two", { name: "two" }), () => agent("three", { name: "three" })]);');
    const replay = await call('workflow_resume', { runId: notified.runId, scriptPath: notifyScript });
    await waitRun({ runId: replay.runId, timeoutSec: 5 });
    assert.equal(hub.manager.get(replay.runId).cacheHits, 3);
    assert.equal(hub.manager.get(replay.runId).notifyAgents, true);
    assert.deepEqual(done(replay.runId), []);
    // A title names the run in place of meta.name, and a resume keeps it.
    const titled = await call('workflow_run', { cwd, script: meta + 'return 1;', title: '  Batch 2: history, editors  ' });
    await waitRun({ runId: titled.runId, timeoutSec: 5 });
    assert.equal(hub.manager.get(titled.runId).name, 'Batch 2: history, editors');
    const retitled = await call('workflow_resume', { runId: titled.runId });
    assert.equal(hub.manager.get(retitled.runId).name, 'Batch 2: history, editors');
    await assert.rejects(hub.manager.start({ cwd, script: meta + 'return 1;', title: '   ' }), /title must be 1 to 80 characters/);
    // An agent that fails its last attempt is a notification, so the mod wakes the orchestrator mid-run.
    const lost = await call('workflow_run', { cwd, script: meta + 'return await agent("crash", { name: "lost" });', orchestratorSessionId: 'owner' });
    await waitRun({ runId: lost.runId, timeoutSec: 5 });
    const failed = hub.manager.get(lost.runId).notifications!.find(n => n.type === 'agent.failed');
    assert.equal(failed?.data.name, 'lost'); assert.equal(failed?.data.attempts, 3); assert.equal(failed?.data.error.kind, 'crash');
    assert.equal(hub.manager.get(lost.runId).notifications!.filter(n => n.type === 'agent.failed').length, 1);
    const limited = await call('workflow_run', { cwd, script: meta + 'const t=await spawnTeam([{name:"limited",prompt:"idle",maxResumes:0}]); await t.untilQuiet({idleMs:0,maxMs:2000}); await new Promise(()=>{});' });
    const execution = hub.manager.active.get(limited.runId)!;
    for (let i = 0; i < 100 && execution.run.agents[0]?.status !== 'idle'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(execution.run.agents[0].status, 'idle');
    await call('workflow_send', { runId: limited.runId, to: 'limited', text: 'first pending' });
    await call('workflow_send', { runId: limited.runId, to: 'limited', text: 'second pending' });
    for (let i = 0; i < 100 && !execution.run.notifications?.some(e => e.data.kind === 'resumes'); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(execution.bus.pending('limited'), 2);
    assert.equal(execution.bus.messages.filter(m => m.kind === 'system').length, 1);
    assert.equal(execution.run.agents[0].resumes, 0);
    const hook = await capture(process.execPath, [path.resolve('dist/hook.js'), 'post-tool-use', '--backend', 'claude'], undefined, { ...process.env, STAMPEDE_HUB_URL: base, STAMPEDE_AGENT_TOKEN: execution.contexts.get('limited')!.token });
    assert.equal(hook.code, 0);
    const hookContext = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
    assert.match(hookContext, /first pending/); assert.match(hookContext, /second pending/);
    assert.ok(execution.bus.deliveries.filter(d => d.recipient === 'limited').every(d => d.state === 'handed'));
    await call('workflow_control', { runId: limited.runId, action: 'cancel' });
    config.scheduler.codex.maxConcurrent = 1;
    const auth = await call('workflow_run', { cwd, script: meta + 'return await parallel([()=>agent("auth"),()=>agent("auth"),()=>agent("auth"),()=>agent("auth")]);' });
    await waitRun({ runId: auth.runId, timeoutSec: 5, wakeOnMessage: false });
    assert.equal(hub.manager.get(auth.runId).liveCalls, 1);
    assert.ok(hub.manager.get(auth.runId).agents.every(a => a.error?.kind === 'auth'));
    assert.equal(hub.manager.get(auth.runId).notifications?.filter(e => e.type === 'backend.unavailable').length, 1);
    assert.equal(hub.manager.scheduler.snapshot().queued.length, 0);
    config.scheduler.codex.maxConcurrent = 3;
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
    await once(orphan, 'spawn');
    const exited = once(orphan, 'exit');
    try {
      const identity = await hub.security.identity(orphan.pid!);
      assert.ok(identity?.startFileTime);
      assert.equal(await hub.security.killVerified({ ...identity!, startFileTime: '0' }), false);
      assert.equal(orphan.exitCode, null);
      const old = hub.manager.get(started.runId);
      const agent = old.agents[0];
      await atomicJson(path.join(home, 'runs', old.id, 'agents', agent.id, 'pids.json'), identity);
      await writeFile(path.join(home, 'runs', old.id, 'agents', agent.id, 'mcp.json'), '{"secret":"revoked-on-restart"}');
      await hub.close();
      old.status = 'running'; agent.status = 'running';
      await atomicJson(path.join(home, 'runs', old.id, 'run.json'), old);
      const recovered = await startHub({ home, config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: { available: false, capabilities: {} }, codex: fake } });
      try {
        await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('orphan survived recovery')), 3000).unref())]);
        assert.equal(recovered.manager.get(old.id).status, 'interrupted');
        assert.equal(recovered.manager.get(old.id).agents[0].status, 'cancelled');
        assert.equal(await readJson(path.join(home, 'runs', old.id, 'agents', agent.id, 'mcp.json')), undefined);
      } finally { await recovered.close(); }
    } finally { if (orphan.exitCode === null) orphan.kill(); }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('terminal team observation waits for durable idle release and reservation cleanup', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-finalize-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex';
  config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4; config.scheduler.codex.maxConcurrent = 3;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminating = new Promise<void>(resolve => { entered = resolve; });
  try {
    const started = await hub.manager.start({ cwd, script: meta + 'const t=await spawnTeam([{name:"idle",prompt:"ready"}],{releaseIdleAfterMs:0}); return await t.untilDone(undefined,{maxMs:10000});' });
    const execution = hub.manager.active.get(started.runId)!;
    const terminate = execution.bus.terminate.bind(execution.bus);
    execution.bus.terminate = async name => { entered(); await gate; return terminate(name); };
    await terminating;
    const response = await fetch(hub.manager.hubUrl + '/v1/orch/workflow_wait', { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ runId: started.runId, timeoutSec: 1, wakeOnMessage: false }) });
    const observed: any = await response.json();
    assert.equal(observed.status, 'running', JSON.stringify(observed));
    assert.equal(hub.manager.scheduler.snapshot().held.length, 1);
    release(); await execution.task;
    assert.equal(execution.run.status, 'completed');
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
  } finally { release(); await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('an orchestrator shim reaches a hub restarted on another port without failing a call', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-restart-'));
  const home = path.join(root, 'state');
  const backends = { claude: { available: false, capabilities: {} }, codex: { available: false, capabilities: {} } } as any;
  let hub = await startHub({ home, config: defaults(), cliEntry: path.resolve('dist/cli.js'), backends });
  try {
    const client = new HubClient(home, path.resolve('dist/cli.js'), 'orchestrator');
    await client.connect(false);
    const before = hub.port;
    await hub.close();
    hub = await startHub({ home, config: defaults(), cliEntry: path.resolve('dist/cli.js'), backends });
    assert.notEqual(hub.port, before);
    // The old port refuses the connection, so the POST never arrived: it is sent again to the new hub.
    assert.ok(Array.isArray((await client.tool('workflow_list', {})).runs));
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('on Windows a hub the shim starts is created outside the shim\'s process tree', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-launch-'));
  const home = path.join(root, 'state');
  const client = new HubClient(home, path.resolve('dist/cli.js'), 'orchestrator');
  await client.connect(true);
  try {
    // Created through WMI, so an app update or session exit that ends this process's job or tree leaves it running.
    const { pid } = (await readJson<{ pid: number }>(path.join(home, 'hub.json')))!;
    const parent = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId; (Get-CimInstance Win32_Process -Filter "ProcessId = $p").Name`]);
    assert.equal(parent.stdout.trim().toLowerCase(), 'wmiprvse.exe');
  } finally {
    await client.request('/v1/hub/shutdown', {}).catch(() => {});
    for (let i = 0; i < 100 && await readJson(path.join(home, 'hub.lock')); i++) await new Promise(r => setTimeout(r, 100));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
test('a shim that a hub of another version refuses still serves its tools, and each call says why', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-mismatch-'));
  const home = path.join(root, 'state'); await mkdir(home, { recursive: true });
  const { createServer } = await import('node:http');
  const older = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, version: '0.0.1' })); });
  await new Promise<void>(resolve => older.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(home, 'hub.json'), JSON.stringify({ pid: 1, port: (older.address() as any).port, version: '0.0.1' }));
  await writeFile(path.join(home, 'hub.token'), 'older-token');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !name.startsWith('STAMPEDE_'))) as Record<string, string>, STAMPEDE_HOME: home };
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'mismatch-fixture', version: '1' });
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), 'mcp', '--role', 'orchestrator'], env, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'workflow_run'));
    const called = await client.callTool({ name: 'workflow_list', arguments: {} });
    assert.equal(called.isError, true);
    const error = JSON.parse((called.content as { type: string; text: string }[])[0]!.text);
    assert.equal(error.code, 'version_mismatch');
    assert.match(error.error, /^blocked: hub version 0\.0\.1, shim version .+hub --restart --detach.+\/reload-plugins/);
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => older.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
test('a stopped older hub\'s descriptor does not block starting a hub; a live hub of another version still does', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-stale-'));
  const home = path.join(root, 'state'); await mkdir(home, { recursive: true });
  // A live hub of another version answers /health with its own version.
  const { createServer } = await import('node:http');
  const older = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, version: '0.0.1' })); });
  await new Promise<void>(resolve => older.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(home, 'hub.json'), JSON.stringify({ pid: 1, port: (older.address() as any).port, version: '0.0.1' }));
  await writeFile(path.join(home, 'hub.token'), 'older-token');
  const client = new HubClient(home, path.resolve('dist/cli.js'), 'orchestrator');
  await assert.rejects(client.connect(false), /blocked: hub version 0\.0\.1/);
  // Stopped, it leaves the same descriptor behind, which no longer stands for a hub: one is started.
  await new Promise(resolve => older.close(resolve));
  await client.connect(true);
  try { assert.notEqual((await readJson<{ version: string }>(path.join(home, 'hub.json')))!.version, '0.0.1'); }
  finally {
    await client.request('/v1/hub/shutdown', {}).catch(() => {});
    for (let i = 0; i < 100 && await readJson(path.join(home, 'hub.lock')); i++) await new Promise(r => setTimeout(r, 100));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
