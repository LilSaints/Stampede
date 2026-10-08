// Opt-in remaining real-CLI scenarios from SPEC §24. Uses normal CLI login.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { startHub } from '../dist/src/hub/server.js';
import { defaults } from '../dist/src/hub/config.js';
if (process.env.STAMPEDE_E2E !== '1') throw new Error('Set STAMPEDE_E2E=1 to authorize real model calls.');
const output = path.resolve(process.argv[2] ?? `spikes/artifacts/v1-acceptance-${Date.now()}`);
const selected = process.argv[3] ?? 'all';
if (!['all', 'peer', 'resume', 'batch'].includes(selected)) throw new Error('scenario must be peer, resume, batch or all');
const cwd = path.join(output, 'workspace'); await mkdir(cwd, { recursive: true });
const config = defaults(); config.scheduler.maxConcurrent = 8; config.scheduler.perRun = 8;
config.scheduler.claude.maxConcurrent = 4; config.scheduler.codex.maxConcurrent = 4;
config.codex.defaultModel = 'gpt-6-luna'; config.codex.defaultEffort = 'low';
config.limits.claudeTurnMaxUsd = 0.5; config.limits.turnTimeoutMs = 120000; config.limits.teamMaxMs = 180000;
config.delivery.resumeDebounceMs = 100;
const hub = await startHub({ home: path.join(output, 'state'), config, cliEntry: path.resolve('dist/cli.js') });
const results = [];
const model = backend => ({ backend, model: backend === 'claude' ? 'haiku' : 'gpt-6-luna', effort: 'low' });
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const meta = 'export const meta={name:"V1 acceptance",description:"opt-in real CLI scenarios"};\n';
function peakActiveTurns(agents) {
  const edges = agents.flatMap(agent => agent.turns.flatMap(turn => [
    { at: Date.parse(turn.startedAt), delta: 1 }, { at: Date.parse(turn.endedAt), delta: -1 }
  ]));
  assert.ok(edges.every(edge => Number.isFinite(edge.at)), 'every turn needs start/end evidence');
  let active = 0, peak = 0;
  for (const edge of edges.sort((a, b) => a.at - b.at || a.delta - b.delta)) { active += edge.delta; peak = Math.max(peak, active); }
  return peak;
}
async function run(name, script, args, check, steer) {
  const started = await hub.manager.start({ cwd, script: meta + script, args });
  const execution = hub.manager.active.get(started.runId);
  try {
    if (steer) await steer(execution);
    await execution.task;
    assert.equal(execution.run.status, 'completed', JSON.stringify(execution.run.error));
    check(execution);
    results.push({ name, passed: true, runId: started.runId, result: execution.run.result, peakActiveTurns: peakActiveTurns(execution.run.agents),
      agents: execution.run.agents.map(a => ({ name: a.name, backend: a.backend, status: a.status, resumes: a.resumes, turns: a.turns.length, usage: a.usage })),
      deliveries: execution.bus.deliveries.map(d => ({ seq: d.seq, recipient: d.recipient, via: d.via, state: d.state, redelivered: d.redelivered })) });
  } catch (error) {
    results.push({ name, passed: false, runId: started.runId, error: error.message }); throw error;
  } finally {
    await writeFile(path.join(output, 'summary.json'), JSON.stringify({ results }, null, 2));
    process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
  }
}
try {
  if (selected === 'all' || selected === 'peer') {
    const resultSchema = schema({ sent: { type: 'integer' }, received: { type: 'integer' } });
    const members = ['claude', 'codex'].map((backend, i) => ({ ...model(backend), name: `peer-${i}`, schema: resultSchema,
      prompt: `Send exactly three messages to peer-${1 - i}, with text ping-1, ping-2 and ping-3. Then receive all three peer pings through read_messages or wait_for_message; also count messages injected in stampede-message envelopes. Do not count duplicates. ${backend === 'claude' ? 'To exercise hook delivery, before read_messages or wait_for_message, use list_agents as a non-consuming tool up to 12 times while waiting for injected peer envelopes. Stop polling once all three arrive. Count these injected messages as received.' : ''} After sending and receiving all three, call mark_done and return {"sent":3,"received":3}. Use only Stampede messaging tools. No delegation, shell or files.` }));
    await run('peer', 'const t=await spawnTeam(args.members); const observed=await t.untilDone(undefined,{maxMs:180000}); return {observed,results:await t.results()};', { members }, e => {
      assert.equal(e.run.result.observed.reason, 'all-terminal');
      for (const agent of e.run.agents) { assert.equal(agent.status, 'done'); assert.deepEqual(agent.result, { sent: 3, received: 3 }); }
      const deliveries = e.bus.deliveries.filter(d => d.recipient !== 'orchestrator');
      assert.equal(deliveries.length, 6); assert.ok(deliveries.every(d => d.state === 'committed'));
      for (let i = 0; i < 2; i++) {
        const messages = e.bus.messages.filter(message => message.from === `peer-${i}`);
        assert.deepEqual(messages.map(message => message.text).sort(), ['ping-1', 'ping-2', 'ping-3']);
        assert.ok(messages.every(message => message.to === `peer-${1 - i}`));
      }
      assert.ok(deliveries.some(delivery => delivery.recipient === 'peer-0' && delivery.via === 'hook'), 'Claude must receive a peer message through the mid-turn hook');
    });
  }
  if (selected === 'all' || selected === 'resume') {
    for (const backend of ['claude', 'codex']) {
      await run(`resume-${backend}`, 'const t=await spawnTeam([args.member]); return await t.untilDone(undefined,{maxMs:180000});', {
        member: { ...model(backend), name: 'sleeper', schema: schema({ stage: { type: 'integer' } }), prompt: 'Return {"stage":1} now. Do not call mark_done: a later message will request the final stage. Do not use any tools, shell or delegation this turn.' }
      }, e => {
        const agent = e.run.agents[0];
        assert.equal(agent.status, 'done'); assert.equal(agent.resumes, 1); assert.equal(agent.turns.length, 2); assert.deepEqual(agent.result, { stage: 2 });
        const session = agent.turns[0].outcome?.sessionId;
        assert.ok(session, 'initial turn must record a session ID');
        assert.equal(agent.turns[1].outcome?.sessionId, session, 'message-driven resume must retain the session');
      }, async e => {
        const deadline = Date.now() + 120000;
        while (e.run.agents[0]?.status !== 'idle') {
          if (Date.now() > deadline || ['failed', 'cancelled', 'completed'].includes(e.run.status)) throw new Error('initial idle turn did not complete');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await e.sendOrchestrator('sleeper', 'Final stage: call mark_done now, then return {"stage":2}. No other tools or delegation.');
      });
    }
  }
  if (selected === 'all' || selected === 'batch') {
    const members = Array.from({ length: 6 }, (_, i) => ({ ...model(i % 2 ? 'codex' : 'claude'), prompt: `Return exactly {"index":${i}}. No tools or delegation.`, schema: schema({ index: { type: 'integer' } }) }));
    await run('batch-six', 'return await parallel(args.members.map(m=>()=>agent(m.prompt,m)));', { members }, e => {
      assert.deepEqual(e.run.result, Array.from({ length: 6 }, (_, index) => ({ index })));
      assert.ok(e.run.agents.every(a => a.status === 'done' && a.turns.length === 1));
      assert.equal(peakActiveTurns(e.run.agents), 6, 'all six backend turns must overlap');
    });
  }
} finally { await hub.close(); }
