import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Security, type Identity } from '../../src/hub/security.js';

test('a killed live hub recovers workers and resumes cached calls with a fresh team', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede hub crash '));
  const home = path.join(root, 'state'), cwd = path.join(root, 'work'); await mkdir(cwd);
  const entry = path.join(root, 'hub fixture.mjs');
  await writeFile(entry, `import {startHub} from ${JSON.stringify(new URL('../../src/hub/server.js', import.meta.url).href)};
import {defaults} from ${JSON.stringify(new URL('../../src/hub/config.js', import.meta.url).href)};
const config=defaults(); config.defaultBackend='codex';
config.scheduler.maxConcurrent=4; config.scheduler.perRun=4; config.scheduler.claude.maxConcurrent=3; config.scheduler.codex.maxConcurrent=3;
const fake={available:true,binary:process.execPath,entry:process.argv[3],capabilities:{}};
const hub=await startHub({home:process.argv[2],config,cliEntry:process.argv[4],backends:{claude:fake,codex:fake}});
process.on('message',async message=>{if(message==='close'){await hub.close();process.exit(0);}});
process.send({port:hub.port});`);
  let child: ChildProcess | undefined, port = 0, token = '', stderr = '';
  const orphans: Identity[] = [];
  const start = async () => {
    stderr = '';
    child = fork(entry, [home, path.resolve('test/fake-backends/cli.mjs'), path.resolve('dist/cli.js')], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const running = child;
    const ready = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hub startup timed out: ${stderr}`)), 15000);
      const exited = (code: number | null) => { clearTimeout(timer); reject(new Error(`hub exited ${code}: ${stderr}`)); };
      running.once('exit', exited);
      running.once('error', reject);
      running.once('message', value => { clearTimeout(timer); running.off('exit', exited); resolve(value); });
    });
    port = ready.port; token = (await readFile(path.join(home, 'hub.token'), 'utf8')).trim();
  };
  const call = async (name: string, input: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/orch/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const value: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const until = async (predicate: () => Promise<boolean>) => { const deadline = Date.now() + 15000; while (!await predicate()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 30)); } };
  const alive = async (pid: number) => {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false; }
      return true;
    } catch (error) { if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
  };
  try {
    await start();
    const script = 'export const meta={name:"crash recovery",description:"real process crash"}; const first=await agent("finished before crash",{name:"first"}); const team=await spawnTeam([{name:"a",backend:"claude",prompt:"fixture:recovery:a"},{name:"b",backend:"codex",prompt:"fixture:recovery:b"}]); await team.untilDone(undefined,{maxMs:30000}); return {first,results:await team.results()};';
    const run = await call('workflow_run', { cwd, script });
    await until(async () => {
      try { await Promise.all(['a', 'b'].map(name => readFile(path.join(cwd, '.stampede', `recovery-${name}.json`)))); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    });
    const before = await call('workflow_status', { runId: run.runId, verbose: true });
    assert.equal(before.agents.find((a: any) => a.name === 'first').status, 'done');
    const saved = JSON.parse(await readFile(path.join(home, 'runs', run.runId, 'run.json'), 'utf8'));
    for (const agent of saved.agents.filter((a: any) => a.name !== 'first')) orphans.push(JSON.parse(await readFile(path.join(home, 'runs', run.runId, 'agents', agent.id, 'pids.json'), 'utf8')));
    assert.equal(orphans.length, 2);
    assert.ok((await Promise.all(orphans.map(o => alive(o.pid)))).every(Boolean), 'both workers must be live before crashing the hub');
    const crashed = once(child!, 'exit'); child!.kill('SIGKILL'); await crashed;
    // Some Windows process hosts terminate descendants with the parent job.
    // Other hosts leave them alive; recovery must handle either outcome.
    t.diagnostic(`${(await Promise.all(orphans.map(o => alive(o.pid)))).filter(Boolean).length} of 2 workers survived the hub kill`);
    await start();
    assert.equal((await call('workflow_status', { runId: run.runId })).status, 'interrupted');
    await until(async () => (await Promise.all(orphans.map(o => alive(o.pid)))).every(value => !value));
    const resumed = await call('workflow_resume', { runId: run.runId });
    await call('workflow_wait', { runId: resumed.runId, timeoutSec: 20, wakeOnMessage: false });
    const result = await call('workflow_result', { runId: resumed.runId });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.cacheHits, 1); assert.equal(result.liveCalls, 2);
    assert.equal(result.result.first, 'finished before crash');
    assert.deepEqual(result.result.results, {
      a: { status: 'done', result: 'fixture:recovery:a', markedDone: true },
      b: { status: 'done', result: 'fixture:recovery:b', markedDone: true }
    });
  } finally {
    if (child?.connected && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.send('close'); await closed; }
    const security = new Security();
    try { await security.start(home, false); for (const orphan of orphans) await security.killVerified(orphan); }
    finally { await security.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
  }
});
