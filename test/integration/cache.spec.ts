import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import { git } from '../../src/hub/workspaces.js';

const meta = 'export const meta={name:"cache validity",description:"real worker cache boundaries"};\n';
test('resume verifies files, explicit inputs, kept branches, edit effects and board taint', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-cache-'));
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  await git(cwd, ['init']); await git(cwd, ['config', 'user.name', 'Stampede fixture']);
  await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'reviewed.txt'), 'original\n');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'fixture']);
  const config = defaults(); config.defaultBackend = 'codex';
  config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4; config.scheduler.codex.maxConcurrent = 3;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
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

    const shared = await start('return await agent("fixture:edit",{access:"edit",isolation:"shared"});');
    const sharedRepeat = await resume(shared.id); assert.equal(sharedRepeat.cacheHits, 0); assert.equal(sharedRepeat.liveCalls, 1);
    const board = await start('return await agent("fixture:read-board",{comms:true});');
    const boardRepeat = await resume(board.id); assert.equal(boardRepeat.cacheHits, 0); assert.equal(boardRepeat.liveCalls, 1);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
