import { mkdir, readFile, appendFile, readdir, stat, lstat } from 'node:fs/promises';
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
export interface Workspace { kind: 'shared' | 'worktree'; path: string; repo?: string; branch?: string; baseCommit?: string; commit?: string; kept?: boolean }
export async function createWorkspace(cwd: string, runId: string, name: string): Promise<Workspace> {
  const repo = await repoRoot(cwd); if (!repo) throw new Error("isolation 'worktree' requires a git repository");
  return repoMutex(repo).run(async () => {
    const short = runId.slice(-10).toLowerCase();
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('invalid agent name');
    const branch = `stampede/${short}/${name}`;
    const location = path.join(repo, '.stampede', 'worktrees', short, name);
    const baseCommit = await git(repo, ['rev-parse', 'HEAD']);
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
export async function finishWorkspace(workspace: Workspace, name: string, snapshot: boolean) {
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
    if (!workspace.kept) { await git(workspace.repo!, ['worktree', 'remove', workspace.path]); await git(workspace.repo!, ['branch', '-d', workspace.branch!]); }
    return workspace;
  });
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v ?? null)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function fingerprint(cwd: string, isolation: 'shared' | 'worktree', inputs: string[], limits: { maxFingerprintFiles: number; maxFingerprintBytes: number }) {
  const repo = await repoRoot(cwd);
  return repoMutex(repo ?? cwd).run(async () => {
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
    try {
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
    } catch (error) { return { cacheable: false, reason: (error as Error).message, workspace: '', cacheInputs: {} }; }
  });
}
