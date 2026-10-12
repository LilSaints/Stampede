import { mkdir, readFile, appendFile, readdir, stat, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { capture } from './capabilities.js';
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
}
const mutexes = new Map<string, Mutex>();
export function repoMutex(cwd: string) { const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd; if (!mutexes.has(key)) mutexes.set(key, new Mutex()); return mutexes.get(key)!; }
export async function git(cwd: string, args: string[]) { const result = await capture('git', args, cwd); if (result.code !== 0) throw new Error(result.stderr.trim() || 'git failed'); return result.stdout.trim(); }
export async function repoRoot(cwd: string) { try { return await git(cwd, ['rev-parse', '--show-toplevel']); } catch { return undefined; } }
/**
 * `rootBaseCommit` and `chain`: where a chain of baseRef agents began, and their names from its first agent to this one.
 * `releasedAt`: when workflow_control release removed the kept worktree (`kept` is then false; branch and commit stay);
 * `branchDeletedAt`: when it deleted the branch, whose work was in the checkout's HEAD.
 */
export interface Workspace { kind: 'shared' | 'worktree'; path: string; repo?: string; branch?: string; baseCommit?: string; rootBaseCommit?: string; chain?: string[]; commit?: string; kept?: boolean; releasedAt?: string; branchDeletedAt?: string }
/** A git ref's commit in the repository holding `cwd`; a worktree problem, not a backend's, when it has none. */
export async function resolveCommit(cwd: string, ref: string) {
  const repo = await repoRoot(cwd);
  if (!repo) throw Object.assign(new Error("isolation 'worktree' requires a git repository"), { kind: 'workspace' });
  try { return await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]); }
  catch { throw Object.assign(new Error(`baseRef ${ref} names no commit in ${repo}`), { kind: 'workspace' }); }
}
export async function createWorkspace(cwd: string, runId: string, name: string, base?: string): Promise<Workspace> {
  const repo = await repoRoot(cwd); if (!repo) throw new Error("isolation 'worktree' requires a git repository");
  return repoMutex(repo).run(async () => {
    const short = runId.slice(-10).toLowerCase();
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('invalid agent name');
    const branch = `stampede/${short}/${name}`;
    const location = path.join(repo, '.stampede', 'worktrees', short, name);
    // The checkout's HEAD, or the commit another agent's work ended at (baseRef).
    const baseCommit = base ?? await git(repo, ['rev-parse', 'HEAD']);
    const gitDir = await git(repo, ['rev-parse', '--git-common-dir']);
    const exclude = path.resolve(repo, gitDir, 'info', 'exclude');
    await mkdir(path.dirname(exclude), { recursive: true });
    let existing = ''; try { existing = await readFile(exclude, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!existing.split(/\r?\n/).includes('.stampede/')) await appendFile(exclude, '\n.stampede/\n');
    await mkdir(path.dirname(location), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, location, baseCommit]);
    return { kind: 'worktree', path: location, repo, branch, baseCommit };
  });
}
/**
 * Removes a clean worktree. A path past Windows' 260 characters needs
 * core.longpaths, and a file another process still holds may be let go: it
 * retries, then deletes the folder and prunes git's record of it. A worktree
 * git refuses (locked, changed, with submodules) is never deleted.
 */
