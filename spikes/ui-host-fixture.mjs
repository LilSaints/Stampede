import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startHub } from '../dist/src/hub/server.js';
import { defaults } from '../dist/src/hub/config.js';

// Real hub and UI, fake workers: no login or model usage. Point the host's
// STAMPEDE_HOME at the printed home and open /stampede. Cancel ends the fixture.
const home = path.resolve(process.argv[2] ?? `spikes/artifacts/ui-host-${Date.now()}`);
await mkdir(home, { recursive: true });
const config = defaults();
config.defaultBackend = 'codex';
config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
config.scheduler.codex.maxConcurrent = 3;
const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
const hub = await startHub({ home, config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: { available: false, capabilities: {} }, codex: fake } });
const run = await hub.manager.start({ cwd: path.resolve('.'), script: `export const meta={name:"UI acceptance",description:"Fake workers; no model usage",phases:[{title:"Review"}]};
await phase("Review");
const team=await spawnTeam([{name:"alpha",prompt:"idle"},{name:"beta",prompt:"idle"}]);
await team.untilQuiet({idleMs:0,maxMs:10000});
await log("Fixture ready: exercise pause, retry, send, skip and cancel.");
await new Promise(()=>{});` });
const record = { home, port: hub.port, runId: run.runId };
await writeFile(path.join(home, 'fixture.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void hub.close().then(() => process.exit(0)); });
