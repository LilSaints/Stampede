// Control flow ported from the installed Claude Code 2.1.292 Workflow
// authoring reference. Its schema/prompt placeholders use deterministic data.
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const finding = object({ title: { type: 'string' }, file: { type: 'string' } });
export const fixtures = {
  findings: object({ findings: { type: 'array', items: finding } }),
  verdict: object({ isReal: { type: 'boolean' } }),
  bugs: object({ bugs: { type: 'array', items: object({ desc: { type: 'string' } }) } }),
  real: object({ real: { type: 'boolean' } }),
  design: object({ name: { type: 'string' } }),
  score: object({ score: { type: 'integer' } }),
  synthesis: object({ winner: { type: 'string' }, runnersUp: { type: 'array', items: { type: 'string' } } })
};
export const review = `export const meta={name:'review-changes',description:'Review changed files across dimensions, verify each finding',phases:[{title:'Review'},{title:'Verify'}]};
const FINDINGS_SCHEMA=args.findings, VERDICT_SCHEMA=args.verdict;
const DIMENSIONS=[{key:'bugs',prompt:JSON.stringify({findings:[{title:'fixture-real',file:'a.ts'}]})},{key:'perf',prompt:JSON.stringify({findings:[{title:'fixture-rejected',file:'b.ts'}]})}];
const results=await pipeline(DIMENSIONS,
  d=>agent(d.prompt,{...args.agentOptions,label:'review:'+d.key,phase:'Review',schema:FINDINGS_SCHEMA}),
  review=>parallel(review.findings.map(f=>()=>
    agent('Adversarially verify: '+f.title,{...args.agentOptions,label:'verify:'+f.file,phase:'Verify',schema:VERDICT_SCHEMA}).then(v=>({...f,verdict:v}))
  ))
);
const confirmed=results.flat().filter(Boolean).filter(f=>f.verdict?.isReal);
return {confirmed};`;
export const loop = `export const meta={name:'loop-until-dry',description:'Find, deduplicate and judge until two dry rounds'};
const BUGS=args.bugs, VERDICT=args.real;
const FINDERS=[{prompt:JSON.stringify({bugs:[{desc:'fixture-real'}]})},{prompt:JSON.stringify({bugs:[{desc:'fixture-rejected'}]})}];
const key=b=>b.desc;
const seen=new Set(),confirmed=[];
let dry=0;
while(dry<2){
  const found=(await parallel(FINDERS.map(f=>()=>agent(f.prompt,{...args.agentOptions,phase:'Find',schema:BUGS})))).filter(Boolean).flatMap(r=>r.bugs);
  const fresh=found.filter(b=>!seen.has(key(b)));
  if(!fresh.length){dry++;continue;}
  dry=0;fresh.forEach(b=>seen.add(key(b)));
  const judged=await parallel(fresh.map(b=>()=>
    parallel(['correctness','security','repro'].map(lens=>()=>
      agent('Judge "'+b.desc+'" via the '+lens+' lens — real?',{...args.agentOptions,phase:'Verify',schema:VERDICT})))
    .then(vs=>({b,real:vs.filter(Boolean).filter(v=>v.real).length>=2}))));
  confirmed.push(...judged.filter(v=>v.real).map(v=>v.b));
}
return confirmed;`;
// The reference describes this pattern in prose: independent attempts,
// parallel scoring, then synthesize the winner with ideas from runners-up.
export const panel = `export const meta={name:'judge-panel',description:'Generate, score and synthesize independent designs'};
const attempts=await parallel(['A','B','C'].map(name=>()=>agent(JSON.stringify({name}),{...args.agentOptions,phase:'Design',schema:args.design})));
const scored=await parallel(attempts.filter(Boolean).map(design=>()=>agent('Score fixture design '+design.name,{...args.agentOptions,phase:'Judge',schema:args.score}).then(score=>({design,...score}))));
scored.sort((a,b)=>b.score-a.score);
return await agent(JSON.stringify({winner:scored[0].design.name,runnersUp:scored.slice(1).map(s=>s.design.name)}),{...args.agentOptions,phase:'Synthesize',schema:args.synthesis});`;

