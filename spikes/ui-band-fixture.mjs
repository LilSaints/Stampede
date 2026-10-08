import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startHub } from '../dist/src/hub/server.js';
import { defaults } from '../dist/src/hub/config.js';

// Launch Claude with the printed owner as --session-id and this STAMPEDE_HOME.
// Automatic wakes are disabled by a zero hourly limit. Do not press Wake now:
// that explicitly submits a model prompt and is outside this free UI fixture.
const home = path.resolve(process.argv[2]);
const cwd = path.join(home, 'work'); await mkdir(cwd, { recursive: true });
const owner = randomUUID(), config = defaults();
config.defaultBackend = 'codex'; config.ui.maxWakesPerHour = 0;
config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6; config.scheduler.codex.maxConcurrent = 3;
const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), capabilities: {} };
const hub = await startHub({ home, config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
const active = await hub.manager.start({ cwd, orchestratorSessionId: owner, script: 'export const meta={name:"Active fixture",description:"band counts"}; return await agent("hang",{name:"worker"});' });
const second = await hub.manager.start({ cwd, orchestratorSessionId: owner, script: 'export const meta={name:"Compare fixture",description:"run tab switch"}; await new Promise(()=>{});' });
const completed = await hub.manager.start({ cwd, orchestratorSessionId: owner, script: 'export const meta={name:"Completed inbox",description:"unread after completion"}; return await agent("fixture:team-notice",{name:"messenger",comms:true});' });
await hub.manager.event(hub.manager.get(active.runId), 'backend.unavailable', { backend: 'codex', hint: 'Fixture auth alert — simulated, no login needed' });
const record = { home, owner, port: hub.port, runIds: [active.runId, second.runId, completed.runId], maxWakesPerHour: 0 };
await writeFile(path.join(home, 'fixture.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void hub.close().then(() => process.exit(0)); });
