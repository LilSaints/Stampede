import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';

// Control flow ported from the installed Claude Code 2.1.292 Workflow
// authoring reference. Its schema/prompt placeholders use deterministic data.
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const finding = object({ title: { type: 'string' }, file: { type: 'string' } });
const fixtures = {
  findings: object({ findings: { type: 'array', items: finding } }),
  verdict: object({ isReal: { type: 'boolean' } }),
  bugs: object({ bugs: { type: 'array', items: object({ desc: { type: 'string' } }) } }),
  real: object({ real: { type: 'boolean' } }),
  design: object({ name: { type: 'string' } }),
  score: object({ score: { type: 'integer' } }),
  synthesis: object({ winner: { type: 'string' }, runnersUp: { type: 'array', items: { type: 'string' } } })
};
const review = `export const meta={name:'review-changes',description:'Review changed files across dimensions, verify each finding',phases:[{title:'Review'},{title:'Verify'}]};
const FINDINGS_SCHEMA=args.findings, VERDICT_SCHEMA=args.verdict;
const DIMENSIONS=[{key:'bugs',prompt:JSON.stringify({findings:[{title:'fixture-real',file:'a.ts'}]})},{key:'perf',prompt:JSON.stringify({findings:[{title:'fixture-rejected',file:'b.ts'}]})}];
const results=await pipeline(DIMENSIONS,
  d=>agent(d.prompt,{label:'review:'+d.key,phase:'Review',schema:FINDINGS_SCHEMA}),
  review=>parallel(review.findings.map(f=>()=>
    agent('Adversarially verify: '+f.title,{label:'verify:'+f.file,phase:'Verify',schema:VERDICT_SCHEMA}).then(v=>({...f,verdict:v}))
  ))
);
const confirmed=results.flat().filter(Boolean).filter(f=>f.verdict?.isReal);
return {confirmed};`;
const loop = `export const meta={name:'loop-until-dry',description:'Find, deduplicate and judge until two dry rounds'};
const BUGS=args.bugs, VERDICT=args.real;
const FINDERS=[{prompt:JSON.stringify({bugs:[{desc:'fixture-real'}]})},{prompt:JSON.stringify({bugs:[{desc:'fixture-rejected'}]})}];
const key=b=>b.desc;
const seen=new Set(),confirmed=[];
let dry=0;
while(dry<2){
  const found=(await parallel(FINDERS.map(f=>()=>agent(f.prompt,{phase:'Find',schema:BUGS})))).filter(Boolean).flatMap(r=>r.bugs);
  const fresh=found.filter(b=>!seen.has(key(b)));
  if(!fresh.length){dry++;continue;}
  dry=0;fresh.forEach(b=>seen.add(key(b)));
  const judged=await parallel(fresh.map(b=>()=>
    parallel(['correctness','security','repro'].map(lens=>()=>
      agent('Judge "'+b.desc+'" via the '+lens+' lens — real?',{phase:'Verify',schema:VERDICT})))
    .then(vs=>({b,real:vs.filter(Boolean).filter(v=>v.real).length>=2}))));
  confirmed.push(...judged.filter(v=>v.real).map(v=>v.b));
}
return confirmed;`;
// The reference describes this pattern in prose: independent attempts,
// parallel scoring, then synthesize the winner with ideas from runners-up.
const panel = `export const meta={name:'judge-panel',description:'Generate, score and synthesize independent designs'};
const attempts=await parallel(['A','B','C'].map(name=>()=>agent(JSON.stringify({name}),{phase:'Design',schema:args.design})));
const scored=await parallel(attempts.filter(Boolean).map(design=>()=>agent('Score fixture design '+design.name,{phase:'Judge',schema:args.score}).then(score=>({design,...score}))));
scored.sort((a,b)=>b.score-a.score);
return await agent(JSON.stringify({winner:scored[0].design.name,runnersUp:scored.slice(1).map(s=>s.design.name)}),{phase:'Synthesize',schema:args.synthesis});`;

test('installed Workflow reference review, dry-loop and judge-panel patterns run on both fake backends', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-reference-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.scheduler.maxConcurrent = 6; config.scheduler.perRun = 6;
  config.scheduler.claude.maxConcurrent = 6; config.scheduler.codex.maxConcurrent = 6;
  const adapter = (backend: string) => ({ available: true, binary: process.execPath, entry: path.resolve(`test/fake-backends/fake-${backend}.mjs`), version: backend === 'claude' ? '2.1.292' : '0.159.2', capabilities: {} });
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: adapter('claude'), codex: adapter('codex') } });
  try {
    for (const backend of ['claude', 'codex'] as const) {
      for (const [script, expected, count] of [
        [review, { confirmed: [{ title: 'fixture-real', file: 'a.ts', verdict: { isReal: true } }] }, 4],
        [loop, [{ desc: 'fixture-real' }], 12],
        [panel, { winner: 'B', runnersUp: ['C', 'A'] }, 7]
      ] as const) {
        const started = await hub.manager.start({ cwd, defaultBackend: backend, script, args: fixtures });
        await hub.manager.active.get(started.runId)!.task;
        const run = hub.manager.get(started.runId);
        assert.equal(run.status, 'completed', JSON.stringify(run.error));
        assert.deepEqual(run.result, expected); assert.equal(run.agents.length, count);
        assert.ok(run.agents.every(a => a.status === 'done' && a.backend === backend));
        assert.ok(run.agents.every(a => !a.phase || run.phases.some(phase => phase.title === a.phase)), 'explicit agent phases must be visible in the pane');
        if (script === panel) assert.deepEqual(run.agents.map(a => a.phase), ['Design','Design','Design','Judge','Judge','Judge','Synthesize']);
        if (script === review) assert.deepEqual(run.agents.filter(a => a.phase === 'Verify').map(a => a.label).sort(), ['verify:a.ts','verify:b.ts']);
      }
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
