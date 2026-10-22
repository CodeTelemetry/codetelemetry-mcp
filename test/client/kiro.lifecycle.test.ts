import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import test from "node:test";
import {KiroCollector,KiroDiscovery} from "../../src/client/kiro/collector.ts";
import {KIRO_LIMITS} from "../../src/client/kiro/records.ts";
const workspace="0000000000000000",stamp="2026-10-19T18:28:13.699Z";
const sid=(n:number)=>`sess_00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const record=(id:string,payload:Record<string,unknown>)=>JSON.stringify({id,timestamp:stamp,payload});
const user=(id:string)=>record(id,{type:"user",content:"bounded fixture"})+"\n";
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-lifecycle-"));return {root,sourceRoot:path.join(root,"source"),stateDir:path.join(root,"state"),destinationHash:"a".repeat(64)};}
async function session(f:Awaited<ReturnType<typeof fixture>>,n:number,body:string,old=false){const dir=path.join(f.sourceRoot,workspace,sid(n));await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,"session.json"),JSON.stringify({schemaVersion:"1.0.0",dataModelVersion:1,id:sid(n),createdAt:old?"2020-01-01T00:00:00Z":"2026-10-19T18:28:13.699Z"}));const file=path.join(dir,"messages.jsonl");await fs.writeFile(file,body);return file;}
const logs=(body:string)=>JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords;
const attrs=(log:any)=>Object.fromEntries(log.attributes.map((entry:any)=>[entry.key,entry.value.stringValue??entry.value.intValue??entry.value.boolValue]));

test("more than 128 sessions share bounded parser slots while giant backfill remains unfinished",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const emitted:string[]=[];
 await session(f,1,Array.from({length:10000},(_,i)=>user(`giant-${i}`)).join(""));
 for(let n=2;n<=160;n++)await session(f,n,user(`peer-${n}`));
 const c=new KiroCollector({...f,now:()=>now,post:async body=>{emitted.push(...logs(body).map((l:any)=>attrs(l)["source.event.id"]));return "ok";}});
 try{await c.open();let complete=false;
  for(let tick=0;tick<240;tick++){
   const before=c.snapshot();const h=await c.tick();now+=1000;
   assert.ok(h.readBytes-before.readBytes<=KIRO_LIMITS.sessionsPerTick*KIRO_LIMITS.readBytesPerSession);
   assert.ok(h.requests-before.requests<=1);assert.ok(h.trackedSessions<=128);assert.ok(h.trackedSessions+h.parkedSessions<=8192);
   if(Array.from({length:159},(_,i)=>`peer-${i+2}`).every(id=>emitted.includes(id))){complete=true;break;}
  }
  assert.ok(complete,"late peers must progress beyond the old lifetime cap");
  assert.ok(emitted.filter(id=>id.startsWith("giant-")).length<10000,"a giant cannot finish before admitting all small peers");
  assert.equal(new Set(emitted).size,emitted.length,"cursor rotation must not resend acknowledged records");
  assert.ok((await fs.stat(path.join(f.stateDir,"checkpoint.json"))).size<=KIRO_LIMITS.checkpointBytes);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("historical bootstrap cursors do not occupy parser slots or hide later resumed activity",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const emitted:string[]=[];
 for(let n=1;n<=160;n++)await session(f,n,user(`old-${n}`),true);
 const file=path.join(f.sourceRoot,workspace,sid(160),"messages.jsonl");
 const c=new KiroCollector({...f,bootstrap:"end",now:()=>now,post:async body=>{emitted.push(...logs(body).map((l:any)=>attrs(l)["source.event.id"]));return "ok";}});
 try{await c.open();for(let t=0;t<30 && c.snapshot().parkedSessions<160;t++){await c.tick();now+=1000;}
  assert.equal(c.snapshot().parkedSessions,160);assert.equal(c.snapshot().trackedSessions,0);assert.deepEqual(emitted,[]);
  await fs.appendFile(file,user("resumed-last-history"));
  for(let t=0;t<30&&!emitted.length;t++){await c.tick();now+=1000;}
  assert.deepEqual(emitted,["resumed-last-history"]);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("dormant cursors preserve pending tool pairs and incomplete frames across restart and rewrite",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const captured:any[]=[];
 const file=await session(f,1,record("call-one",{type:"tool_call",toolCallId:"call-one",toolName:"read_file",executionId:"turn-one",args:{path:"fixture.txt"}})+"\n");
 const options={...f,policy:{prompts:false,toolDetails:true},now:()=>now,post:async(body:string)=>{captured.push(...logs(body).map(attrs));return "ok" as const;}};
 let c=new KiroCollector(options);
 try{await c.open();for(let i=0;i<4;i++){await c.tick();now+=1000;}
  let state=JSON.parse(await fs.readFile(path.join(f.stateDir,"checkpoint.json"),"utf8"));assert.equal(state.version,3);assert.equal(state.parked[0].records.calls.length,1);
  await c.close();c=new KiroCollector(options);await c.open();
  await fs.appendFile(file,record("result-one",{type:"tool_result",toolCallId:"call-one",executionId:"turn-one",success:false})+"\n");
  for(let i=0;i<12&&!captured.length;i++){await c.tick();now+=1000;}
  const wire=JSON.parse(String(captured[0]["kiro.source.record"]));assert.equal(wire.context[0].name,"read_file");assert.equal(wire.payload.success,false);assert.equal(c.snapshot().missingCalls,0);
  const partial=record("partial-after-restart",{type:"user",content:"x".repeat(80000)});
  await fs.appendFile(file,partial.slice(0,40000));for(let i=0;i<12;i++){await c.tick();now+=1000;}
  state=JSON.parse(await fs.readFile(path.join(f.stateDir,"checkpoint.json"),"utf8"));assert.equal(state.parked[0].awaitingMore,true);
  await c.close();c=new KiroCollector(options);await c.open();await fs.appendFile(file,partial.slice(40000)+"\n");
  for(let i=0;i<20&&!captured.some(r=>r["source.event.id"]==="partial-after-restart");i++){await c.tick();now+=1000;}
  assert.equal(captured.filter(r=>r["source.event.id"]==="partial-after-restart").length,1);
  for(let i=0;i<4;i++){await c.tick();now+=1000;}
  await fs.writeFile(file,user("rewritten-source"));
  for(let i=0;i<20&&!captured.some(r=>r["source.event.id"]==="rewritten-source");i++){await c.tick();now+=1000;}
  assert.equal(captured.filter(r=>r["source.event.id"]==="rewritten-source").length,1);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("version-1 checkpoint migration preserves an uncertain exact-envelope retry",async()=>{
 const f=await fixture();let now=1_792_434_600_000;await session(f,1,user("migration-prompt"));const sent:Array<{body:string,key:string}>=[];
 let c=new KiroCollector({...f,now:()=>now,post:async(body,key)=>{sent.push({body,key});return "retry";}});
 try{await c.open();await c.tick();await c.tick();await c.close();
  const checkpoint=path.join(f.stateDir,"checkpoint.json"),state=JSON.parse(await fs.readFile(checkpoint,"utf8"));state.version=1;delete state.parked;delete state.retirementCursor;
  for(const row of state.sessions){delete row.activationOffset;delete row.observedSize;delete row.observedMtimeMs;}
  await fs.writeFile(checkpoint,JSON.stringify(state));now+=2000;
  c=new KiroCollector({...f,now:()=>now,post:async(body,key)=>{sent.push({body,key});return "ok";}});await c.open();await c.tick();
  assert.deepEqual(sent[1],sent[0]);assert.equal(JSON.parse(await fs.readFile(checkpoint,"utf8")).version,3);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("registry exhaustion is explicit and malformed or oversized persisted registries remain intact",async()=>{
 const f=await fixture();let now=1_792_434_600_000;await session(f,9000,user("over-capacity"));await fs.mkdir(f.stateDir,{recursive:true});
 const parked=Array.from({length:KIRO_LIMITS.registeredSessions},(_,i)=>({id:sid(i+1),relative:`${workspace}/${sid(i+1)}`,physical:"1:1",offset:0,observedSize:0,observedMtimeMs:0,awaitingMore:true,records:{seen:[],calls:[]}}));
 const state={version:2,rootHash:createHash("sha256").update(path.resolve(f.sourceRoot)).digest("hex"),destinationHash:f.destinationHash,cursor:0,retirementCursor:0,sessions:[],parked};
 const checkpoint=path.join(f.stateDir,"checkpoint.json");await fs.writeFile(checkpoint,JSON.stringify(state));let posts=0;
 let c=new KiroCollector({...f,now:()=>now,post:async()=>{posts++;return "ok";}});
 try{await c.open();const health=await c.tick();assert.equal(health.status,"capacity");assert.equal(health.parkedSessions,8192);assert.ok(health.discoveryOverflow>0);assert.equal(posts,0);await c.close();
  const invalid={...state,parked:[...parked,{...parked[0],id:sid(9001),relative:`${workspace}/${sid(9001)}`}]};const original=JSON.stringify(invalid);await fs.writeFile(checkpoint,original);
  c=new KiroCollector({...f,post:async()=>"ok"});await assert.rejects(c.open(),/checkpoint registry/);assert.equal(await fs.readFile(checkpoint,"utf8"),original);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("checkpoint byte capacity is reserved before HTTP and preserves the previous cursor file",async()=>{
 const f=await fixture();await session(f,9000,user("over-byte-capacity"));await fs.mkdir(f.stateDir,{recursive:true});
 const parked=Array.from({length:KIRO_LIMITS.registeredSessions-1},(_,i)=>({id:sid(i+1),relative:`${workspace}/${sid(i+1)}`,physical:"1:1",offset:0,observedSize:0,observedMtimeMs:0,awaitingMore:true,records:{seen:[] as string[][],calls:[] as Array<{id:string;name:string;executionId:string;input:string}>}}));
 const state={version:2,rootHash:createHash("sha256").update(path.resolve(f.sourceRoot)).digest("hex"),destinationHash:f.destinationHash,cursor:0,retirementCursor:0,sessions:[],parked};
 const target=KIRO_LIMITS.checkpointBytes-320;let bytes=Buffer.byteLength(JSON.stringify(state))+1,n=0;
 while(bytes<target){
  const row=parked[n%parked.length];const call={id:`call-${n++}`,name:"read_file",executionId:"fixture-turn",input:'{"path":"'+"x".repeat(1000)+'"}'};
  const comma=row.records.calls.length?1:0,full=Buffer.byteLength(JSON.stringify(call))+comma,remaining=target-bytes;
  if(remaining>=full){row.records.calls.push(call);bytes+=full;continue;}
  call.input='{"path":""}';const base=Buffer.byteLength(JSON.stringify(call))+comma;
  if(remaining>=base){call.input='{"path":"'+"x".repeat(remaining-base)+'"}';row.records.calls.push(call);bytes=target;}
  else{parked[0].records.calls[0].id+="q".repeat(remaining);bytes=target;}
 }
 const checkpoint=path.join(f.stateDir,"checkpoint.json");await fs.writeFile(checkpoint,JSON.stringify(state)+"\n");assert.equal((await fs.stat(checkpoint)).size,target);
 let posts=0;let c=new KiroCollector({...f,post:async()=>{posts++;return "ok";}});
 try{await c.open();const previous=await fs.readFile(checkpoint);const health=await c.tick();assert.equal(health.status,"capacity");assert.equal(posts,0);assert.equal(health.pending,false);assert.deepEqual(await fs.readFile(checkpoint),previous);await assert.rejects(fs.stat(path.join(f.stateDir,"pending.json")),{code:"ENOENT"});
  await c.close();await fs.rm(checkpoint);
  await fs.writeFile(path.join(f.sourceRoot,workspace,sid(9000),"messages.jsonl"),Array.from({length:128},(_,i)=>user(`uncertain-${i}`)).join(""));
  c=new KiroCollector({...f,post:async()=>{posts++;return "ok";}});await c.open();await c.tick();await c.close();
  const warm=JSON.parse(await fs.readFile(checkpoint,"utf8")),pending=await fs.readFile(path.join(f.stateDir,"pending.json"));
  await fs.writeFile(checkpoint,JSON.stringify({...state,sessions:warm.sessions,parked:parked.slice(1)})+"\n");
  c=new KiroCollector({...f,post:async()=>{posts++;return "ok";}});await c.open();const beforeRetry=await fs.readFile(checkpoint);const retry=await c.tick();
  assert.equal(retry.status,"capacity");assert.equal(retry.pending,true);assert.equal(posts,0);assert.deepEqual(await fs.readFile(checkpoint),beforeRetry);assert.deepEqual(await fs.readFile(path.join(f.stateDir,"pending.json")),pending,"uncertain retry bytes and attempt metadata remain intact when commit capacity is unavailable");
 }
 finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("unsupported historical sessions cannot retain every parser slot",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const emitted:string[]=[];
 for(let n=1;n<=129;n++){await session(f,n,user(`unsupported-${n}`));await fs.writeFile(path.join(f.sourceRoot,workspace,sid(n),"session.json"),JSON.stringify({schemaVersion:"99",dataModelVersion:1,id:sid(n)}));}
 await session(f,130,user("supported-late-peer"));const c=new KiroCollector({...f,now:()=>now,post:async body=>{emitted.push(...logs(body).map((l:any)=>attrs(l)["source.event.id"]));return "ok";}});
 try{await c.open();for(let i=0;i<160&&!emitted.length;i++){await c.tick();now+=1000;}
  assert.deepEqual(emitted,["supported-late-peer"]);assert.ok(c.snapshot().unsupportedSessions>0);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("a dormant source promoted beside a duplicate path stays quarantined under one owner",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const emitted:string[]=[];const file=await session(f,1,user("acknowledged-prefix"));
 const c=new KiroCollector({...f,now:()=>now,post:async body=>{emitted.push(...logs(body).map((l:any)=>attrs(l)["source.event.id"]));return "ok";}});
 try{await c.open();for(let i=0;i<6;i++){await c.tick();now+=1000;}assert.equal(c.snapshot().parkedSessions,1);
  await fs.appendFile(file,user("ambiguous-resume"));const duplicate=path.join(f.sourceRoot,"1111111111111111",sid(1));await fs.mkdir(duplicate,{recursive:true});await fs.copyFile(path.join(path.dirname(file),"session.json"),path.join(duplicate,"session.json"));await fs.writeFile(path.join(duplicate,"messages.jsonl"),user("other-owner"));
  for(let i=0;i<20&&!c.snapshot().sourceConflicts;i++){await c.tick();now+=1000;}
  assert.equal(c.snapshot().sourceConflicts,1);assert.deepEqual(emitted,["acknowledged-prefix"]);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("workspace handle capacity is bounded and visible instead of silently skipping later projects",async(t)=>{
 let rootOpened=false;const handles:Array<{closed:boolean;read:()=>Promise<any>;close:()=>Promise<void>}>=[];
 const mocked=t.mock.method(fs,"opendir",async(file:any)=>{
  const root=!rootOpened;rootOpened=true;let cursor=0;const index=handles.length;
  const handle={closed:false,read:async()=>{
   if(root){if(cursor>=129)return null;return {name:(++cursor).toString(16).padStart(16,"0"),isDirectory:()=>true};}
   return {name:sid(index*100000+(++cursor)),isDirectory:()=>true};
  },close:async()=>{handle.closed=true;}};handles.push(handle);return handle as any;
 });
 const discovery=new KiroDiscovery();
 try{for(let i=0;i<9;i++)await discovery.scan("/bounded-fixture",0,100,()=>0);assert.equal(discovery.workspaces.size,128);assert.equal(discovery.overflow,1);assert.ok(handles.length<=129);}
 finally{await discovery.close();mocked.mock.restore();assert.ok(handles.every(handle=>handle.closed));}
});

test("yielded immutable backfill reuses bounded unread tails instead of rereading each source prefix",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const body="{}\n".repeat(10000);await session(f,1,body);const c=new KiroCollector({...f,now:()=>now,post:async()=>"ok"});
 try{await c.open();let done=false;for(let i=0;i<400;i++){const h=await c.tick();now+=1000;if(h.malformedRecords===10000){done=true;break;}}
  assert.ok(done);assert.equal(c.snapshot().readBytes,Buffer.byteLength(body));assert.equal(c.snapshot().carryEvictions,0);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("RAM tail eviction stays bounded while all 300 backfill cursors advance exactly once",async()=>{
 const f=await fixture();let now=1_792_434_600_000;for(let n=1;n<=300;n++)await session(f,n,"{}\n".repeat(4000));
 const c=new KiroCollector({...f,now:()=>now,post:async()=>{throw new Error("malformed fixtures cannot emit logs");}});
 try{await c.open();let complete=false;
  for(let i=0;i<400;i++){const h=await c.tick();now+=1000;assert.ok(h.cachedTailSessions<=KIRO_LIMITS.carrySessions);assert.ok(h.cachedTailBytes<=KIRO_LIMITS.carryBytes);
   if(h.carryEvictions){const state=JSON.parse(await fs.readFile(path.join(f.stateDir,"checkpoint.json"),"utf8")),rows=[...state.sessions,...state.parked];assert.equal(rows.reduce((n:number,row:any)=>n+row.offset,0)/3,h.malformedRecords);if(rows.length===300&&rows.every((row:any)=>row.offset>0)){complete=true;break;}}
  }
  assert.ok(complete,"late cursors advance even when earlier unread tails must be evicted");
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("oversized unterminated records remain skippable and counted after dormant restart",async()=>{
 const f=await fixture();let now=1_792_434_600_000;const file=await session(f,1,"x".repeat(300000));const emitted:string[]=[];const opts={...f,now:()=>now,post:async(body:string)=>{emitted.push(...logs(body).map((l:any)=>attrs(l)["source.event.id"]));return "ok" as const;}};let c=new KiroCollector(opts);
 try{await c.open();for(let i=0;i<12;i++){await c.tick();now+=1000;}let state=JSON.parse(await fs.readFile(path.join(f.stateDir,"checkpoint.json"),"utf8"));assert.equal(state.parked[0].skippingOversize,true);assert.equal(state.parked[0].awaitingMore,true);
  await c.close();c=new KiroCollector(opts);await c.open();await fs.appendFile(file,"\n"+user("after-oversize-restart"));for(let i=0;i<30&&!emitted.length;i++){await c.tick();now+=1000;}
  assert.deepEqual(emitted,["after-oversize-restart"]);assert.equal(c.snapshot().oversizeRecords,1);
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("128 oversized unfinished sources yield before EOF so a new small session is not starved",async()=>{
 const f=await fixture();let now=1_792_434_600_000;for(let n=1;n<=128;n++)await session(f,n,"x".repeat(300000));await session(f,9000,user("late-small-session"));await fs.mkdir(f.stateDir,{recursive:true});
 const initial={version:1,rootHash:createHash("sha256").update(path.resolve(f.sourceRoot)).digest("hex"),destinationHash:f.destinationHash,cursor:0,sessions:Array.from({length:128},(_,i)=>({id:sid(i+1),relative:`${workspace}/${sid(i+1)}`,physical:"",offset:0,records:{seen:[],calls:[]}}))};await fs.writeFile(path.join(f.stateDir,"checkpoint.json"),JSON.stringify(initial));
 const emitted:string[]=[];const c=new KiroCollector({...f,now:()=>now,post:async body=>{emitted.push(...logs(body).map((l:any)=>attrs(l)["source.event.id"]));return "ok";}});
 try{await c.open();for(let i=0;i<160&&!emitted.length;i++){await c.tick();now+=1000;}
  assert.deepEqual(emitted,["late-small-session"]);assert.ok(c.snapshot().readBytes<128*KIRO_LIMITS.readBytesPerSession*4,"a new peer must not wait for all giant sources to reach physical EOF");
 }finally{await c.close();await fs.rm(f.root,{recursive:true,force:true});}
});
