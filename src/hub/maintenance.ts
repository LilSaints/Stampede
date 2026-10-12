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
import { git, removeWorktree, repoMutex, type Workspace } from './workspaces.js';

export async function confirm(message: string, yes = false) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('interactive confirmation required; inspect the proposal and rerun with --yes');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await prompt.question(message + ' [y/N] ')).trim()); }
  finally { prompt.close(); }
}
/** One line of the user's input, asked on the terminal: init asks through it only where there is one. */
type Ask = (question: string) => Promise<string>;
const terminalAsk = (): Ask | undefined => process.stdin.isTTY ? async question => {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return await prompt.question(question); } finally { prompt.close(); }
} : undefined;
/** The test command of the project in `cwd`, as a claude.editShellAllow rule, from the files that name its toolchain. */
export async function suggestedTestCommand(cwd: string) {
  const names = await readdir(cwd).catch(() => [] as string[]);
  const has = (name: string) => names.includes(name);
  return has('package.json') ? 'Bash(npm test)' : has('Cargo.toml') ? 'Bash(cargo test)' : has('go.mod') ? 'Bash(go test ./...)'
    : names.some(name => /\.(sln|csproj|fsproj)$/i.test(name)) ? 'Bash(dotnet test)' : has('pytest.ini') || has('pyproject.toml') ? 'Bash(pytest)' : undefined;
}
/** Rules separated by commas outside their parentheses; a bare command is taken as `Bash(<command>)`. */
function shellRules(answer: string) {
  const rules: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i <= answer.length; i++) {
    const char = answer[i];
    if (char === '(') depth++; else if (char === ')') depth = Math.max(0, depth - 1);
    else if (i === answer.length || char === ',' && !depth) { const rule = answer.slice(start, i).trim(); if (rule) rules.push(/^[A-Za-z]+\(.*\)$/.test(rule) ? rule : `Bash(${rule})`); start = i + 1; }
  }
  return rules;
}
/**
 * claude.editShellAllow for a new configuration. It stays empty unless the
 * user, asked on a terminal, allows commands: any of them makes Claude edit
 * agents user-trusted (an edit agent can change what the command runs), so
 * `--yes` or no terminal never opts in. An entry the hub would refuse is asked again.
 */
export async function initialShellAllow(seed: Config, cwd: string, ask: Ask | undefined) {
  if (!ask) return [];
  const suggestion = await suggestedTestCommand(cwd);
  let question = 'Claude workers get no shell unless you allow commands (claude.editShellAllow). An allowed command runs code the project defines, and an edit agent can change that code before running it, so allowing any makes Claude edit agents, and read-only ones with shell: true, as trusted as you are.\n'
    + (suggestion ? `Allow ${suggestion}? y to allow it, other rules separated by commas, or Enter for none: ` : 'Commands to allow, as rules such as Bash(npm test) separated by commas, or Enter for none: ');
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await ask(question)).trim();
    if (!answer || /^(?:n|no|none)$/i.test(answer)) return [];
    const rules = suggestion && /^y(?:es)?$/i.test(answer) ? [suggestion] : shellRules(answer);
    try { validateConfig({ ...seed, claude: { ...seed.claude, editShellAllow: rules } }); return rules; }
    catch (error) { question = `${(error as Error).message}. Rules again, or Enter for none: `; }
  }
  return [];
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
  seed.claude.editShellAllow = await initialShellAllow(seed, process.cwd(), yes ? undefined : terminalAsk());
  process.stderr.write(`Create ${configPath}\nCodex model=${seed.codex.defaultModel}, effort=${seed.codex.defaultEffort}, Windows sandbox=${seed.codex.windowsSandbox}\nClaude shell commands: ${seed.claude.editShellAllow.join(', ') || 'none (add rules to claude.editShellAllow later to let Claude agents build and test)'}\n`);
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
const fold = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
/** A kept worktree's metadata as Stampede writes it: a stampede/ branch, in its repository's .stampede/worktrees. */
const ownWorktree = (w: Workspace) => Boolean(w.repo && w.branch?.startsWith('stampede/')) && path.resolve(w.path).startsWith(path.resolve(w.repo!, '.stampede', 'worktrees') + path.sep);
const gitReason = (error: unknown) => (error as Error).message.split(/\r?\n/)[0]!.replace(/^fatal: /, '');
/**
 * Whether a branch's work is in the checkout's HEAD: its commits are, or
 * merging it would change nothing (it was squash-merged or applied).
 */
