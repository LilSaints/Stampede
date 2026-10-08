import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import type { BackendInfo } from '../../src/hub/capabilities.js';
import { atomicJson, readJson } from '../../src/hub/store.js';
const meta = 'export const meta = { name: "fixture", description: "integration" };\n';
test('authenticated hub runs concurrent scripts, resumes from cache, and persists terminal results', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stampede-hub-'));
  const config = defaults(); config.defaultBackend = 'codex'; config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home, config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: { available: false, error: 'fixture disabled', capabilities: {} }, codex: fake } });
  const base = `http://127.0.0.1:${hub.port}`;
  const call = async (name: string, input: unknown) => { const response = await fetch(base + '/v1/orch/' + name, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }); const result: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  try {
    assert.equal((await fetch(base + '/v1/ui/snapshot')).status, 401);
    const started = await call('workflow_run', { cwd: path.resolve('.'), script: meta + 'return await parallel([() => agent("one"), () => agent("two")]);', orchestratorSessionId: 'owner' });
    await call('workflow_wait', { runId: started.runId, timeoutSec: 10, orchestratorSessionId: 'observer' });
    const result = await call('workflow_result', { runId: started.runId });
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.deepEqual(result.result, ['one', 'two']);
    assert.equal(hub.manager.get(started.runId).seenSeq.owner, undefined);
    assert.ok(hub.manager.get(started.runId).seenSeq.observer > 0);
    const resumed = await call('workflow_resume', { runId: started.runId });
    await call('workflow_wait', { runId: resumed.runId, timeoutSec: 10 });
    assert.deepEqual((await call('workflow_result', { runId: resumed.runId })).result, ['one', 'two']);
    assert.equal(hub.manager.get(resumed.runId).cacheHits, 2);
    assert.equal(hub.manager.scheduler.snapshot().held.length, 0);
    const teamScript = meta + 'const team = await spawnTeam([{name:"a",prompt:"fixture:team-a"},{name:"b",prompt:"fixture:team-b"}]); await team.untilDone(undefined, {maxMs:10000}); return {results:await team.results(),board:await board()};';
    const teamRun = await call('workflow_run', { cwd: path.resolve('.'), script: teamScript });
    await call('workflow_wait', { runId: teamRun.runId, timeoutSec: 10, wakeOnMessage: false });
    const teamResult = await call('workflow_result', { runId: teamRun.runId });
    assert.equal(teamResult.status, 'completed', JSON.stringify(teamResult));
    assert.equal(teamResult.result.board.length, 2);
    const replayed = await call('workflow_resume', { runId: teamRun.runId });
    await call('workflow_wait', { runId: replayed.runId, timeoutSec: 10, wakeOnMessage: false });
    const replayResult = await call('workflow_result', { runId: replayed.runId });
    assert.deepEqual(replayResult.result.results, teamResult.result.results);
    assert.equal(hub.manager.get(replayed.runId).cacheHits, 2);
    assert.equal(hub.manager.get(replayed.runId).liveCalls, 0);
    assert.equal(replayResult.result.board.length, 2);
    assert.ok(replayResult.result.board.every((entry: any) => entry.replayedFrom === teamRun.runId));
    const changedArgs = await call('workflow_resume', { runId: teamRun.runId, args: { changed: true } });
    await call('workflow_wait', { runId: changedArgs.runId, timeoutSec: 10, wakeOnMessage: false });
    assert.equal(hub.manager.get(changedArgs.runId).cacheHits, 0);
    assert.equal(hub.manager.get(changedArgs.runId).liveCalls, 2);
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
  } finally { await hub.close(); await rm(home, { recursive: true, force: true }); }
});
