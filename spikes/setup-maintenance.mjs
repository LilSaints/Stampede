import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { capture } from '../dist/src/hub/capabilities.js';
import { workerEnv } from '../dist/src/backends/procs.js';
const home = path.resolve(process.argv[2] ?? `spikes/artifacts/setup-${Date.now()}`);
await mkdir(home, { recursive: true });
const entry = path.resolve('dist/cli.js'), env = workerEnv({ STAMPEDE_HOME: home });
const command = (...args) => capture(process.execPath, [entry, ...args], process.cwd(), env);
const results = {};
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hub(previousPid) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      const descriptor = JSON.parse(await readFile(path.join(home, 'hub.json'), 'utf8'));
      if (descriptor.pid === previousPid) { await delay(100); continue; }
      const token = (await readFile(path.join(home, 'hub.token'), 'utf8')).trim();
      const url = `http://127.0.0.1:${descriptor.port}`;
      if ((await fetch(url + '/health', { headers: { authorization: `Bearer ${token}` } })).ok) return { ...descriptor, token, url };
    } catch {}
    await delay(100);
  }
  throw new Error('fixture hub did not become healthy');
}
async function post(info, route, body) {
  const response = await fetch(info.url + route, { method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function start(...args) {
  const child = spawn(process.execPath, [entry, 'hub', ...args], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume(); children.push(child); return child;
}
let live;
try {
  const initialized = await command('init', '--yes');
  results.init = { code: initialized.code, created: (()=>{try{return JSON.parse(initialized.stdout).created}catch{return false}})(), error: initialized.code ? initialized.stderr.slice(-500) : undefined };
  if (!results.init.created) throw new Error('init failed');
  start(); live = await hub();
  results.duplicateStart = (await command('hub')).code === 0;
  const run = await post(live, '/v1/orch/workflow_run', { cwd: path.dirname(home), script: 'export const meta={name:"restart",description:"fixture"}; await new Promise(()=>{});' });
  const refused = await command('hub', '--restart');
  results.activeRestartRefused = refused.code !== 0 && refused.stderr.includes('active runs');
  const previous = live.pid; start('--restart', '--force'); live = await hub(previous);
  const recovered = JSON.parse(await readFile(path.join(home, 'runs', run.runId, 'run.json'), 'utf8'));
  results.forcedRestart = live.pid !== previous && recovered.status === 'interrupted';
  const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')); config.store.retentionDays = 0;
  await writeFile(path.join(home, 'config.json'), JSON.stringify(config));
  const gc = await command('gc');
  results.retention = gc.code === 0 && JSON.parse(gc.stdout).collected.includes(run.runId);
  results.passed = Object.values(results).every(v => typeof v !== 'boolean' || v);
} finally {
  if (live) await post(live, '/v1/hub/shutdown', { force: true }).catch(() => {});
  await delay(500);
  for (const child of children) if (child.exitCode === null) child.kill();
  await writeFile(path.join(home, 'probe-summary.json'), JSON.stringify(results, null, 2));
}
process.stdout.write(JSON.stringify(results) + '\n');
if (!results.passed) process.exitCode = 1;
