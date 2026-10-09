import { lstat, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Deleting for a worker, which its own sandbox may refuse (Codex rejects
 * recursive deletes as dangerous under approval_policy never). A worker may
 * delete only inside its own worktree, never the worktree itself or its .git,
 * and inside the scratch folders its call declared, those folders included.
 */
export interface CleanupRoot { path: string; allowRoot: boolean }
const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
/** Where `child` lies against `parent`: the folder itself, inside it, or outside. */
export function within(child: string, parent: string): 'root' | 'inside' | 'outside' {
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' ? 'root' : relative.startsWith('..') || path.isAbsolute(relative) ? 'outside' : 'inside';
}
const real = (p: string) => realpath(p).catch(() => undefined);

export async function cleanup(paths: unknown[], cwd: string, roots: CleanupRoot[]) {
  const removed: string[] = [], refused: { path: string; reason: string }[] = [];
  const resolvedRoots = (await Promise.all(roots.map(async root => ({ ...root, real: await real(root.path) })))).filter((root): root is CleanupRoot & { real: string } => Boolean(root.real));
  for (const input of paths.slice(0, 50)) {
    if (typeof input !== 'string' || !input.trim()) { refused.push({ path: String(input), reason: 'empty path' }); continue; }
    const target = path.resolve(cwd, input);
    // The folder holding it with every link resolved, so no link or junction above it leads outside.
    const parent = await real(path.dirname(target));
    if (!parent) { refused.push({ path: input, reason: 'not found' }); continue; }
    const resolved = path.join(parent, path.basename(target));
    const root = resolvedRoots.find(r => { const where = within(resolved, r.real); return where === 'inside' || where === 'root' && r.allowRoot; });
    if (!root) { refused.push({ path: input, reason: resolvedRoots.length ? 'outside your worktree and scratch folders' : 'you have no worktree or scratch folder to clean up' }); continue; }
    if (!root.allowRoot && fold(path.relative(root.real, resolved).split(path.sep)[0]!) === '.git') { refused.push({ path: input, reason: 'the worktree\'s .git is not yours to delete' }); continue; }
    const stat = await lstat(resolved).catch(() => undefined);
    if (!stat) { refused.push({ path: input, reason: 'not found' }); continue; }
    try {
      // A link or junction is removed itself, never what it points to.
      if (stat.isSymbolicLink()) await unlink(resolved);
      else await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
      removed.push(input);
    } catch (error) { refused.push({ path: input, reason: (error as Error).message }); }
  }
  return { removed, refused };
}

/**
 * A call's scratch folders, resolved against its workspace. None may be a
 * drive or filesystem root, nor hold (or be) a folder that must survive: the
 * user's home, Stampede's home, the run's checkout or the agent's workspace.
 */
export function scratchFolders(scratch: string[] | undefined, workspace: string, protect: string[]) {
  return (scratch ?? []).map(entry => {
    const folder = path.resolve(workspace, entry);
    if (path.parse(folder).root === folder) throw new Error(`scratch folder ${entry} is a filesystem root`);
    const kept = protect.find(p => within(p, folder) !== 'outside');
    if (kept) throw new Error(`scratch folder ${entry} would delete ${kept}`);
    return folder;
  });
}
