import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { run } from "../../src/client/cli.ts";
import { onboard } from "../../src/client/onboard.ts";
import { runKiroCommand } from "../../src/client/kiro/command.ts";
import { enableKiroService, disableKiroService, uninstallKiroService } from "../../src/client/kiro/service.ts";
import { KIRO_CAPTURE_CHANGED, readKiroConfig } from "../../src/client/kiro/config.ts";
import { KiroCollector } from "../../src/client/kiro/collector.ts";
const key="cot_synthetic_onboard_test_00000000000";

test("Kiro onboarding stays outside vendor config, metadata-only, with masked results and bounded health",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-onboard-")),file=path.join(root,"config.json");
 try{
  const result=await onboard({client:"kiro",key,settings:{path:file},sendTest:false,verify:false,activateCollector:false,endpoints:{ingestEndpoint:"https://ingest.invalid"}});
  assert.equal(result.ok,true);assert(!JSON.stringify(result).includes(key));
  const config=JSON.parse(await fs.readFile(file,"utf8"));assert.deepEqual(config.content,{prompts:false,toolDetails:false});assert.equal(config.backfill,false);
  config.stateDir=path.join(root,"state");await fs.writeFile(file,JSON.stringify(config));await fs.mkdir(config.stateDir);
  await fs.writeFile(path.join(config.stateDir,"health.json"),JSON.stringify({version:1,status:"idle",pending:true,trackedSessions:2,diagnosticSecret:key}));
  const output:string[]=[];assert.equal(await runKiroCommand(["status"],{settings:file,json:true},s=>output.push(s)),0);
  assert(!output.join("").includes(key));const health=JSON.parse(output[0]);assert.equal(health.running,false);assert.equal(health.health.trackedSessions,2);
  assert.equal(await runKiroCommand(["status"],{settings:true},()=>{}),1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("owned background install, stop and uninstall never modify Kiro settings or expose keys",async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-service-")),file=path.join(home,"config.json"),source=path.join(home,"runtime-source");
 try{
  await onboard({client:"kiro",key,settings:{path:file},sendTest:false,verify:false,activateCollector:false});
  await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,"bin.ts"),'import "../../src/client/cli.ts";');await fs.writeFile(path.join(source,"cli.ts"),"export {};\n");
  const calls:string[][]=[];const opts={home,platform:"linux" as const,runtimeSource:source,node:"/usr/local/bin/node",execute:(cmd:string,args:string[])=>{calls.push([cmd,...args]);return "";}};
  assert.equal((await enableKiroService(file,opts)).ok,true);
  const unit=await fs.readFile(path.join(home,".config/systemd/user/codetelemetry-kiro-v3.service"),"utf8");
  assert.match(unit,/kiro collect/);assert(!unit.includes(key));assert(!JSON.stringify(calls).includes(key));
  const failed=await enableKiroService(file,{...opts,execute:()=>{throw Error(key);}});
  assert.equal(failed.ok,false);assert(!failed.detail.includes(key));
  assert.equal((await disableKiroService(file,opts)).ok,true);assert.equal(JSON.parse(await fs.readFile(file,"utf8")).enabled,false);
  assert.equal(uninstallKiroService(file,opts).ok,true);
  await assert.rejects(fs.stat(path.join(home,".kiro")));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});


test("Kiro cannot silently import another assistant's history",async()=>{
 assert.equal(await run(["import","--client","kiro","--dry-run"]),1);
});


test("project scope is rejected before requesting a key or configuring broad capture",async()=>{
 let requested=false;
 await assert.rejects(onboard({client:"kiro",settings:{scope:"project"},getKey:async()=>{requested=true;throw Error("must not request");}}),/project scope/);
 assert.equal(requested,false);
});

test("one-shot collection closes ownership and never reports its still-alive caller as a running collector",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-once-")),file=path.join(root,"config.json");
 try{
  await onboard({client:"kiro",key,settings:{path:file},sendTest:false,verify:false,activateCollector:false});
  const config=JSON.parse(await fs.readFile(file,"utf8"));config.sourceRoot=path.join(root,"source");config.stateDir=path.join(root,"state");
  await fs.mkdir(config.sourceRoot);await fs.writeFile(file,JSON.stringify(config));
  assert.equal(await runKiroCommand(["collect"],{settings:file,once:true},()=>{}),0);
  const output:string[]=[];await runKiroCommand(["status"],{settings:file,json:true},s=>output.push(s));
  assert.equal(JSON.parse(output[0]).running,false);
  assert(!output.join("").includes(key));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("--enrich turns capture on, --no-enrich turns it off, and neither flag keeps the stored choice",async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-capture-")),file=path.join(home,"config.json"),source=path.join(home,"runtime-source");
 try{
  await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,"bin.ts"),'import "../../src/client/cli.ts";');await fs.writeFile(path.join(source,"cli.ts"),"export {};\n");
  // The service manager is a recorder: no real systemctl or launchctl is called.
  const calls:string[][]=[];const kiro={home,platform:"linux" as const,runtimeSource:source,node:"/usr/local/bin/node",execute:(cmd:string,args:string[])=>{calls.push([cmd,...args]);return "";}};
  const login=(...flags:string[])=>run([key,"--client","kiro","--settings",file,"--endpoint","https://ingest.invalid","--no-test","--no-verify","--json",...flags],{kiro});
  const content=async()=>JSON.parse(await fs.readFile(file,"utf8")).content;
  const on={prompts:true,toolDetails:true},off={prompts:false,toolDetails:false};
  assert.equal(await login(),0);assert.deepEqual(await content(),off);
  assert.equal(await login("--enrich"),0);assert.deepEqual(await content(),on);
  assert.equal(await login(),0);assert.deepEqual(await content(),on);
  assert.equal(await login("--no-enrich"),0);assert.deepEqual(await content(),off);
  assert.equal(await login(),0);assert.deepEqual(await content(),off);
  const before=await fs.readFile(file,"utf8");
  assert.equal(await login("--enrich=yes"),1);assert.equal(await fs.readFile(file,"utf8"),before);
  assert.ok(calls.length>0);assert(!JSON.stringify(calls).includes(key));
  await assert.rejects(fs.stat(path.join(home,".kiro")));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test("the config writer treats capture as three states for every caller",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-capture-writer-")),file=path.join(root,"config.json");
 try{
  const write=(enrich?:boolean)=>onboard({client:"kiro",key,settings:{path:file,enrich},sendTest:false,verify:false,activateCollector:false,endpoints:{ingestEndpoint:"https://ingest.invalid"}});
  const content=async()=>JSON.parse(await fs.readFile(file,"utf8")).content;
  await write(true);assert.deepEqual(await content(),{prompts:true,toolDetails:true});
  await write();assert.deepEqual(await content(),{prompts:true,toolDetails:true});
  await write(false);assert.deepEqual(await content(),{prompts:false,toolDetails:false});
  await write();assert.deepEqual(await content(),{prompts:false,toolDetails:false});
  // A stored choice that turned on only one kind of content is kept as it is.
  const config=JSON.parse(await fs.readFile(file,"utf8"));config.content={prompts:true,toolDetails:false};await fs.writeFile(file,JSON.stringify(config));
  await write();assert.deepEqual(await content(),{prompts:true,toolDetails:false});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("a login that changes capture says so and records the replaced choice; an unchanged login does neither",async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-capture-change-")),file=path.join(home,"config.json"),source=path.join(home,"runtime-source");
 try{
  await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,"bin.ts"),'import "../../src/client/cli.ts";');await fs.writeFile(path.join(source,"cli.ts"),"export {};\n");
  const kiro={home,platform:"linux" as const,runtimeSource:source,node:"/usr/local/bin/node",execute:()=>""};
  const lines:string[]=[],write=process.stdout.write;
  const login=async(...flags:string[])=>{
   lines.length=0;process.stdout.write=((chunk:unknown)=>{lines.push(String(chunk));return true;}) as typeof process.stdout.write;
   try{return await run([key,"--client","kiro","--settings",file,"--endpoint","https://ingest.invalid","--no-test","--no-verify",...flags],{kiro});}finally{process.stdout.write=write;}
  };
  const told=()=>lines.some(line=>line.includes(KIRO_CAPTURE_CHANGED));
  const on={prompts:true,toolDetails:true},off={prompts:false,toolDetails:false};
  assert.equal(await login(),0);assert.equal(told(),false);assert.equal(readKiroConfig(file).supersededContent,undefined);
  assert.equal(await login("--enrich"),0);assert.equal(told(),true);assert.deepEqual(readKiroConfig(file).supersededContent,off);
  // Nothing changes: no message, and the recorded change stays until the collector has acted on it.
  assert.equal(await login("--enrich"),0);assert.equal(told(),false);assert.deepEqual(readKiroConfig(file).supersededContent,off);
  assert.equal(await login(),0);assert.equal(told(),false);assert.deepEqual(readKiroConfig(file).supersededContent,off);
  assert.equal(await login("--no-enrich"),0);assert.equal(told(),true);assert.deepEqual(readKiroConfig(file).supersededContent,on);
  assert.deepEqual(readKiroConfig(file).content,off);
  assert(!lines.join("\n").includes(key));
  const result=await onboard({client:"kiro",key,settings:{path:file,enrich:true},sendTest:false,verify:false,activateCollector:false,endpoints:{ingestEndpoint:"https://ingest.invalid"}});
  assert.equal(result.steps.find(step=>step.name==="capture_changed")?.detail,KIRO_CAPTURE_CHANGED);
  const broken=JSON.parse(await fs.readFile(file,"utf8"));broken.supersededContent={prompts:"yes"};await fs.writeFile(file,JSON.stringify(broken));
  assert.throws(()=>readKiroConfig(file),/invalid Kiro collector config fields/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test("turning capture off at login lets the collector start, discard the unsent upload and send its records without content",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"kiro-capture-restart-")),file=path.join(root,"config.json");
 const sourceRoot=path.join(root,"source"),stateDir=path.join(root,"state"),id="sess_0d9782e1-c28a-4107-ac98-5033e20ee658",session=path.join(sourceRoot,"0000000000000000",id);
 try{
  const write=(enrich?:boolean)=>onboard({client:"kiro",key,settings:{path:file,enrich},sendTest:false,verify:false,activateCollector:false,endpoints:{ingestEndpoint:"https://ingest.invalid"}});
  await write(true);
  await fs.mkdir(session,{recursive:true});
  await fs.writeFile(path.join(session,"session.json"),JSON.stringify({schemaVersion:"1.0.0",dataModelVersion:1,id}));
  await fs.writeFile(path.join(session,"messages.jsonl"),JSON.stringify({id:"before-turn-off",timestamp:"2026-10-19T18:28:13.699Z",payload:{type:"user",content:"synthetic prompt text"}})+"\n");
  // The collector is built from the stored config the way `kiro collect` builds it.
  const bodies:string[]=[];let outcome:"retry"|"ok"="retry";
  const collector=()=>{const config=readKiroConfig(file);return new KiroCollector({sourceRoot,stateDir,destinationHash:"a".repeat(64),policy:config.content,supersededPolicy:config.supersededContent,
   bootstrap:"start",post:async body=>{bodies.push(body);return outcome;}});};
  const first=collector();
  try{await first.open();await first.tick();await first.tick();}finally{await first.close();}
  assert.match(JSON.parse(await fs.readFile(path.join(stateDir,"pending.json"),"utf8")).body,/synthetic prompt text/);
  await write(false);bodies.length=0;outcome="ok";
  const next=collector();
  try{
   await next.open();await next.tick();await next.tick();
   assert.equal(bodies.length,1);assert.match(bodies[0],/before-turn-off/);assert.doesNotMatch(bodies[0],/synthetic prompt text/);
   assert.equal(next.snapshot().pending,false);
  }finally{await next.close();}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
