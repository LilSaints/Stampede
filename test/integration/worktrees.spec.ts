import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import type { BackendInfo } from '../../src/hub/capabilities.js';
import { git } from '../../src/hub/workspaces.js';
import { claudeRulePath } from '../../src/backends/claude.js';
import { readJson } from '../../src/hub/store.js';

const meta = 'export const meta = { name: "worktrees", description: "kept worktrees" };\n';
const exists = (file: string) => access(file).then(() => true, () => false);

test('a coder/fixer chain lands as one range, finished runs release their worktrees, and one git cannot remove at agent end is kept', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-worktrees-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  await git(cwd, ['init']); await git(cwd, ['config', 'user.name', 'Stampede fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'input.txt'), 'base'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'fixture']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config: defaults(), cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
  const orch = async (name: string, input: unknown) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/v1/orch/${name}`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { ok: response.ok, value: await response.json() as any };
  };
  const run = async (script: string) => { const { runId } = await hub.manager.start({ cwd, script: meta + script }); await hub.manager.active.get(runId)?.task; return hub.manager.get(runId); };
  try {
    // The fixer starts at the coder's commit, so its branch holds both changes: rootBaseCommit..commit is the whole of it.
    const chain = await run(`
await agent("fixture:write:coder.txt", { name: "coder", backend: "codex", access: "edit" });
await agent("fixture:write:fixer.txt", { name: "fixer", backend: "codex", access: "edit", baseRef: { agent: "coder" } });
return { coder: await workspace("coder"), fixer: await workspace("fixer") };`);
    assert.equal(chain.status, 'completed', JSON.stringify(chain.error));
    const { coder, fixer } = chain.result as any;
    assert.equal(coder.baseCommit, head); assert.equal(coder.rootBaseCommit, head); assert.deepEqual(coder.chain, ['coder']);
    assert.equal(fixer.baseCommit, coder.commit); assert.equal(fixer.rootBaseCommit, head); assert.deepEqual(fixer.chain, ['coder', 'fixer']);
    assert.deepEqual((await git(cwd, ['diff', '--name-only', `${fixer.rootBaseCommit}..${fixer.commit}`])).split(/\r?\n/).sort(), ['coder.txt', 'fixer.txt']);
    const effects = (await orch('workflow_result', { runId: chain.id })).value.effects;
    assert.deepEqual(effects.map((e: any) => [e.name, e.rootBaseCommit, e.chain]), [['coder', head, ['coder']], ['fixer', head, ['coder', 'fixer']]]);
    // A resume replays the chain from the cache, sharing its worktrees.
    const again = await hub.manager.resume(chain.id, {}); await hub.manager.active.get(again.runId)?.task;
    assert.equal(hub.manager.get(again.runId).cacheHits, 2);

    // A worktree the hub cannot remove when its agent ends is kept with a note; the agent and run finish all the same.
    const locked = await run('return await agent("fixture:lock-worktree", { name: "locker", backend: "codex", access: "edit" });');
    const locker = locked.agents[0]!;
    assert.equal(locked.status, 'completed', JSON.stringify(locked.error));
    assert.equal(locker.status, 'done'); assert.equal(locked.result, 'fixture:lock-worktree');
    assert.equal(locker.workspace.kept, true); assert.equal(await exists(locker.workspace.path), true);
    assert.ok(locked.log.some(line => line.startsWith(`locker: kept its worktree ${locker.workspace.path}, which git could not remove (cannot remove a locked working tree`)), locked.log.join('\n'));

    // Release takes finished runs only.
    const slow = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:slow", { name: "slow", backend: "codex" });' });
    const early = await orch('workflow_control', { action: 'release', runIds: [slow.runId] });
    assert.equal(early.ok, false); assert.match(early.value.error, /is not finished: release takes finished runs only/);
    await hub.manager.active.get(slow.runId)?.task;
    assert.match((await orch('workflow_control', { action: 'release' })).value.error, /release needs runIds/);

    // Two finished runs' kept worktrees are released through MCP; one with uncommitted changes stays, and so do all branches.
    const other = await run('await agent("fixture:write:other.txt", { name: "other", backend: "codex", access: "edit" }); await agent("fixture:write:messy.txt", { name: "messy", backend: "codex", access: "edit" }); return "ok";');
    const messy = other.agents.find(a => a.name === 'messy')!.workspace;
    await writeFile(path.join(messy.path, 'stray.txt'), 'uncommitted');
    const released = await orch('workflow_control', { action: 'release', runIds: [chain.id, other.id, locked.id] });
    assert.equal(released.ok, true, JSON.stringify(released.value));
    assert.deepEqual(released.value.removed.map((r: any) => [r.runId, r.agent]), [[chain.id, 'coder'], [chain.id, 'fixer'], [other.id, 'other']]);
    assert.deepEqual(released.value.kept.map((k: any) => [k.agent, k.reason.replace(/, lock reason.*/, '')]), [['messy', 'uncommitted changes'], ['locker', 'cannot remove a locked working tree']]);
    for (const agent of [...chain.agents, other.agents[0]!]) assert.equal(await exists(agent.workspace.path), false, agent.name);
    assert.equal(await exists(messy.path), true);
    assert.equal(released.value.branchesDeleted, undefined);
    assert.ok(await git(cwd, ['rev-parse', '--verify', fixer.branch]));
    // The release is recorded: no longer kept, since when, branch and commit as they were; in run.json, result.json and workflow_result.
    const stored = (await readJson<any>(path.join(root, 'state', 'runs', chain.id, 'run.json')))!.agents.find((a: any) => a.name === 'coder').workspace;
    assert.equal(stored.kept, false); assert.match(stored.releasedAt, /^\d{4}-\d\d-\d\dT/); assert.equal(stored.branch, coder.branch); assert.equal(stored.commit, coder.commit);
    const releasedEffects = (await orch('workflow_result', { runId: chain.id })).value.effects;
    assert.deepEqual(releasedEffects.map((e: any) => [e.name, e.kept, e.releasedAt, e.branch, e.commit]), [['coder', false, stored.releasedAt, coder.branch, coder.commit], ['fixer', false, stored.releasedAt, fixer.branch, fixer.commit]]);
    assert.deepEqual((await readJson<any>(path.join(root, 'state', 'runs', chain.id, 'result.json')))!.effects.map((e: any) => [e.name, e.kept, e.releasedAt]), [['coder', false, stored.releasedAt], ['fixer', false, stored.releasedAt]]);
    // So is the resumed run sharing those worktrees; a worktree kept back is not.
    assert.ok(hub.manager.get(again.runId).agents.every(a => a.workspace.kept === false && a.workspace.releasedAt === stored.releasedAt));
    assert.equal(messy.kept, true); assert.equal(messy.releasedAt, undefined);
    // A resume after the release replays the chain from the cache and records its worktrees as released.
    const later = await hub.manager.resume(chain.id, {}); await hub.manager.active.get(later.runId)?.task;
    assert.equal(hub.manager.get(later.runId).cacheHits, 2);
    assert.deepEqual([(hub.manager.get(later.runId).result as any).coder.kept, (hub.manager.get(later.runId).result as any).coder.releasedAt], [false, stored.releasedAt]);
    assert.deepEqual((await orch('workflow_result', { runId: later.runId })).value.effects.map((e: any) => [e.name, e.kept, e.releasedAt]), [['coder', false, stored.releasedAt], ['fixer', false, stored.releasedAt]]);

    // Landed work frees its branches: the fixer's squash-merged into the checkout covers the coder's too; the other's stays, unmerged.
    await git(cwd, ['merge', '--squash', fixer.branch]); await git(cwd, ['commit', '-m', 'land the chain']);
    await git(cwd, ['worktree', 'unlock', locker.workspace.path]);
    const pruned = await orch('workflow_control', { action: 'release', runIds: [chain.id, other.id, locked.id], deleteMergedBranches: true });
    assert.equal(pruned.ok, true, JSON.stringify(pruned.value));
    assert.deepEqual(pruned.value.removed.map((r: any) => r.agent), ['locker']);
    assert.deepEqual(pruned.value.branchesDeleted, [coder.branch, fixer.branch, locker.workspace.branch]);
    assert.deepEqual(pruned.value.kept.map((k: any) => [k.agent, k.reason, Boolean(k.worktree)]), [['other', 'unmerged', false], ['messy', 'uncommitted changes', true]]);
    assert.equal(await exists(locker.workspace.path), false);
    const deletedAt = hub.manager.get(chain.id).agents[0]!.workspace.branchDeletedAt;
    assert.ok(deletedAt);
    assert.ok((await readJson<any>(path.join(root, 'state', 'runs', chain.id, 'run.json')))!.agents.every((a: any) => a.workspace.branchDeletedAt === deletedAt));
    assert.ok([again.runId, later.runId].every(id => hub.manager.get(id).agents.every(a => a.workspace.branchDeletedAt === deletedAt)), 'every run sharing the branch records it deleted');
    assert.deepEqual([locker.workspace.kept, Boolean(locker.workspace.releasedAt), Boolean(locker.workspace.branchDeletedAt)], [false, true, true]);
    assert.equal(other.agents[0]!.workspace.branchDeletedAt, undefined, 'an unmerged branch stays');
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('an agent\'s protected files end unchanged on its branch, and a read-only worker with a shell runs in a worktree thrown away at its end', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-protect-shell-'));
  const cwd = path.join(root, 'work'); await mkdir(path.join(cwd, 'docs'), { recursive: true });
  await git(cwd, ['init']); await git(cwd, ['config', 'user.name', 'Stampede fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'HANDOFF.md'), 'handoff'); await writeFile(path.join(cwd, 'docs', 'guide.md'), 'guide'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'fixture']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
  const config = defaults(); config.claude.editShellAllow = ['Bash(npm test)'];
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
  const run = async (script: string) => { const { runId } = await hub.manager.start({ cwd, script: meta + script }); await hub.manager.active.get(runId)?.task; return hub.manager.get(runId); };
  try {
    // A Codex coder told to keep off HANDOFF.md and docs/** changes them beside its own file: they are put back on its branch.
    const guarded = await run('await agent("fixture:write:HANDOFF.md|docs/new.md|notes.txt", { name: "coder", backend: "codex", access: "edit", protect: ["HANDOFF.md", "docs/**"] }); return await workspace("coder");');
    assert.equal(guarded.status, 'completed', JSON.stringify(guarded.error));
    const coder = guarded.result as any;
    assert.deepEqual(coder.restored, ['HANDOFF.md', 'docs/new.md']);
    assert.equal(await git(cwd, ['diff', '--name-only', `${head}..${coder.commit}`]), 'notes.txt');
    assert.equal(await git(cwd, ['show', `${coder.commit}:HANDOFF.md`]), 'handoff');
    assert.ok(guarded.log.includes('coder: changed protected files HANDOFF.md, docs/new.md, restored as at its base'), guarded.log.join('\n'));
    assert.deepEqual((await readJson<any>(path.join(hub.manager.store.runDir(guarded.id), 'result.json')))!.effects[0].restored, ['HANDOFF.md', 'docs/new.md']);
    // A Claude worker is also denied its file tools on them, and told.
    // Absolute from its worktree's root: a relative rule on a bare name would also match one in a subfolder.
    const launched = (await run('return { launch: JSON.parse(await agent("fixture:launch", { name: "guarded", backend: "claude", access: "edit", protect: ["HANDOFF.md", "docs/**"] })), worktree: await workspace("guarded") };')).result as any, claude = launched.launch;
    const root = claudeRulePath(launched.worktree.path);
    for (const rule of [`Edit(${root}/HANDOFF.md)`, `Write(${root}/HANDOFF.md)`, `Edit(${root}/docs/**)`, `Write(${root}/docs/**)`]) assert.ok(claude.settings.permissions.deny.includes(rule), rule);
    assert.match(claude.argv[claude.argv.indexOf('--append-system-prompt') + 1], /Do not change HANDOFF\.md, docs\/\*\*; when you finish, the hub puts any change to them back/);
    // A read-only tester with a shell gets the allowlisted commands, not plan mode; its worktree goes at its end, build output and all.
    const tested = await run(`
const launch = await agent("fixture:launch", { name: "tester", backend: "claude", access: "read-only", isolation: "worktree", shell: true });
await agent("fixture:write:dist/out.txt", { name: "builder", backend: "claude", access: "read-only", isolation: "worktree", shell: true });
return { launch: JSON.parse(launch), builder: await workspace("builder") };`);
    assert.equal(tested.status, 'completed', JSON.stringify(tested.error));
    const { launch, builder } = tested.result as any;
    assert.equal(launch.argv[launch.argv.indexOf('--permission-mode') + 1], 'default');
    const allowed = launch.argv.slice(launch.argv.indexOf('--allowedTools') + 1, launch.argv.indexOf('--disallowedTools')), denied = launch.argv.slice(launch.argv.indexOf('--disallowedTools') + 1);
    assert.ok(allowed.includes('Bash(npm test)')); assert.ok(denied.includes('Edit') && denied.includes('Write') && !denied.includes('Bash'), denied.join(' '));
    assert.match(launch.argv[launch.argv.indexOf('--append-system-prompt') + 1], /Your worktree is thrown away when you finish/);
    assert.equal(builder.kept, false); assert.equal(await exists(builder.path), false);
    assert.equal(await git(cwd, ['branch', '--list', builder.branch]), '');
    assert.ok(!tested.cacheReport?.notCacheable.some(entry => entry.label === 'builder'), 'a read-only shell worker stays cacheable');
    // What the options cannot do is refused.
    for (const [opts, error] of [
      ['{ backend: "codex", access: "read-only", isolation: "worktree", shell: true }', /shell is for Claude workers/],
      ['{ backend: "claude", access: "edit", shell: true }', /shell is for access 'read-only' with isolation 'worktree'/],
      ['{ backend: "claude", shell: true }', /shell needs isolation 'worktree'/],
      ['{ backend: "claude", tools: ["Bash"] }', /tools cannot include Bash: read-only access has no shell without shell: true/],
      ['{ backend: "claude", access: "edit", isolation: "shared", protect: ["HANDOFF.md"] }', /protect needs a worktree/],
      ['{ backend: "claude", access: "edit", protect: ["../outside.md"] }', /protect must be a list of at most 50 paths or globs/],
    ] as const) assert.match(String((await run(`return await agent("fixture:argv", ${opts});`)).error?.message), error, opts);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});
