import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2] || path.join(here,'artifacts','s23-native'));
const codex=process.env.STAMPEDE_PROBE_CODEX || path.join(os.homedir(),'AppData','Roaming','npm','node_modules','@openai','codex','bin','codex.js');
const env={...process.env};
for(const key of Object.keys(env))if((key.startsWith('CODEX_')&&!['CODEX_HOME','CODEX_API_KEY'].includes(key))||key==='PSModulePath')delete env[key];
const ps=value=>"'"+value.replaceAll("'","''")+"'";
async function run(file,args,cwd) {
  const child=spawn(file,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  return {file,args,cwd,code,stdout,stderr};
}
await mkdir(out,{recursive:true});const fixture=path.join(os.homedir(),'.stampede-spike-'+randomUUID());await mkdir(fixture);
const nonce=randomUUID(),canary=path.join(fixture,'canary.txt'),privateCanary=path.join(fixture,'private-canary.txt');
const summary={at:new Date().toISOString(),fixture,nonce,profiles:[]};
try {
  await writeFile(canary,'OUTSIDE_'+nonce);await writeFile(privateCanary,'PRIVATE_'+nonce);
  const acl=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';$f=${ps(privateCanary)};$a=Get-Acl -LiteralPath $f;$a.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));Set-Acl -LiteralPath $f -AclObject $a;(Get-Acl -LiteralPath $f).Sddl`],out);
  summary.acl=acl;if(acl.code!==0)throw new Error('ACL preparation failed: '+acl.stderr);
  for(const profile of [':read-only',':workspace']) {
    const label=profile.slice(1),cwd=path.join(out,label);await mkdir(cwd,{recursive:true});
    const inside=path.join(cwd,'inside.txt');await writeFile(inside,'INSIDE_'+nonce);
    const target=path.join(cwd,'probe.mjs');
    await writeFile(target,`import fs from 'node:fs';\nconst r={profile:${JSON.stringify(profile)},cwd:process.cwd()};\n`+
      `for(const [key,file] of ${JSON.stringify([['inside',inside],['outside',canary],['privateOutside',privateCanary]])}){try{r[key]={ok:true,value:fs.readFileSync(file,'utf8')}}catch(e){r[key]={ok:false,error:e.message}}}\n`+
      `for(const [key,file] of ${JSON.stringify([['insideWrite',path.join(cwd,'write.txt')],['outsideWrite',path.join(fixture,label+'.txt')]])}){try{fs.writeFileSync(file,'PROBE');r[key]={ok:true}}catch(e){r[key]={ok:false,error:e.message}}}\nconsole.log(JSON.stringify(r));\n`);
    // Explicit built-in permission profiles exercise the OS sandbox itself,
    // without relying on model tool selection or a shell command classifier.
    const response=await run(process.execPath,[codex,'sandbox','--permission-profile',profile,'--include-managed-config','-C',cwd,process.execPath,target],cwd);
    try{response.report=JSON.parse(response.stdout.trim());}catch{}
    for(const [key,file] of [['insideWriteExists',path.join(cwd,'write.txt')],['outsideWriteExists',path.join(fixture,label+'.txt')]]) {
      try{response[key]=(await readFile(file,'utf8'))==='PROBE';}catch(e){if(e.code==='ENOENT')response[key]=false;else throw e;}
    }
    response.controlsPassed=response.code===0 && response.report?.inside?.ok===true && response.outsideWriteExists===false && response.insideWriteExists===(profile===':workspace');
    if(!response.controlsPassed)process.exitCode=1;
    summary.profiles.push(response);await writeFile(path.join(out,'s23.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify({profile,code:response.code,report:response.report,stderr:response.stderr.slice(-1000),insideWriteExists:response.insideWriteExists,outsideWriteExists:response.outsideWriteExists}));
  }
} catch(e) {summary.error=e.stack;process.exitCode=1;console.error(e.message);}
finally {
  if(path.dirname(fixture)===os.homedir()&&path.basename(fixture).startsWith('.stampede-spike-')) {
    for(const file of ['canary.txt','private-canary.txt','read-only.txt','workspace.txt'])await unlink(path.join(fixture,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await rmdir(fixture);summary.fixtureRemoved=true;
  }
  await writeFile(path.join(out,'s23.json'),JSON.stringify(summary,null,2));
}
