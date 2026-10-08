import path from 'node:path';
import os from 'node:os';
import { readFile, readdir, rm, rmdir, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parse } from 'smol-toml';
import { atomicJson, readJson, Store } from './store.js';
import { defaults, loadConfig, settingsReport, validateConfig, VERSION, type Config } from './config.js';
import { capture, probeBackends } from './capabilities.js';
import { Security } from './security.js';
import { runTerminal, type Run } from './model.js';
import { git, repoMutex, type Workspace } from './workspaces.js';

export async function confirm(message: string, yes = false) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('interactive confirmation required; inspect the proposal and rerun with --yes');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await prompt.question(message + ' [y/N] ')).trim()); }
  finally { prompt.close(); }
}
export async function initialize(home: string, yes = false) {
  const configPath = path.join(home, 'config.json');
  if (await readJson(configPath)) throw new Error('config.json already exists; refusing to overwrite it');
  const seed = defaults();
  let user: any = {};
  try { user = parse(await readFile(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (typeof user.model === 'string') seed.codex.defaultModel = user.model;
  if (typeof user.model_reasoning_effort === 'string') seed.codex.defaultEffort = user.model_reasoning_effort;
  if (typeof user.windows?.sandbox === 'string') seed.codex.windowsSandbox = user.windows.sandbox;
  else if (process.platform === 'win32') {
    if (!process.stdin.isTTY) throw new Error('Codex has no Windows sandbox selection; choose elevated, unelevated or mxc interactively');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { seed.codex.windowsSandbox = (await prompt.question('Codex Windows sandbox implementation (elevated / unelevated / mxc): ')).trim(); }
    finally { prompt.close(); }
    if (!['elevated', 'unelevated', 'mxc'].includes(seed.codex.windowsSandbox)) throw new Error('invalid sandbox implementation');
  }
  process.stderr.write(`Create ${configPath}\nCodex model=${seed.codex.defaultModel}, effort=${seed.codex.defaultEffort}, Windows sandbox=${seed.codex.windowsSandbox}\n`);
  if (!await confirm('Write this configuration?', yes)) return { created: false };
  validateConfig(seed);
  const security = new Security();
  try { await security.start(home, seed.security.ancestryCheck); await atomicJson(configPath, seed); }
  finally { await security.close(); }
  return { created: true, doctor: await doctor(home) };
}
export async function doctor(home: string) {
  const config = await loadConfig(home);
  const security = new Security();
  let backends;
  try { await security.start(home, config.security.ancestryCheck); backends = await probeBackends(config, home); }
  finally { await security.close(); }
  const gitVersion = await capture('git', ['--version']).catch(error => ({ code: -1, stdout: '', stderr: error.message }));
  const descriptor = await readJson<{ port: number; version: string }>(path.join(home, 'hub.json'));
  let hub: unknown = { ok: false, error: 'hub not running' };
  if (descriptor) {
    try {
      const token = (await readFile(path.join(home, 'hub.token'), 'utf8')).trim();
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/orch/stampede_doctor`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      hub = { ok: response.ok, port: descriptor.port, ...await response.json() as object };
    } catch (error) { hub = { ok: false, error: (error as Error).message }; }
  }
  // config.json is read when the hub starts: a running hub with other settings needs a restart to take them.
  const settings = settingsReport(config), running = (hub as any)?.settings;
  if (running && JSON.stringify({ ...running, warnings: [] }) !== JSON.stringify({ ...settings, warnings: [] })) settings.warnings.push('the running hub has other settings than config.json: restart it, once no run is active, to apply them');
  const plugins = backends.claude.binary ? await capture(backends.claude.binary, ['plugin', 'list', '--json']).catch(() => undefined) : undefined;
  return { version: VERSION, settings, node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 22 }, home, security: { aclVerified: security.aclVerified, warnings: security.warnings }, git: gitVersion.code === 0 ? gitVersion.stdout.trim() : gitVersion.stderr, backends, hub,
    plugin: { installed: plugins?.code === 0 ? /"stampede@stampede"/.test(plugins.stdout) : null, connection: 'Use the Stampede MCP stampede_doctor tool to verify this session connects.' },
    windowsSandbox: { implementation: config.codex.windowsSandbox, ready: backends.codex.capabilities.workspaceWriteReady ?? null, error: backends.codex.capabilities.sandboxError } };
}
/** Remove only expired terminal run artifacts; worktrees always live elsewhere. */
export async function collectRuns(store: Store, config: Config, now = Date.now()) {
  const collected: string[] = [];
  for (const id of await store.runs()) {
    const directory = path.resolve(store.runDir(id));
    const root = path.resolve(store.home, 'runs');
    if (path.dirname(directory) !== root || (await lstat(directory)).isSymbolicLink()) throw new Error('unsafe run directory');
    const run = await readJson<Run>(path.join(directory, 'run.json'));
    if (!run || !runTerminal(run.status) || !run.endedAt || now - Date.parse(run.endedAt) < config.store.retentionDays * 86400000) continue;
    for (const item of await readdir(directory)) {
      if (config.store.keepSummaries && ['run.json', 'result.json'].includes(item)) continue;
      const target = path.resolve(directory, item);
      if (path.dirname(target) !== directory) throw new Error('unsafe artifact path');
      await rm(target, { recursive: true, force: true });
    }
    if (!config.store.keepSummaries) await rmdir(directory);
    collected.push(id);
  }
  return collected;
}
export async function collectWorktrees(store: Store, yes = false) {
  const worktrees: Workspace[] = [];
  for (const id of await store.runs()) {
    const run = await readJson<Run>(path.join(store.runDir(id), 'run.json'));
    if (!run || !runTerminal(run.status)) continue;
    for (const agent of run.agents) if (agent.workspace.kept && !worktrees.some(w => w.path === agent.workspace.path)) worktrees.push(agent.workspace);
  }
  const removed: string[] = [], kept: string[] = [];
  for (const workspace of worktrees) {
    if (!workspace.repo || !workspace.branch?.startsWith('stampede/')) throw new Error('invalid kept worktree metadata');
    const allowed = path.resolve(workspace.repo, '.stampede', 'worktrees');
    const target = path.resolve(workspace.path);
    if (!target.startsWith(allowed + path.sep)) throw new Error('worktree outside Stampede directory');
    const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error('refusing a worktree symlink');
    process.stderr.write(`${workspace.branch} ${target}\n`);
    if (!await confirm('Remove this worktree? Its branch will be kept.', yes)) { kept.push(target); continue; }
    await repoMutex(workspace.repo).run(async () => {
      if (await git(target, ['status', '--porcelain'])) throw new Error('worktree has uncommitted changes; commit or move them before removal');
      await git(workspace.repo!, ['worktree', 'remove', target]);
    });
    removed.push(target);
  }
  return { removed, kept };
}
