import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';

const eventFile=process.env.STAMPEDE_PROBE_EVENTS;
const settingsTag=process.env.STAMPEDE_PROBE_TAG || 'A';
function event(value) {if(eventFile)appendFileSync(eventFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid,...value})+'\n');}
function answer(id,result) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');}
event({event:'mcp-start',tag:settingsTag});
createInterface({input:process.stdin}).on('line',line=>{
  let request;try{request=JSON.parse(line);}catch{return;}
  const {id,method,params}=request;
  if(method==='initialize')answer(id,{protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'stampede-spike',version:'0.0.1'}});
  else if(method==='tools/list')answer(id,{tools:[
    {name:'wait_for_message',description:'Test fixture: wait for a peer message. This call deliberately remains pending until the controller interrupts the session.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},
    {name:'settings_'+settingsTag,description:'Return the active test MCP configuration marker.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}
  ]});
  else if(method==='tools/call') {
    event({event:'tool-call',tool:params.name,id,tag:settingsTag});
    if(params.name==='wait_for_message') {/* The controller kills this process while the result is pending. */}
    else if(params.name==='settings_'+settingsTag)answer(id,{content:[{type:'text',text:JSON.stringify({tag:settingsTag})}]});
    else answer(id,{isError:true,content:[{type:'text',text:'Unknown probe tool'}]});
  } else if(id!==undefined)answer(id,{});
});