export async function removeWorktree(repo: string, target: string) {
  let failure!: Error;
  for (const wait of [0, 250, 1000]) {
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    try { await git(repo, ['-c', 'core.longpaths=true', 'worktree', 'remove', target]); return; } catch (error) { failure = error as Error; }
    if (/locked|--force|-f -f|submodule/i.test(failure.message)) throw failure;
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => { throw failure; });
  await git(repo, ['worktree', 'prune']);
}
export async function finishWorkspace(workspace: Workspace, name: string, snapshot: boolean, note?: (message: string) => Promise<void>) {
  if (workspace.kind !== 'worktree' || !workspace.repo) return workspace;
  return repoMutex(workspace.repo).run(async () => {
    let dirty = await git(workspace.path, ['status', '--porcelain']);
    if (dirty && snapshot) {
      await git(workspace.path, ['add', '-A']);
      await git(workspace.path, ['-c', 'core.hooksPath=', 'commit', '-m', `stampede: snapshot of ${name} at done`]);
      dirty = await git(workspace.path, ['status', '--porcelain']);
    }
    workspace.commit = await git(workspace.path, ['rev-parse', 'HEAD']);
    workspace.kept = Boolean(dirty) || workspace.commit !== workspace.baseCommit;
    // An unkept branch holds nothing past its base; a base from another agent's
    // branch (baseRef) is not merged into the checkout, so -d would refuse it.
    // One git cannot remove is kept, and the run log says why: the agent's work is done all the same.
    const reason = (error: unknown) => (error as Error).message.split(/\r?\n/)[0]!.replace(/^fatal: /, '');
    if (!workspace.kept) {
      try { await removeWorktree(workspace.repo!, workspace.path); }
      catch (error) { workspace.kept = true; await note?.(`${name}: kept its worktree ${workspace.path}, which git could not remove (${reason(error)}); workflow_control release removes it later`); return workspace; }
      await git(workspace.repo!, ['branch', '-D', workspace.branch!]).catch(error => note?.(`${name}: kept branch ${workspace.branch}, which git could not delete (${reason(error)})`));
    }
    return workspace;
  });
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v ?? null)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
interface Fingerprint { cacheable: boolean; workspace: string; cacheInputs: Record<string, string>; reason?: string }
export type FingerprintMemo = Map<string, { expiresAt: number; generation: string; value: Fingerprint }>;
const fingerprintGenerations = new Map<string, number>();
let fullAccessGeneration = 0;
const scopeKey = (location: string) => process.platform === 'win32' ? path.resolve(location).toLowerCase() : path.resolve(location);
export async function invalidateFingerprint(cwd: string, fullAccess = false) {
  if (fullAccess) { fullAccessGeneration++; return; }
  const scope = await repoRoot(cwd) ?? cwd;
  await repoMutex(scope).run(async () => { const key = scopeKey(scope); fingerprintGenerations.set(key, (fingerprintGenerations.get(key) ?? 0) + 1); });
}
export async function fingerprint(cwd: string, isolation: 'shared' | 'worktree', inputs: string[], limits: { maxFingerprintFiles: number; maxFingerprintBytes: number; fingerprintTtlMs?: number }, memo?: FingerprintMemo): Promise<Fingerprint> {
  const repo = await repoRoot(cwd);
  return repoMutex(repo ?? cwd).run(async () => {
    const key = canonical({ cwd: scopeKey(cwd), isolation, inputs, files: limits.maxFingerprintFiles, bytes: limits.maxFingerprintBytes, ttl: limits.fingerprintTtlMs ?? 0 });
    const generation = `${fullAccessGeneration}:${fingerprintGenerations.get(scopeKey(repo ?? cwd)) ?? 0}`;
    const hit = memo?.get(key);
    if (hit && hit.generation === generation && hit.expiresAt > Date.now()) return hit.value;
    let files = 0, bytes = 0;
    async function fileHash(file: string): Promise<string> {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('fingerprint cannot follow symbolic links');
      if (info.isDirectory()) {
        const rows = [];
        for (const name of (await readdir(file)).sort()) if (!['.git', 'node_modules', '.stampede'].includes(name)) rows.push([name, await fileHash(path.join(file, name))]);
        return hash(canonical(rows));
      }
      if (!info.isFile()) throw new Error('fingerprint requires regular files');
      files++; bytes += info.size;
      if (files > limits.maxFingerprintFiles || bytes > limits.maxFingerprintBytes) throw new Error('workspace exceeds fingerprint limits');
      return hash(await readFile(file));
    }
    const value: Fingerprint = await (async () => { try {
      let workspace: string;
      if (repo) {
        const head = await git(repo, ['rev-parse', 'HEAD']);
        if (isolation === 'worktree') workspace = head;
        else {
          const diffResult = await capture('git', ['diff', '--binary', 'HEAD'], repo);
          const untrackedResult = await capture('git', ['ls-files', '--others', '--exclude-standard', '-z'], repo);
          if (diffResult.code !== 0 || untrackedResult.code !== 0) throw new Error('cannot fingerprint git workspace');
          const diff = diffResult.stdout;
          const untracked = untrackedResult.stdout.split('\0').filter(Boolean).sort();
          const rows = [];
          for (const file of untracked) rows.push([file, await fileHash(path.join(repo, file))]);
          workspace = hash(canonical({ head, diff: hash(diff), untracked: rows }));
        }
      } else workspace = await fileHash(cwd);
      const extra: Record<string, string> = {};
      for (const file of inputs) extra[file] = await fileHash(path.resolve(cwd, file));
      return { cacheable: true, workspace, cacheInputs: extra };
    } catch (error) { return { cacheable: false, reason: (error as Error).message, workspace: '', cacheInputs: {} }; } })();
    if (memo && (limits.fingerprintTtlMs ?? 0) > 0) {
      for (const [oldKey, entry] of memo) if (entry.expiresAt <= Date.now()) memo.delete(oldKey);
      memo.set(key, { generation, expiresAt: Date.now() + limits.fingerprintTtlMs!, value });
    }
    return value;
  });
}
