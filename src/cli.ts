import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, Store } from './hub/store.js';
import { stampedeHome, loadConfig, VERSION } from './hub/config.js';
const { values, positionals } = parseArgs({ allowPositionals: true, options: { role: { type: 'string' }, backend: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean' }, yes: { type: 'boolean' }, worktrees: { type: 'boolean' }, restart: { type: 'boolean' }, force: { type: 'boolean' } } });
const entry = path.resolve(process.argv[1]);
try {
  if (values.version) process.stdout.write(VERSION + '\n');
  else if (values.help || !positionals.length) process.stdout.write('Stampede: init [--yes] | doctor | gc [--worktrees] [--yes] | hub [--restart] [--force] | mcp --role orchestrator|agent | hook post-tool-use|stop --backend claude\n');
  else if (positionals[0] === 'hook') { const { hook } = await import('./hook/hook.js'); await hook(positionals[1], values.backend ?? 'claude'); }
  else if (positionals[0] === 'mcp') { if (!['agent', 'orchestrator'].includes(values.role ?? '')) throw new Error('--role agent|orchestrator required'); const { startShim } = await import('./mcp/shim.js'); await startShim(stampedeHome(), entry, values.role as 'agent' | 'orchestrator'); }
  else if (positionals[0] === 'hub') {
    const { startHub } = await import('./hub/server.js');
    const home = stampedeHome();
    if (values.restart) {
      const descriptor = await readJson<{ port: number }>(path.join(home, 'hub.json'));
      if (descriptor) {
        const token = (await readFile(path.join(home, 'hub.token'), 'utf8')).trim();
        let response: Response | undefined;
        try { response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/hub/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ force: values.force === true }), signal: AbortSignal.timeout(5000) }); }
        catch (error) { if (!(error as Error).message.includes('fetch failed')) throw error; }
        if (response && !response.ok) throw new Error((await response.json() as any).error);
        if (response) {
          const deadline = Date.now() + 30000;
          while (await readJson(path.join(home, 'hub.lock'))) {
            if (Date.now() > deadline) throw new Error('hub has not stopped within 30 seconds');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
    const hub = await startHub({ home, config: await loadConfig(home), cliEntry: entry }).catch(async error => {
      if (error.message !== 'hub already running') throw error;
      const { HubClient } = await import('./mcp/client.js');
      await new HubClient(home, entry, 'orchestrator').connect(false);
      return undefined;
    });
    if (!hub) process.exit(0);
    const stop = () => { void hub.close().then(() => process.exit(0), error => { process.stderr.write(error.message + '\n'); process.exit(1); }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.stderr.write(`Stampede ${VERSION} listening on 127.0.0.1:${hub.port}\n`);
  } else if (['doctor', 'init', 'gc'].includes(positionals[0])) {
    const { doctor, initialize, collectRuns, collectWorktrees } = await import('./hub/maintenance.js');
    const home = stampedeHome();
    const result = positionals[0] === 'doctor' ? await doctor(home) : positionals[0] === 'init' ? await initialize(home, values.yes) : values.worktrees ? await collectWorktrees(new Store(home), values.yes) : { collected: await collectRuns(new Store(home), await loadConfig(home)) };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else throw new Error('unknown command');
} catch (error) { process.stderr.write(`stampede: ${(error as Error).message}\n`); process.exitCode = 1; }
