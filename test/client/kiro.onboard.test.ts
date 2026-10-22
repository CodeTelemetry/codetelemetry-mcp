import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { run } from "../../src/client/cli.ts";
import { onboard } from "../../src/client/onboard.ts";
import { runKiroCommand } from "../../src/client/kiro/command.ts";
import { enableKiroService, disableKiroService, uninstallKiroService } from "../../src/client/kiro/service.ts";
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