async function landed(repo: string, branch: string) {
  if ((await capture('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], repo)).code === 0) return true;
  const merged = await capture('git', ['merge-tree', '--write-tree', 'HEAD', branch], repo);
  return merged.code === 0 && merged.stdout.split(/\r?\n/)[0] === await git(repo, ['rev-parse', 'HEAD^{tree}']);
}
/**
 * The kept worktrees of finished runs, removed for the orchestrator
 * (workflow_control release). One with uncommitted changes, used by an active
 * run or that git refuses stays and says why; its branch always stays. With
 * `branches`, a released worktree's branch whose work is in its checkout's
 * HEAD is deleted, and an unmerged one stays. Each worktree's record, in
 * `runs` and in every finished run of `known` that shares it, says so:
 * `kept: false` and `releasedAt`, then `branchDeletedAt`, stamped `at`.
 */
export async function releaseWorktrees(runs: Run[], options: { branches?: boolean; active?: Run[]; known?: Run[]; at?: string } = {}) {
  const removed: { runId: string; agent: string; branch?: string }[] = [], kept: { runId: string; agent: string; branch?: string; worktree?: string; reason: string }[] = [], branchesDeleted: string[] = [];
  const at = options.at ?? new Date().toISOString();
  const inUse = new Map((options.active ?? []).flatMap(run => run.agents.filter(a => a.workspace.kind === 'worktree').map(a => [fold(a.workspace.path), run.id] as const)));
  // A resumed run's cache hit shares its earlier run's worktree: each is released once, and every record of it is marked.
  const records = (w: Workspace) => [...runs, ...options.known ?? []].flatMap(run => run.agents.map(a => a.workspace)).filter(r => r.kind === 'worktree' && fold(r.path) === fold(w.path));
  const seen = new Set<string>();
  for (const run of runs) for (const agent of run.agents) {
    const w = agent.workspace, entry = { runId: run.id, agent: agent.name, branch: w.branch };
    if (w.kind !== 'worktree' || !(w.kept || w.releasedAt) || seen.has(fold(w.path))) continue;
    seen.add(fold(w.path));
    const user = inUse.get(fold(w.path));
    // One released before still has a branch for deleteMergedBranches to look at.
    const refused = w.releasedAt ? undefined : !ownWorktree(w) ? 'not a Stampede worktree' : user ? `used by active run ${user}` : await repoMutex(w.repo!).run(async () => {
      const info = await lstat(w.path).catch(() => undefined);
      if (info?.isSymbolicLink()) return 'a symbolic link';
      if (info && await git(w.path, ['status', '--porcelain'])) return 'uncommitted changes';
      // One already gone (gc, by hand) leaves only git's record of it.
      if (info) { await removeWorktree(w.repo!, w.path); removed.push(entry); } else await git(w.repo!, ['worktree', 'prune']);
    }).catch(gitReason);
    if (refused) { kept.push({ ...entry, worktree: w.path, reason: refused }); continue; }
    if (!w.releasedAt) for (const record of records(w)) Object.assign(record, { kept: false, releasedAt: at });
    if (!options.branches || w.branchDeletedAt) continue;
    const unmerged = await repoMutex(w.repo!).run(async () => {
      if ((await capture('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`], w.repo!)).code === 0) {
        if (!await landed(w.repo!, w.branch!)) return 'unmerged';
        await git(w.repo!, ['branch', '-D', w.branch!]); branchesDeleted.push(w.branch!);
      }
      for (const record of records(w)) record.branchDeletedAt = at;
    }).catch(gitReason);
    if (unmerged) kept.push({ ...entry, reason: unmerged });
  }
  return { removed, kept, ...(options.branches ? { branchesDeleted } : {}) };
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
      await removeWorktree(workspace.repo!, target);
    });
    removed.push(target);
  }
  return { removed, kept };
}
