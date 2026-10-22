import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KiroCollector } from "../../src/client/kiro/collector.ts";
import { KIRO_LIMITS } from "../../src/client/kiro/records.ts";

const id = "sess_0d9782e1-c28a-4107-ac98-5033e20ee658";
const workspace = "0000000000000000";
const sourceTime = "2026-10-19T18:28:13.699Z";
const user = (event: string) => JSON.stringify({id: event, timestamp: sourceTime, payload: {type: "user", content: "private source text"}});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-collector-test-"));
  const sourceRoot = path.join(root, "source"), stateDir = path.join(root, "state");
  const session = path.join(sourceRoot, workspace, id);
  await fs.mkdir(session, {recursive: true});
  await fs.writeFile(path.join(session, "session.json"), JSON.stringify({schemaVersion: "1.0.0", dataModelVersion: 1, id}));
  const messages = path.join(session, "messages.jsonl");
  await fs.writeFile(messages, "");
  return {root, sourceRoot, stateDir, messages, session, destinationHash: "a".repeat(64)};
}

test("append/partial lines and restart preserve exact spool bytes/key and acknowledge-only offsets", async () => {
  const f = await fixture(); let now = 1_792_434_600_000;
  const requests: Array<{body: string; key: string}> = [];
  let first = true;
  let collector = new KiroCollector({...f, now: () => now, post: async (body, key) => {requests.push({body, key}); return first ? "retry" : "ok";}});
  try {
    await fs.writeFile(f.messages, user("prompt-first") + "\n" + user("prompt-partial").slice(0, 30));
    await collector.open(); await collector.tick();
    let checkpoint = JSON.parse(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8"));
    assert.equal(checkpoint.sessions[0].offset, 0);
    const pending = JSON.parse(await fs.readFile(path.join(f.stateDir, "pending.json"), "utf8"));
    assert.doesNotMatch(JSON.stringify(pending), /private source text/);
    await collector.tick();
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8")).sessions[0].offset, 0);
    await collector.close(); first = false; now += 2000;
    collector = new KiroCollector({...f, now: () => now, post: async (body, key) => {requests.push({body, key}); return "ok";}});
    await collector.open(); await collector.tick();
    assert.deepEqual(requests[1], requests[0]);
    checkpoint = JSON.parse(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8"));
    assert.equal(checkpoint.sessions[0].offset, Buffer.byteLength(user("prompt-first") + "\n"));
    assert.equal(await fs.stat(path.join(f.stateDir, "checkpoint.json")).then(stat => stat.mode & 0o777), 0o600);
    await fs.appendFile(f.messages, user("prompt-partial").slice(30) + "\n");
    await collector.tick(); now += 1000; await collector.tick();
    assert.equal(requests.length, 3);
    const events = requests.flatMap(request => JSON.parse(request.body).resourceLogs[0].scopeLogs[0].logRecords);
    assert.equal(events.filter((event: any) => event.attributes.some((a: any) => a.key === "prompt.id" && a.value.stringValue === "prompt-partial")).length, 1);
  } finally {await collector.close(); await fs.rm(f.root, {recursive: true, force: true});}
});

test("same-inode truncation/rewrite starts a new physical generation without mistaking it for an ack", async () => {
  const f = await fixture(); let now = 1_792_434_600_000; const bodies: string[] = [];
  const collector = new KiroCollector({...f, now: () => now, post: async body => {bodies.push(body); return "ok";}});
  try {
    await fs.writeFile(f.messages, user("original-long-source-record") + "\n");
    await collector.open(); await collector.tick(); await collector.tick();
    await fs.writeFile(f.messages, user("new") + "\n"); now += 1000;
    await collector.tick(); await collector.tick();
    assert.equal(bodies.length, 2);
    const checkpoint = JSON.parse(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8"));
    assert.equal(checkpoint.sessions[0].generation, 2);
    assert.equal(checkpoint.sessions[0].offset, Buffer.byteLength(user("new") + "\n"));
  } finally {await collector.close(); await fs.rm(f.root, {recursive: true, force: true});}
});

test("partial and oversized lines stay bounded while a small peer is served fairly", async () => {
  const f = await fixture(); let now = 1_792_434_600_000; const bodies: string[] = [];
  const peerId = "sess_11111111-1111-4111-8111-111111111111";
  const peer = path.join(f.sourceRoot, workspace, peerId);
  await fs.mkdir(peer); await fs.writeFile(path.join(peer, "session.json"), JSON.stringify({schemaVersion: "1.0.0", dataModelVersion: 1, id: peerId}));
  await fs.writeFile(path.join(peer, "messages.jsonl"), user("small-peer") + "\n");
  await fs.writeFile(f.messages, "x".repeat(KIRO_LIMITS.recordBytes * 2) + "\n" + user("after-oversize") + "\n");
  const collector = new KiroCollector({...f, now: () => now, post: async body => {bodies.push(body); return "ok";}});
  try {
    await collector.open();
    for (let i = 0; i < 12; i++) {await collector.tick(); now += 1000;}
    assert.ok(bodies.some(body => body.includes("small-peer")));
    assert.ok(bodies.some(body => body.includes("after-oversize")));
    assert.equal(collector.snapshot().oversizeRecords, 1);
    assert.ok((await fs.stat(path.join(f.stateDir, "checkpoint.json"))).size < KIRO_LIMITS.checkpointBytes);
    assert.doesNotMatch(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8"), /xxxxx|private source text/);
  } finally {await collector.close(); await fs.rm(f.root, {recursive: true, force: true});}
});

test("unsupported source versions and an existing live state owner fail visibly", async () => {
  const f = await fixture(); const collector = new KiroCollector({...f, post: async () => {throw new Error("must not upload");}});
  const other = new KiroCollector({...f, post: async () => "ok"});
  try {
    await fs.writeFile(f.messages, user("unsupported") + "\n");
    await fs.writeFile(path.join(f.session, "session.json"), JSON.stringify({schemaVersion: "2.0.0", dataModelVersion: 2, id}));
    await collector.open(); await assert.rejects(other.open(), /already running/);
    assert.equal((await collector.tick()).unsupportedSessions, 1);
    assert.equal(collector.snapshot().pending, false);
  } finally {await collector.close(); await other.close(); await fs.rm(f.root, {recursive: true, force: true});}
});

test("normal onboarding baselines existing sessions but captures new sessions and later appends", async () => {
  const f = await fixture(); let now = 1_792_434_600_000; const bodies: string[] = [];
  await fs.writeFile(path.join(f.session, "session.json"), JSON.stringify({schemaVersion: "1.0.0", dataModelVersion: 1, id, createdAt: "2026-10-18T00:00:00.000Z"}));
  await fs.writeFile(f.messages, user("before-connect") + "\n");
  const collector = new KiroCollector({...f, bootstrap: "end", now: () => now, post: async body => {bodies.push(body); return "ok";}});
  try {
    await collector.open(); await collector.tick(); assert.equal(bodies.length, 0);
    await fs.appendFile(f.messages, user("after-connect") + "\n");
    now += 2000; // Dormant sources use the bounded discovery cadence.
    await collector.tick(); await collector.tick();
    assert.equal(bodies.length, 1); assert.ok(bodies[0].includes("after-connect"));
    assert.ok(!bodies[0].includes("before-connect"));
  } finally {await collector.close(); await fs.rm(f.root, {recursive: true, force: true});}
});

test("expired uncertain retries stop with the original spool and source offset intact", async () => {
  const f = await fixture(); let now = 1_792_434_600_000; let sent = 0;
  const collector = new KiroCollector({...f, now: () => now, post: async () => {sent++; return "retry";}});
  try {
    await fs.writeFile(f.messages, user("offline-source") + "\n");
    await collector.open(); await collector.tick(); await collector.tick();
    now += KIRO_LIMITS.retryHorizonMs;
    assert.equal((await collector.tick()).status, "retry_horizon_exhausted");
    assert.equal(sent, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8")).sessions[0].offset, 0);
    assert.ok((await fs.stat(path.join(f.stateDir, "pending.json"))).isFile());
  } finally {await collector.close(); await fs.rm(f.root, {recursive: true, force: true});}
});

test("a source conflict after a valid prefix cannot erase the prefix batch", async () => {
  const f = await fixture(); const bodies: string[] = [];
  const collector = new KiroCollector({...f, post: async body => {bodies.push(body); return "ok";}});
  try {
    const first = user("conflicting-id"); const changed = JSON.parse(first); changed.payload.content = "changed";
    await fs.writeFile(f.messages, first + "\n" + JSON.stringify(changed) + "\n");
    await collector.open(); assert.equal((await collector.tick()).sourceConflicts, 1);
    await collector.tick(); assert.equal(bodies.length, 1);
    assert.equal(JSON.parse(bodies[0]).resourceLogs[0].scopeLogs[0].logRecords.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir, "checkpoint.json"), "utf8")).sessions[0].offset, Buffer.byteLength(first + "\n"));
  } finally {await collector.close(); await fs.rm(f.root, {recursive: true, force: true});}
});


test("pending delivery cannot move to a different destination fingerprint", async () => {
  const f = await fixture(); let uploads = 0;
  const first = new KiroCollector({...f, post: async () => {uploads++; return "retry";}});
  const next = new KiroCollector({...f, destinationHash: "b".repeat(64), post: async () => {uploads++; return "ok";}});
  try {
    await fs.writeFile(f.messages, user("destination-bound") + "\n");
    await first.open(); await first.tick(); await first.close();
    const spool = await fs.readFile(path.join(f.stateDir, "pending.json"), "utf8");
    await assert.rejects(next.open(), /checkpoint contract/);
    assert.equal(uploads, 0);
    assert.equal(await fs.readFile(path.join(f.stateDir, "pending.json"), "utf8"), spool);
  } finally {await first.close(); await next.close(); await fs.rm(f.root, {recursive:true,force:true});}
});

test("legacy metadata retries remain exact while old content retries are preserved without posting",async()=>{
 for(const content of [false,true]){
  const f=await fixture();let now=1792434600000,posts=0;
  const options={...f,now:()=>now,policy:{prompts:content,toolDetails:content},post:async()=>{posts++;return "retry" as const;}};
  let collector=new KiroCollector(options);
  try{
   await fs.writeFile(f.messages,user("legacy-spool")+"\n");await collector.open();await collector.tick();await collector.close();
   const file=path.join(f.stateDir,"pending.json"),pending=JSON.parse(await fs.readFile(file,"utf8"));
   delete pending.privacyVersion;await fs.writeFile(file,JSON.stringify(pending));
   const original=await fs.readFile(file,"utf8"),checkpoint=await fs.readFile(path.join(f.stateDir,"checkpoint.json"),"utf8");
   collector=new KiroCollector(options);now+=2000;
   if(content){
    await assert.rejects(collector.open(),/older privacy contract/);
    assert.equal(posts,0);assert.equal(await fs.readFile(file,"utf8"),original);
    assert.equal(await fs.readFile(path.join(f.stateDir,"checkpoint.json"),"utf8"),checkpoint);
   }else{
    await collector.open();await collector.tick();assert.equal(posts,1);
    const retried=JSON.parse(await fs.readFile(file,"utf8"));assert.equal(retried.body,pending.body);assert.equal(retried.id,pending.id);
   }
  }finally{await collector.close();await fs.rm(f.root,{recursive:true,force:true});}
 }
});
