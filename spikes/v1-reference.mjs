// Run the same reference control flow and schemas used by the fake parity suite.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { startHub } from '../dist/src/hub/server.js';
import { defaults } from '../dist/src/hub/config.js';
import { fixtures, review, loop, panel } from '../dist/test/fixtures/reference.js';

if (process.env.STAMPEDE_E2E !== '1') throw new Error('Set STAMPEDE_E2E=1 to authorize real model calls.');
const output = path.resolve(process.argv[2] ?? `spikes/artifacts/v1-reference-${Date.now()}`);
const selected = process.argv[3] ?? 'all';
if (!['all', 'claude', 'codex'].includes(selected)) throw new Error('backend must be claude, codex or all');
const cwd = path.join(output, 'workspace'); await mkdir(cwd, { recursive: true });
// Reference placeholders have a synthetic oracle; no repository analysis is required.
const instructions = `task: Execute the supplied synthetic reference-workflow task.
scope: Only the prompt and the fixture rules below.
known: If the prompt is JSON, return that exact JSON object. For "Adversarially verify: fixture-real", return {"isReal":true}; fixture-rejected returns {"isReal":false}. For Judge prompts, fixture-real is real for correctness and security and false for repro; fixture-rejected is false for every lens. For Score fixture design, A scores 7, B scores 10, C scores 9.
constraints: No tools, shell, file changes or delegation. These are fixture facts, not bugs to investigate.
done: Return one object matching the requested schema.
reply: JSON only; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:
`;

const config = defaults();
config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
config.scheduler.claude.maxConcurrent = 6; config.scheduler.codex.maxConcurrent = 6;
config.codex.defaultModel = 'gpt-6-luna'; config.codex.defaultEffort = 'low';
config.limits.claudeTurnMaxUsd = 0.5; config.limits.turnTimeoutMs = 120000;
const hub = await startHub({ home: path.join(output, 'state'), config, cliEntry: path.resolve('dist/cli.js') });
const results = [];
try {
  for (const backend of selected === 'all' ? ['claude', 'codex'] : [selected]) {
    for (const [name, script, expected, count] of [
      ['review-changes', review, { confirmed: [{ title: 'fixture-real', file: 'a.ts', verdict: { isReal: true } }] }, 4],
      ['loop-until-dry', loop, [{ desc: 'fixture-real' }], 12],
      ['judge-panel', panel, { winner: 'B', runnersUp: ['C', 'A'] }, 7]
    ]) {
      const started = await hub.manager.start({ cwd, defaultBackend: backend, script, args: { ...fixtures, agentOptions: { model: backend === 'claude' ? 'haiku' : 'gpt-6-luna', effort: 'low', appendSystemPrompt: instructions } } });
      const execution = hub.manager.active.get(started.runId);
      try {
        await execution.task;
        const run = execution.run;
        assert.equal(run.status, 'completed', JSON.stringify(run.error));
        assert.deepEqual(run.result, expected);
        assert.equal(run.agents.length, count);
        assert.ok(run.agents.every(agent => agent.status === 'done' && agent.backend === backend && agent.turns.length === 1));
        if (name === 'judge-panel') assert.deepEqual(run.agents.map(a => a.phase), ['Design', 'Design', 'Design', 'Judge', 'Judge', 'Judge', 'Synthesize']);
        results.push({ name, backend, passed: true, runId: run.id, result: run.result, agents: run.agents.map(a => ({ phase: a.phase, turns: a.turns.length, usage: a.usage })) });
      } catch (error) {
        results.push({ name, backend, passed: false, runId: started.runId, error: error.message }); throw error;
      } finally {
        await writeFile(path.join(output, 'summary.json'), JSON.stringify({ results }, null, 2));
        console.log(JSON.stringify({ ...results.at(-1), agents: results.at(-1).agents?.length }));
      }
    }
  }
} finally { await hub.close(); }
