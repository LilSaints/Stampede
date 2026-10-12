import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import { git } from '../../src/hub/workspaces.js';
import { readJournal } from '../../src/hub/store.js';

const meta = 'export const meta={name:"cache validity",description:"real worker cache boundaries"};\n';
test('resume verifies files, explicit inputs, kept branches, edit effects and board taint', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-cache-'));
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  await git(cwd, ['init']); await git(cwd, ['config', 'user.name', 'Stampede fixture']);
  await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'reviewed.txt'), 'original\n');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'fixture']);
  const config = defaults(); config.defaultBackend = 'codex'; config.allowFullAccess = true;
  config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4; config.scheduler.codex.maxConcurrent = 3;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { ...fake, entry: path.resolve('test/fake-backends/fake-claude.mjs'), version: '2.1.292' } } });
  const complete = async (started: { runId: string }) => {
    await hub.manager.active.get(started.runId)?.task;
    const run = hub.manager.get(started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.ok(run.agents.every(a => a.status === 'done'), JSON.stringify(run.agents.map(a => a.error)));
    return run;
  };
  const start = async (script: string) => complete(await hub.manager.start({ cwd, script: meta + script }));
  const resume = async (id: string, scriptPath?: string) => complete(await hub.manager.resume(id, { scriptPath }));
  try {
    const original = await start('return await parallel([()=>agent("review"),()=>agent("judge")]);');
    const identical = await resume(original.id); assert.equal(identical.cacheHits, 2); assert.equal(identical.liveCalls, 0);
    const changedScript = path.join(root, 'changed.js');
    await writeFile(changedScript, meta + 'return await parallel([()=>agent("review"),()=>agent("changed judge")]);');
    const changedPrompt = await resume(original.id, changedScript);
    assert.equal(changedPrompt.cacheHits, 1); assert.equal(changedPrompt.liveCalls, 1);
    await writeFile(path.join(cwd, 'reviewed.txt'), 'changed\n');
    const changedFile = await resume(original.id); assert.equal(changedFile.cacheHits, 0); assert.equal(changedFile.liveCalls, 2);

    await writeFile(path.join(root, 'extra.txt'), 'original');
    const explicit = await start('return await agent("review",{cacheInputs:["../extra.txt"]});');
    assert.equal((await resume(explicit.id)).cacheHits, 1);
    await writeFile(path.join(root, 'extra.txt'), 'changed');
    assert.equal((await resume(explicit.id)).liveCalls, 1);

    const edit = await start('return await agent("fixture:edit",{access:"edit",isolation:"worktree"});');
    const workspace = edit.agents[0].workspace;
    assert.equal(workspace.kept, true); assert.ok(workspace.commit);
    assert.equal((await resume(edit.id)).cacheHits, 1);
    await git(workspace.path, ['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'advance fixture branch']);
    const moved = await resume(edit.id); assert.equal(moved.cacheHits, 0); assert.equal(moved.liveCalls, 1);
    // A full-access agent is reused only when its call says its worktree commit is its one lasting effect, and that commit still stands.
    const full = await start('return await agent("fixture:edit",{access:"full"});');
    assert.equal((await resume(full.id)).cacheHits, 0);
    const committed = await start('return await agent("fixture:edit",{access:"full",cache:"commit"});');
    assert.equal((await resume(committed.id)).cacheHits, 1);
    await git(committed.agents[0].workspace.path, ['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'advance fixture branch']);
    assert.equal((await resume(committed.id)).cacheHits, 0);
    const refused = await hub.manager.start({ cwd, script: meta + 'return await agent("x",{cache:"commit"});' });
    await hub.manager.active.get(refused.runId)?.task;
    assert.match(hub.manager.get(refused.runId).error!.message, /cache 'commit' needs a worktree/);

    const shared = await start('return await agent("fixture:edit",{access:"edit",isolation:"shared"});');
    const sharedRepeat = await resume(shared.id); assert.equal(sharedRepeat.cacheHits, 0); assert.equal(sharedRepeat.liveCalls, 1);
    const board = await start('return await agent("fixture:read-board",{comms:true});');
    const boardRepeat = await resume(board.id); assert.equal(boardRepeat.cacheHits, 0); assert.equal(boardRepeat.liveCalls, 1);
    const boardJournal = await readJournal<any>(path.join(hub.manager.store.runDir(board.id), 'journal.jsonl'));
    assert.deepEqual(boardJournal[0].shared, { reads: ['read_board'], writes: [] });
    for (const backend of ['claude', 'codex']) {
      const external = await start(`return await agent("fixture:external",{backend:"${backend}"});`);
      const journal = await readJournal<any>(path.join(hub.manager.store.runDir(external.id), 'journal.jsonl'));
      assert.deepEqual(journal[0].externalTools, ['WebSearch', 'mcp__research__lookup']);
      assert.ok(!JSON.stringify(journal).includes('fixture-not-for-journal'));
      const hit = await resume(external.id);
      assert.equal(hit.cacheHits, 1); assert.equal(hit.liveCalls, 0);
      assert.deepEqual(hit.cacheReport?.cachedExternalTools, [{ label: external.agents[0].label, tools: ['WebSearch', 'mcp__research__lookup'] }]);
    }

    // A resumed run says why an agent it finished starts again.
    assert.match(changedPrompt.log.join('\n'), /codex-2: not replayed from run_\w+: changed: its prompt or options/);
    assert.deepEqual(changedPrompt.cacheReport?.misses?.map(m => m.label), ['codex-2']);
    // A worktree agent started from a given commit replays after other work lands on the checkout; one keyed by the checkout's commit starts again.
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    const based = await start(`return await agent("fixture:edit",{access:"edit",isolation:"worktree",baseRef:"${head}"});`);
    const floating = await start('return await agent("fixture:edit",{access:"edit",isolation:"worktree"});');
    await git(cwd, ['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'land other work']);
    assert.equal((await resume(based.id)).cacheHits, 1);
    const relaunched = await resume(floating.id); assert.equal(relaunched.cacheHits, 0);
    assert.match(relaunched.log.join('\n'), /not replayed from run_\w+: changed: the checkout's commit/);
    // A reviewer's call holds the commits of the worktrees it reads: a writer that ends elsewhere sends it again rather than replay a review of other code.
    const reviewed = await start('await agent("fixture:edit",{name:"writer",access:"edit",isolation:"worktree"}); return await agent("review",{name:"reader",readWorktrees:["writer"]});');
    assert.equal((await resume(reviewed.id)).cacheHits, 2);
    await git(reviewed.agents[0].workspace.path, ['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'advance writer']);
    // The writer's new snapshot commit differs from its first even within the same second.
    process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2001-01-01T00:00:00Z';
    try {
      const rewritten = await resume(reviewed.id); assert.equal(rewritten.cacheHits, 0);
      assert.match(rewritten.log.join('\n'), /reader: not replayed from run_\w+: changed: a worktree it reads/);
    } finally { delete process.env.GIT_AUTHOR_DATE; delete process.env.GIT_COMMITTER_DATE; }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('queued teams refresh workspace fingerprints after another run writes', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-queued-cache-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex';
  config.scheduler.maxConcurrent = 3; config.scheduler.perRun = 3; config.scheduler.codex.maxConcurrent = 3;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!check()) { if (Date.now() > deadline) throw new Error('queued fingerprint fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const holder = await hub.manager.start({ cwd, script: meta + 'await spawnTeam([{name:"hold-a",prompt:"idle"},{name:"hold-b",prompt:"idle"}]); await new Promise(()=>{});' });
    await until(() => hub.manager.get(holder.runId).agents.length === 2 && hub.manager.get(holder.runId).agents.every(a => a.status === 'idle'));
    const target = await hub.manager.start({ cwd, script: meta + 'const t=await spawnTeam([{name:"target",prompt:"fixture:team-target"}]); return await t.untilDone(undefined,{maxMs:20000});' });
    await until(() => hub.manager.scheduler.snapshot().queued.some(gang => gang.some(slot => slot.runId === target.runId)));
    const writer = await hub.manager.start({ cwd, script: meta + 'return await agent("fixture:edit",{access:"edit",isolation:"shared"});' });
    await hub.manager.active.get(writer.runId)!.task;
    assert.equal(hub.manager.get(writer.runId).agents[0].status, 'done');
    await hub.manager.control(holder.runId, 'cancel');
    await hub.manager.active.get(target.runId)!.task;
    assert.equal(hub.manager.get(target.runId).status, 'completed');
    const replay = await hub.manager.resume(target.runId, {});
    await hub.manager.active.get(replay.runId)!.task;
    assert.equal(hub.manager.get(replay.runId).cacheHits, 1);
    assert.equal(hub.manager.get(replay.runId).liveCalls, 0);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
