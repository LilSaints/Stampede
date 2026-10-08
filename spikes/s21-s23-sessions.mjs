// Real CLI probes, intentionally separate from the product implementation.
// Writes only probe fixtures, transcripts, and the CLIs' normal session state.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, writeFile, readFile, readdir, unlink, rmdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ProcessLookup,matches} from './s20-client-process.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const codex=process.env.STAMPEDE_PROBE_CODEX || path.join(os.homedir(),'AppData','Roaming','npm','node_modules','@openai','codex','bin','codex.js');
const model=process.env.STAMPEDE_PROBE_MODEL || 'gpt-6-luna';
const mcp=path.join(here,'probe-mcp.mjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const quote=value=>JSON.stringify(value);
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
const redact=text=>text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]');
const active=new Set();let lookup,server,artifactRoot,fixtureDir;
const result={startedAt:new Date().toISOString(),models:{codex:model,claude:'haiku'},s20:[],s21:{},s22:{},s23:{},errors:[]};
// Do not attach a probe CLI to the invoking desktop chat or inherit its selected
// permission profile. Every probe receives its own explicit sandbox policy.
// Authentication locations are preserved; no credentials are read or copied.
function workerEnv(extra) {
  const env={...process.env,...extra};
  const removed=[];
  for(const key of Object.keys(env))if((key.startsWith('CODEX_') && !['CODEX_HOME','CODEX_API_KEY'].includes(key)) || key==='PSModulePath') {removed.push(key);delete env[key];}
  result.environment={removedHostVariables:removed,credentialsCopied:false};return env;
}
async function save() {await writeFile(path.join(artifactRoot,'summary.json'),JSON.stringify(result,null,2));}
async function events(file) {try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function killTree(child) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let text='';killer.stdout.on('data',d=>text+=d);killer.stderr.on('data',d=>text+=d);
  const code=await new Promise(r=>killer.once('exit',r));
  if(code!==0 && child.exitCode===null)throw new Error('taskkill failed: '+text.slice(-1000));
}
function launch(name,file,argv,cwd,prompt,env={}) {
  const child=spawn(file,argv,{cwd,env:workerEnv(env),windowsHide:true,stdio:['pipe','pipe','pipe']});
  active.add(child);
  const turn={name,child,stdout:'',stderr:'',events:[],startedAt:new Date().toISOString(),cwd,argv};let remainder='';
  child.stdout.on('data',data=>{turn.stdout+=data;remainder+=data;let i;while((i=remainder.indexOf('\n'))>=0){const line=remainder.slice(0,i);remainder=remainder.slice(i+1);try{const e=JSON.parse(line);turn.events.push(e);if(e.type==='thread.started')turn.sessionId=e.thread_id;else if(e.session_id)turn.sessionId=e.session_id;}catch{}}});
  child.stderr.on('data',d=>turn.stderr+=d);
  turn.closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',async(code,signal)=>{
    active.delete(child);clearTimeout(turn.timer);turn.code=code;turn.signal=signal;
    const prefix=path.join(artifactRoot,name);
    try {await writeFile(prefix+'.stdout.jsonl',redact(turn.stdout));await writeFile(prefix+'.stderr.txt',redact(turn.stderr));await writeFile(prefix+'.launch.json',JSON.stringify({file,argv,cwd,startedAt:turn.startedAt,code,signal,pid:child.pid},null,2));resolve(turn);}catch(e){reject(e);}
  });});
  turn.timer=setTimeout(()=>{turn.timedOut=true;killTree(child).catch(e=>result.errors.push(e.message));},180000);
  child.stdin.on('error',()=>{});child.stdin.end(prompt);return turn;
}
const finalText=turn=>{
  const finals=turn.events.filter(e=>e.type==='result');
  if(finals.length)return finals.at(-1).result || '';
  return turn.events.filter(e=>e.type==='item.completed' && e.item?.type==='agent_message').map(e=>e.item.text).at(-1) || '';
};
function compact(turn) {return {code:turn.code,signal:turn.signal,sessionId:turn.sessionId,timedOut:turn.timedOut || false,final:finalText(turn),errors:turn.events.filter(e=>e.type==='error'||e.type==='turn.failed').slice(-3),stderrTail:turn.code!==0?turn.stderr.slice(-1800):undefined};}
function codexArgs({cwd,mode='read-only',tag='A',eventFile,sessionId,effort='low',developer='Probe only. Do not delegate to agents or access credentials.',network=false,envTag}) {
  const argv=[codex,'exec','--json','--ignore-user-config','--skip-git-repo-check','--disable','hooks','--disable','multi_agent','--disable','multi_agent_v2',
    '-C',cwd,'-m',model,'-c','approval_policy="never"','-c',`model_reasoning_effort=${quote(effort)}`,'-c',`developer_instructions=${quote(developer)}`];
  const profiles=process.env.STAMPEDE_PROBE_PERMISSIONS==='profiles';
  if(profiles)argv.push('-c',`default_permissions=${quote(network?'stampede-probe-network':mode==='workspace-write'?':workspace':':read-only')}`);
  else argv.push('-s',mode);
  if(process.env.STAMPEDE_PROBE_TRUST==='1')argv.push('-c',`projects.${quote(cwd)}.trust_level="trusted"`);
  if(process.env.STAMPEDE_PROBE_WINDOWS_SANDBOX)argv.push('-c',`windows.sandbox=${quote(process.env.STAMPEDE_PROBE_WINDOWS_SANDBOX)}`);
  if(network && profiles)argv.push('-c','permissions.stampede-probe-network.extends=":workspace"','-c','permissions.stampede-probe-network.network.enabled=true');
  else if(network)argv.push('-c','sandbox_workspace_write.network_access=true');
  if(envTag)argv.push('-c',`shell_environment_policy.set={STAMPEDE_PROBE_SETTING=${quote(envTag)}}`);
  if(eventFile)argv.push('-c',`mcp_servers.stampede.command=${quote(process.execPath)}`,'-c',`mcp_servers.stampede.args=${quote([mcp])}`,
    '-c',`mcp_servers.stampede.env={STAMPEDE_PROBE_EVENTS=${quote(eventFile)},STAMPEDE_PROBE_TAG=${quote(tag)}}`,'-c','mcp_servers.stampede.tool_timeout_sec=120',
    '-c','mcp_servers.stampede.default_tools_approval_mode="approve"');
  if(sessionId)argv.push('resume',sessionId);argv.push('-');return argv;
}
async function claudeArgs(cwd,eventFile,sessionId,resume=false,tools='mcp__stampede__*',tag='A') {
  const config=path.join(cwd,'mcp.json');
  await writeFile(config,JSON.stringify({mcpServers:eventFile?{stampede:{type:'stdio',command:process.execPath,args:[mcp],env:{STAMPEDE_PROBE_EVENTS:eventFile,STAMPEDE_PROBE_TAG:tag}}}:{}}));
  return ['-p','--output-format','stream-json','--verbose','--model','haiku','--effort','low','--max-budget-usd','0.50',
    '--setting-sources','','--strict-mcp-config','--mcp-config',config,'--permission-mode','default','--allowedTools',tools,
    '--tools',tools==='Bash'?'Bash':'',resume?'--resume':'--session-id',sessionId];
}
async function workspace(name) {const cwd=path.join(artifactRoot,'workspaces',name);await mkdir(cwd,{recursive:true});return cwd;}
async function pendingWait(turn,eventFile) {
  const end=Date.now()+120000;
  while(Date.now()<end) {
    const rows=await events(eventFile);if(rows.some(x=>x.event==='tool-call'&&x.tool==='wait_for_message'))return rows;
    if(turn.code!==undefined)throw new Error('Worker exited before waiting: '+JSON.stringify(compact(turn)));
    await delay(200);
  }
  throw new Error('No pending MCP wait observed within 120 seconds');
}
const reply='reply: JSON only; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:';
async function preemption(backend) {
  const cwd=await workspace('s21-'+backend),nonce=randomUUID(),eventFile=path.join(artifactRoot,'s21-'+backend+'.mcp.jsonl'),id=randomUUID();
  const prompt=`task: Remember the nonce, call the Stampede wait_for_message tool exactly once, then report the nonce after that call returns.\nknown: nonce=${nonce}\nconstraints: Do not read files, run commands, call other tools, or delegate.\ndone: wait_for_message was called; then the final JSON has nonce and continued=true.\n${reply}`;
  const argv=backend==='codex'?codexArgs({cwd,mode:'workspace-write',eventFile}):await claudeArgs(cwd,eventFile,id);
  const turn=launch('s21-'+backend+'-start',backend==='codex'?process.execPath:'claude.exe',argv,cwd,prompt,{MCP_TOOL_TIMEOUT:'120000'});
  try {
    await pendingWait(turn,eventFile);await delay(1500);
    if(turn.code!==undefined)throw new Error('Worker finished before the kill could be tested');
    const sessionId=turn.sessionId || (backend==='claude'?id:undefined);
    if(!sessionId)throw new Error('Session ID was not emitted before the wait');
    const killedAt=new Date().toISOString();await killTree(turn.child);await turn.closed;
    const resumePrompt=`task: Continue the task after scheduler preemption. Your previous wait_for_message call was deliberately interrupted; do not call it again.\nknown: A new peer message says the wait is over. Retrieve the original nonce from this session's prior context.\nconstraints: No tools, commands, file reads, or delegation.\ndone: Final JSON contains the original nonce and continued=true.\n${reply}`;
    const args=backend==='codex'?codexArgs({cwd,mode:'workspace-write',eventFile,sessionId}):await claudeArgs(cwd,eventFile,sessionId,true);
    const resumed=await launch('s21-'+backend+'-resume',backend==='codex'?process.execPath:'claude.exe',args,cwd,resumePrompt,{MCP_TOOL_TIMEOUT:'120000'}).closed;
    result.s21[backend]={pendingWaitObserved:true,killedAt,start:compact(turn),resume:compact(resumed),nonceRecovered:finalText(resumed).includes(nonce),sameSession:resumed.sessionId===sessionId,pass:resumed.code===0 && resumed.sessionId===sessionId && finalText(resumed).includes(nonce)};
  } catch(e) {await killTree(turn.child);await turn.closed;result.s21[backend]={pass:false,error:e.message,start:compact(turn)};}
  await save();console.log(JSON.stringify({spike:'S-21',backend,result:result.s21[backend]}));
}
async function ancestry(backend) {
  const cwd=await workspace('s20-'+backend),requestId=randomUUID();
  const url=`http://127.0.0.1:${server.address().port}/${requestId}`;
  const command=`curl.exe --noproxy "*" --max-time 20 --silent --show-error ${url}`;
  const prompt=`task: Run this single localhost probe command exactly once: ${command}\nconstraints: Run only that command; no other file access, commands, or delegation.\ndone: The command response was observed.\n${reply}`;
  const args=backend==='codex'?codexArgs({cwd,mode:'workspace-write',network:true}):await claudeArgs(cwd,null,randomUUID(),false,'Bash');
  const turn=launch('s20-'+backend,backend==='codex'?process.execPath:'claude.exe',args,cwd,prompt);
  const identity=(await lookup.query({inspectPid:turn.child.pid})).identity;
  realConnections.set(requestId,{backend,identity,turn});
  await turn.closed;
  if(!result.s20.some(r=>r.backend===backend))result.s20.push({backend,lookupObserved:false,turn:compact(turn)});
  else result.s20.find(r=>r.backend===backend).turn=compact(turn);
  await save();console.log(JSON.stringify({spike:'S-20',backend,result:result.s20.find(r=>r.backend===backend)}));
}
const realConnections=new Map();
async function probeScript(cwd,label,canary,privateCanary) {
  const own=path.join(cwd,'inside.txt');await writeFile(own,'INSIDE_'+label);
  const target=path.join(cwd,'sandbox-probe.mjs');
  const body=`import fs from 'node:fs';\nconst r={label:${quote(label)},cwd:process.cwd(),envMarker:process.env.STAMPEDE_PROBE_SETTING};\n`+
    `for(const [key,file] of ${quote([['inside',own],['outside',canary],['privateOutside',privateCanary]])}){try{r[key]={ok:true,value:fs.readFileSync(file,'utf8')}}catch(e){r[key]={ok:false,error:e.message}}}\n`+
    `for(const [key,file] of ${quote([['insideWrite',path.join(cwd,'write-attempt.txt')],['outsideWrite',path.join(fixtureDir,'write-'+label+'.txt')]])}){try{fs.writeFileSync(file,'WRITE_'+${quote(label)});r[key]={ok:true}}catch(e){r[key]={ok:false,error:e.message}}}\nconsole.log(JSON.stringify(r));\n`;
  await writeFile(target,body);return target;
}
async function settingsAndReads() {
  const a=await workspace('s22-start-A'),b=await workspace('s22-resume-B');
  fixtureDir=path.join(os.homedir(),'.stampede-spike-'+randomUUID());await mkdir(fixtureDir);
  const nonce=randomUUID(),canary=path.join(fixtureDir,'canary.txt'),privateCanary=path.join(fixtureDir,'private-canary.txt');
  await writeFile(canary,'OUTSIDE_'+nonce);await writeFile(privateCanary,'PRIVATE_'+nonce);
  const acl=launch('s23-fixture-acl','powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$file=${psQuote(privateCanary)};$acl=Get-Acl -LiteralPath $file;$acl.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow');$acl.SetAccessRule($rule);Set-Acl -LiteralPath $file -AclObject $acl;[ordered]@{sid=$sid.Value;sddl=(Get-Acl -LiteralPath $file).Sddl}|ConvertTo-Json -Compress`],a,'');
  await acl.closed;if(acl.code!==0)throw new Error('Could not prepare user-only synthetic canary ACL: '+acl.stderr);
  result.s23.fixture={path:fixtureDir,nonce,acl:JSON.parse(acl.stdout.trim())};
  let previous;
  for(const [label,cwd,mode,tag,effort] of [['start',a,'workspace-write','A','low'],['resume',b,'read-only','B','medium']]) {
    const probe=await probeScript(cwd,label,canary,privateCanary),eventFile=path.join(artifactRoot,`s22-${label}.mcp.jsonl`);
    const marker='DEV_'+tag+'_'+nonce;
    const prompt=`task: Run this command once in your default working directory, without setting workdir/cwd: node "${probe}". Then call Stampede settings_${tag}.\nscope: The script tests synthetic canary files only. Permission errors are expected evidence.\nconstraints: No alternative commands or retries; no delegation. Do not alter permissions.\ndone: Final JSON contains the active developer marker, observed shell report, and observed MCP tag.\n${reply}`;
    const args=codexArgs({cwd,mode,tag,eventFile,sessionId:previous?.sessionId,effort,envTag:'ENV_'+tag,developer:`This is a bounded integration probe. Your active developer marker is ${marker}. Include it in final JSON. Use only the explicitly requested probe command and MCP settings tool. Do not delegate.`});
    const turn=await launch('s22-'+label,process.execPath,args,cwd,prompt).closed;
    const record={...compact(turn),expected:{cwd,mode,effort,developerMarker:marker,envMarker:'ENV_'+tag,mcpTag:tag},mcpEvents:await events(eventFile)};
    result.s22[label]=record;await save();console.log(JSON.stringify({spike:'S-22/S-23',phase:label,result:record}));
    if(turn.code!==0 || !turn.sessionId)throw new Error('Settings probe failed during '+label);
    previous=turn;
  }
}
async function collectOwnRollouts() {
  const ids=new Set([result.s21.codex?.resume?.sessionId,result.s22.start?.sessionId].filter(Boolean));
  const root=path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'sessions');
  async function walk(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(file);
      else if([...ids].some(id=>entry.name.includes(id))) {
        const rows=(await readFile(file,'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));
        const context=rows.filter(x=>x.type==='turn_context').map(x=>({timestamp:x.timestamp,...x.payload}));
        await writeFile(path.join(artifactRoot,entry.name+'.turn-contexts.json'),JSON.stringify(context,null,2));
        const toolCalls=rows.filter(x=>x.type==='response_item' && ['custom_tool_call','custom_tool_call_output','function_call','function_call_output'].includes(x.payload.type));
        await writeFile(path.join(artifactRoot,entry.name+'.tool-calls.json'),JSON.stringify(toolCalls,null,2));
        const developerMarkers=rows.filter(x=>x.type==='response_item' && x.payload.type==='message' && x.payload.role==='developer')
          .flatMap(x=>JSON.stringify(x.payload.content).match(/DEV_[AB]_[a-f0-9-]+/g) || []);
        result.rollouts ??=[];result.rollouts.push({file,developerMarkers:[...new Set(developerMarkers)],toolCallRecords:toolCalls.length,
          contexts:context.map(x=>({timestamp:x.timestamp,cwd:x.cwd,approval_policy:x.approval_policy,sandbox_policy:x.sandbox_policy,model:x.model,effort:x.effort}))});
      }
    }
  }
  result.rollouts=[];await walk(root);
  for(const phase of ['start','resume']) {
    const row=result.s22[phase];if(!row?.expected?.cwd)continue;
    try{row.hostWriteCheck={exists:true,contents:await readFile(path.join(row.expected.cwd,'write-attempt.txt'),'utf8')};}
    catch(e){if(e.code==='ENOENT')row.hostWriteCheck={exists:false};else throw e;}
  }
  await save();
}
async function main() {
  artifactRoot=path.resolve(process.argv[2] || path.join(here,'artifacts','sessions-'+Date.now()));await mkdir(artifactRoot,{recursive:true});
  if(process.env.STAMPEDE_PROBE_SCOPE==='collect') {
    Object.assign(result,JSON.parse(await readFile(path.join(artifactRoot,'summary.json'),'utf8')));
    await collectOwnRollouts();console.log(JSON.stringify({artifactRoot,collected:true,rollouts:result.rollouts.length}));return;
  }
  lookup=await new ProcessLookup().start();
  server=createServer(async(req,res)=>{
    const entry=realConnections.get(req.url.slice(1));
    if(!entry){res.statusCode=404;res.end('unknown probe');return;}
    try {const observation=await lookup.query({clientPort:req.socket.remotePort,serverPort:server.address().port});
      const row={backend:entry.backend,lookupObserved:true,...observation,expectedRoot:entry.identity,agentAncestorFound:matches(observation.chain,entry.identity)};
      result.s20.push(row);res.end(JSON.stringify({probe:'S-20',identified:observation.ok,agentAncestorFound:row.agentAncestorFound}));
    } catch(e) {res.statusCode=500;res.end(e.message);}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    if(process.env.STAMPEDE_PROBE_SCOPE==='codex')await ancestry('codex');
    else if(process.env.STAMPEDE_PROBE_SCOPE!=='settings')for(const backend of ['claude','codex']) {await ancestry(backend);await preemption(backend);}
    await settingsAndReads();await collectOwnRollouts();
  } catch(e) {result.errors.push(e.stack);console.error(e.stack);process.exitCode=1;}
  finally {
    for(const child of active)await killTree(child).catch(e=>result.errors.push(e.message));
    server.close();lookup.close();result.endedAt=new Date().toISOString();await save();
    // Remove only the known synthetic files and their empty, generated directory.
    if(fixtureDir && path.dirname(fixtureDir)===os.homedir() && path.basename(fixtureDir).startsWith('.stampede-spike-')) {
      for(const file of ['canary.txt','private-canary.txt','write-start.txt','write-resume.txt'])await unlink(path.join(fixtureDir,file)).catch(e=>{if(e.code!=='ENOENT')result.errors.push(e.message);});
      await rmdir(fixtureDir).catch(e=>result.errors.push(e.message));result.s23.fixtureRemoved=true;await save();
    }
  }
  console.log(JSON.stringify({artifactRoot,finished:true,errors:result.errors}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
