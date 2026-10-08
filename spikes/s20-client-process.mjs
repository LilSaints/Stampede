import {spawn} from 'node:child_process';
import {createServer, get} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const here=path.dirname(fileURLToPath(import.meta.url));
const script=path.join(here,'windows-client-process.ps1');
const pwsh=process.env.STAMPEDE_PROBE_PWSH || 'pwsh.exe';
export class ProcessLookup {
  constructor() {this.pending=[]; this.stderr='';}
  async start() {
    const started=performance.now();
    this.child=spawn(pwsh,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-Serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',d=>this.stderr+=d);
    const ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    createInterface({input:this.child.stdout}).on('line',line=>{
      try {const value=JSON.parse(line); if(value.ready) this.readyResolve(); else this.pending.shift()?.resolve(value);}
      catch(e) {this.pending.shift()?.reject(new Error(`Invalid helper output: ${line.slice(0,200)}`));}
    });
    this.child.on('error',e=>this.readyReject(e));
    this.child.on('exit',code=>{const e=new Error(`Lookup helper exited ${code}: ${this.stderr.slice(-1000)}`);this.readyReject(e);for(const p of this.pending.splice(0))p.reject(e);});
    await ready; this.startupMs=performance.now()-started;return this;
  }
  async query(request) {
    const started=performance.now();
    const value=await new Promise((resolve,reject)=>{this.pending.push({resolve,reject});this.child.stdin.write(JSON.stringify(request)+'\n');});
    return {...value,roundTripMs:performance.now()-started};
  }
  close() {this.child?.stdin.end();}
}
export const matches=(chain,identity)=>chain?.some(p=>p.pid===identity.pid && p.startFileTime===identity.startFileTime) || false;
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
async function coldLookup(clientPort,serverPort) {
  const started=performance.now();
  const child=spawn(pwsh,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-ClientPort',String(clientPort),'-ServerPort',String(serverPort)],{windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  return {...(code===0?JSON.parse(stdout):{ok:false,error:stderr.slice(-1000)}),roundTripMs:performance.now()-started};
}
async function main() {
  const out=path.resolve(process.argv[2] || path.join(here,'artifacts','s20-'+Date.now()));await mkdir(out,{recursive:true});
  const helper=await new ProcessLookup().start();
  const identity=(await helper.query({inspectPid:process.pid})).identity;
  const samples=[];let kind='warm';
  const server=createServer(async(req,res)=>{
    try {const r=kind==='cold'?await coldLookup(req.socket.remotePort,server.address().port):await helper.query({clientPort:req.socket.remotePort,serverPort:server.address().port});
      samples.push({...r,kind,expectedPid:process.pid,correct:r.clientPid===process.pid && matches(r.chain,identity)});res.end('ok');
    } catch(e) {samples.push({kind,ok:false,error:e.message});res.statusCode=500;res.end('error');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=()=>new Promise((resolve,reject)=>get({hostname:'127.0.0.1',port:server.address().port,path:'/',agent:false},r=>{r.resume();r.on('end',resolve);}).on('error',reject));
  try {
    for(let i=0;i<60;i++)await request();
    kind='cold';for(let i=0;i<20;i++)await request();
    const summary={helperStartupMs:helper.startupMs,host:process.platform,node:process.version,identity};
    for(const k of ['warm','cold']) {const rows=samples.filter(s=>s.kind===k);summary[k]={n:rows.length,correct:rows.filter(s=>s.correct).length,p50Ms:percentile(rows.map(s=>s.roundTripMs),.5),p95Ms:percentile(rows.map(s=>s.roundTripMs),.95),errors:rows.filter(s=>!s.ok).map(s=>s.error)};}
    await writeFile(path.join(out,'s20.json'),JSON.stringify({summary,samples},null,2));console.log(JSON.stringify({out,...summary}));
  } finally {server.close();helper.close();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});
