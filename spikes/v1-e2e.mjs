// Opt-in real-backend acceptance. Uses normal CLI authentication and model usage.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { startHub } from '../dist/src/hub/server.js';
import { defaults } from '../dist/src/hub/config.js';
const output = path.resolve(process.argv[2] ?? `spikes/artifacts/v1-e2e-${Date.now()}`);
const cwd = path.join(output, 'workspace'); await mkdir(cwd, { recursive: true });
await writeFile(path.join(cwd, 'canary.txt'), 'stampede-fixture-blue\n');
const config = defaults(); config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4; config.codex.defaultModel = 'gpt-6-luna'; config.codex.defaultEffort = 'low'; config.limits.claudeTurnMaxUsd = 0.5; config.limits.turnTimeoutMs = 120000; config.limits.teamMaxMs = 120000;
const hub = await startHub({ home: path.join(output, 'state'), config, cliEntry: path.resolve('dist/cli.js') });
const results = [];
const call = async (name, input) => {
  const response = await fetch(`http://127.0.0.1:${hub.port}/v1/orch/${name}`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
};
async function scenario(name, script) {
  const started = await call('workflow_run', { script: `export const meta={name:${JSON.stringify(name)},description:"Real backend qualification"};\n` + script, cwd });
  const deadline = Date.now() + 180000;
  let status;
  do { status = await call('workflow_wait', { runId: started.runId, timeoutSec: 30, wakeOnMessage: false }); } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status) && Date.now() < deadline);
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) await call('workflow_control', { runId: started.runId, action: 'cancel' });
  const result = await call('workflow_result', { runId: started.runId });
  const run = hub.manager.get(started.runId);
  const passed = result.status === 'completed' && (name === 'mixed-parity' ? result.result?.[0]?.word === 'blue' : result.result?.observed?.reason === 'all-terminal' && result.result?.board?.length === 2 && result.result?.messages?.length === 2 && run.agents.every(a => a.markedDone && a.status === 'done'));
  if (!passed) process.exitCode = 1;
  results.push({ name, passed, runId: run.id, ...result, agents: run.agents.map(a => ({ name: a.name, backend: a.backend, status: a.status, markedDone: a.markedDone, turns: a.turns.length, error: a.error, usage: a.usage })) });
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ backends: hub.manager.backends, results }, null, 2));
  process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
}
try {
  if (!process.argv[3] || process.argv[3] === 'mixed-parity') await scenario('mixed-parity', String.raw`
const schema={type:'object',properties:{word:{type:'string'}},required:['word'],additionalProperties:false};
return await pipeline(['blue'],
  item=>agent('task: Return the word '+item+' in the schema.\nconstraints: No tools or delegation.\nreply: Only JSON; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:',{backend:'claude',model:'haiku',effort:'low',schema}),
  previous=>agent('task: Return this object unchanged: '+JSON.stringify(previous)+'\nconstraints: No tools or delegation.\nreply: Only JSON; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:',{backend:'codex',model:'gpt-6-luna',effort:'low',schema}));`);
  if (!process.argv[3] || process.argv[3] === 'mixed-team') await scenario('mixed-team', String.raw`
const prompt='task: Call post_finding with title your worker name, body "fixture checked", topic "probe". Send one message to orchestrator saying "fixture checked". Then call read_messages, then mark_done, and finish with the text "checked".\nconstraints: Do not delegate, read files or use shell tools.\nreply: checked; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:';
const team=await spawnTeam([{name:'claude-check',prompt,backend:'claude',model:'haiku',effort:'low'},{name:'codex-check',prompt,backend:'codex',model:'gpt-6-luna',effort:'low'}]);
const observed=await team.untilDone(undefined,{maxMs:120000}); await team.stop();
return {observed,results:await team.results(),board:await team.board(),messages:await team.messages()};`);
} finally { await hub.close(); }
