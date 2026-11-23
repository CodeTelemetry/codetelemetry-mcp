import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyKiroRecord, emptyRecordCounters, emptyRecordState, KIRO_LIMITS, KiroSourceConflictError } from "../../src/client/kiro/records.ts";
import { NO_CONTENT } from "../../src/client/import/model.ts";

const lines = readFileSync(new URL("./fixtures/kiro-v3/transcript-fixture.jsonl", import.meta.url), "utf8").trim().split("\n");
const sessionId = "sess_0d9782e1-c28a-4107-ac98-5033e20ee658";
const source = (log: any): any => JSON.parse(log.attributes["kiro.source.record"]);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test("saved corpus captures bounded native source records without product interpretation or content", () => {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  const logs = lines.flatMap(line => applyKiroRecord(state, Buffer.from(line), sessionId, NO_CONTENT, counters));
  assert.ok(logs.every(log => log.attributes["event.name"] === "kiro.source_record"));
  assert.deepEqual(logs.map(log => source(log).payload.type), ["user","tool_result","tool_result","usage_summary","turn_end"]);
  assert.deepEqual(source(logs[3]).payload.promptTurnSummaries, JSON.parse(lines[5]).payload.promptTurnSummaries.map((v:any) => ({unit:v.unit,usage:v.usage})));
  assert.equal(logs[0].timeUnixNano,"1792434493699000000");
  assert.doesNotMatch(JSON.stringify(logs), /synthetic\/workspace|Telemetry experiment|Caught error|reasoning|signature|duration_ms|input_tokens|cost_usd/);
  assert.equal(state.calls.length,0);
  assert.deepEqual(counters,emptyRecordCounters());
  assert.equal(lines.flatMap(line => applyKiroRecord(state,Buffer.from(line),sessionId,NO_CONTENT,counters)).length,0);
  assert.equal(counters.duplicates,7);
});

test("same source ID with changed content fails without overwriting source ownership", () => {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  const original = JSON.parse(lines[0]);
  applyKiroRecord(state, bytes(original), sessionId, NO_CONTENT, counters);
  const prior = structuredClone(state);
  assert.throws(() => applyKiroRecord(state, bytes({...original, payload: {...original.payload, content: "changed"}}), sessionId, NO_CONTENT, counters), KiroSourceConflictError);
  assert.deepEqual(state, prior);
});

test("orphan result retains explicit failure without inventing tool name or execution duration", () => {
  const result = applyKiroRecord(emptyRecordState(), Buffer.from(lines[4]), sessionId, NO_CONTENT, emptyRecordCounters())[0];
  assert.equal(source(result).payload.success, false);
  assert.deepEqual(source(result).context, []);
  assert.equal(result.attributes.tool_name, undefined);
  assert.equal(result.attributes.duration_ms, undefined);
});

test("only verified shapes can opt in; secrets are scrubbed before capture", () => {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  const prompt = JSON.parse(lines[0]);
  prompt.payload.content = "api_key=private-value sk-ant-abcdefghijklmnopqrstuvwxyz cot_abcdefghijklmnopqrstuvwxyz123456";
  const captured = applyKiroRecord(state, bytes(prompt), sessionId, {prompts: true, toolDetails: true}, counters)[0];
  assert.doesNotMatch(String(source(captured).payload.content), /private-value|abcdefghijklmnopqrstuvwxyz/);
  const call = JSON.parse(lines[1]);
  call.payload.toolName = "execute_bash";
  call.payload.args = {command: "echo unverified"};
  applyKiroRecord(state, bytes(call), sessionId, {prompts: false, toolDetails: true}, counters);
  const result = applyKiroRecord(state, Buffer.from(lines[2]), sessionId, {prompts: false, toolDetails: true}, counters)[0];
  assert.equal(source(result).context[0].name, "execute_bash");
  assert.equal(source(result).context[0].input, undefined);
  assert.equal(counters.unsupportedDetails, 1);
});

test("call/replay state, malformed/deep records and unknown private payloads stay bounded", () => {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  const call = JSON.parse(lines[1]);
  for (let i = 0; i < KIRO_LIMITS.callsPerSession + 1; i++) {
    applyKiroRecord(state, bytes({...call, id: `call-${i}`, payload: {...call.payload, toolCallId: `tool-${i}`}}), sessionId, NO_CONTENT, counters);
  }
  assert.equal(state.calls.length, KIRO_LIMITS.callsPerSession);
  assert.equal(counters.callsEvicted, 1);
  const prompt = JSON.parse(lines[0]);
  for (let i = 0; i < KIRO_LIMITS.replayEntriesPerSession + 10; i++) applyKiroRecord(state, bytes({...prompt, id: `prompt-${i}`}), sessionId, NO_CONTENT, counters);
  assert.equal(state.seen.length, KIRO_LIMITS.replayEntriesPerSession);
  assert.deepEqual(applyKiroRecord(state, Buffer.alloc(KIRO_LIMITS.recordBytes + 1), sessionId, NO_CONTENT, counters), []);
  assert.deepEqual(applyKiroRecord(state, Buffer.from("{broken"), sessionId, NO_CONTENT, counters), []);
  assert.deepEqual(applyKiroRecord(state, bytes({id: "private", payload: {type: "assistant", reasoningSignature: "do not retain"}}), sessionId, NO_CONTENT, counters), []);
  assert.doesNotMatch(JSON.stringify(state), /do not retain|reasoningSignature/);
  assert.equal(counters.malformed, 2);
  assert.equal(counters.unknown, 1);
});

test("call context survives checkpoint round trips without joining or classifying outcomes", () => {
  const state=emptyRecordState(), counters=emptyRecordCounters(), call=JSON.parse(lines[1]);
  call.payload.toolName="fs_write"; call.payload.status="denied";
  applyKiroRecord(state,bytes(call),sessionId,NO_CONTENT,counters);
  const result=JSON.parse(lines[2]); result.payload.success=true;
  const log=applyKiroRecord(JSON.parse(JSON.stringify(state)),bytes(result),sessionId,NO_CONTENT,counters)[0];
  assert.equal(source(log).context[0].status,"denied");
  assert.equal(source(log).payload.success,true);
  assert.equal(log.attributes.decision,undefined);
});

test("opt-in details reject unverified argument keys and shapes before persistence/export",()=>{
 for(const extra of [{reasoningSignature:"synthetic-do-not-export"},{futureMode:"synthetic-do-not-export"},{offset:{private:"synthetic-do-not-export"}}]) {
  const state=emptyRecordState(),counters=emptyRecordCounters(),call=JSON.parse(lines[1]);
  call.payload.args={path:"/synthetic/input.txt",...extra};
  applyKiroRecord(state,bytes(call),sessionId,{prompts:false,toolDetails:true},counters);
  assert.doesNotMatch(JSON.stringify(state),/synthetic-do-not-export/);
  const logs=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},counters);
  assert.equal(source(logs[0]).context[0].name,"read_file");
  assert.equal(source(logs[0]).context[0].input,undefined);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-do-not-export/);
  assert.equal(counters.unsupportedDetails,1);
 }
});

for(const [name,args] of Object.entries({
  execute_bash:{command:"printf synthetic",cwd:"/synthetic",run_in_background:false},
  fs_write:{path:"/synthetic/output.txt",text:"synthetic\n"},
  str_replace:{path:"/synthetic/output.txt",oldStr:"old",newStr:"new",replace_all:false},
})) test(`verified ${name} details are opt-in, closed, bounded and valid JSON`,()=>{
  for(const variant of ["valid","hidden-field","large","metadata-only"]){
    const state=emptyRecordState(),counters=emptyRecordCounters();
    const call=JSON.parse(lines[1]);call.payload.toolName=name;
    call.payload.args=variant==="hidden-field"?{...args,reasoningSignature:"private-provider-marker"}:variant==="large"?{...args,[name==="execute_bash"?"command":"path"]:"x".repeat(KIRO_LIMITS.toolInputChars+1)}:args;
    const policy={prompts:false,toolDetails:variant!=="metadata-only"};
    applyKiroRecord(state,bytes(call),sessionId,policy,counters);
    const logs=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,policy,counters);
    assert.equal(source(logs[0]).context[0].name,name);
    if(variant==="valid") assert.deepEqual(JSON.parse(String(source(logs[0]).context[0].input)),args);
    else assert.equal(source(logs[0]).context[0].input,undefined);
    assert.doesNotMatch(JSON.stringify({logs,state}),/private-provider-marker|reasoningSignature/);
  }
});

test("complete and incomplete credential blocks are redacted from prompts and withhold exact tool input",()=>{
 for(const end of ["\n-----END EC PRIVATE KEY-----",""]){
  const secret="-----BEGIN EC PRIVATE KEY-----\nsynthetic-private-body"+end;
  const prompt=JSON.parse(lines[0]);prompt.payload.content="before "+secret;
  const captured=applyKiroRecord(emptyRecordState(),bytes(prompt),sessionId,{prompts:true,toolDetails:true},emptyRecordCounters())[0];
  assert.doesNotMatch(String(source(captured).payload.content),/synthetic-private-body|PRIVATE KEY/);
  const state=emptyRecordState(),counters=emptyRecordCounters(),call=JSON.parse(lines[1]);
  call.payload.toolName="fs_write";call.payload.args={path:"/synthetic/key.txt",text:secret};
  applyKiroRecord(state,bytes(call),sessionId,{prompts:false,toolDetails:true},counters);
  assert.doesNotMatch(JSON.stringify(state),/synthetic-private-body|PRIVATE KEY/);
  const result=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},counters)[0];
  assert.equal(source(result).context[0].input,undefined);assert.equal(source(result).context[0].name,"fs_write");
  assert.equal(counters.unsupportedDetails,1);
 }
});
test("older cached tool inputs are checked against the current privacy contract",()=>{
 const call=JSON.parse(lines[1]),state=emptyRecordState(),counters=emptyRecordCounters();
 state.calls.push({id:call.payload.toolCallId,name:"fs_write",executionId:call.payload.executionId,input:JSON.stringify({path:"/synthetic/key.txt",text:"<REDACTED>\nsynthetic-private-body\n-----END EC PRIVATE KEY-----"})});
 const result=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},counters)[0];
 assert.equal(source(result).context[0].input,undefined);assert.equal(counters.unsupportedDetails,1);
});

test("background execution remains source data and does not select command fact eligibility", () => {
 const call=JSON.parse(lines[1]), state=emptyRecordState();
 call.payload.toolName="execute_bash";
 call.payload.args={command:"echo synthetic",cwd:"/synthetic",run_in_background:true};
 applyKiroRecord(state,bytes(call),sessionId,{prompts:false,toolDetails:true},emptyRecordCounters());
 const result=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},emptyRecordCounters())[0];
 assert.equal(JSON.parse(source(result).context[0].input).run_in_background,true);
});

// Synthetic values only. Each is assembled from parts so that no line of this
// file holds a complete credential shape.
const CONTENT = {prompts: true, toolDetails: true};
const value = "synthetic" + "Value0123456789";
const strictSamples: Record<string, string> = {
  "assignment to a secret-named variable": `export AWS_SECRET_ACCESS_KEY=${value}`,
  "assignment to a passphrase name": `db_passphrase: ${value}`,
  "authorization value behind its scheme word": `Authorization: Basic ${value}`,
  "X- request header": `X-Session-Id: ${value}`,
  "password given in prose": `the password is ${value} for staging`,
  "fine-grained GitHub token shape": "github_" + "pat_" + "A1b2".repeat(6),
  "GitLab token shape": "gl" + "pat-" + "A1b2".repeat(5),
  "payment test key shape": "sk_" + "test_" + "A1b2".repeat(4),
  "password in a non-HTTP URL": `postgres://deploy:${value}@db.example.test/app`,
};
const secretOf = (sample: string) => sample.includes(value) ? value : sample;
const userRecord = (content: string) => {const record = JSON.parse(lines[0]); record.payload.content = content; return record;};
const bashCall = (command: string) => {
  const record = JSON.parse(lines[1]);
  record.payload.toolName = "execute_bash";
  record.payload.args = {command, cwd: "/synthetic", run_in_background: false};
  return record;
};
/** The tool input the service would receive for one call, and the state kept for it. */
function deliveredInput(call: unknown) {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  applyKiroRecord(state, bytes(call), sessionId, CONTENT, counters);
  const stored = JSON.stringify(state);
  const result = applyKiroRecord(state, Buffer.from(lines[2]), sessionId, CONTENT, counters)[0];
  return {input: source(result).context[0].input as string | undefined, name: source(result).context[0].name, stored, counters};
}

test("each stricter credential class is redacted from a prompt and withholds a tool input", () => {
  for (const [label, sample] of Object.entries(strictSamples)) {
    const secret = secretOf(sample);
    const captured = applyKiroRecord(emptyRecordState(), bytes(userRecord(`please run this: ${sample} then stop`)), sessionId, CONTENT, emptyRecordCounters())[0];
    const content = String(source(captured).payload.content);
    assert.ok(!content.includes(secret), label);
    assert.match(content, /^please run this: .*<REDACTED>.* then stop$/, label);
    assert.equal(source(captured).payload.contentLength, `please run this: ${sample} then stop`.length, label);
    const delivered = deliveredInput(bashCall(`deploy ${sample}`));
    assert.equal(delivered.input, undefined, label);
    assert.equal(delivered.name, "execute_bash", label);
    assert.ok(!delivered.stored.includes(secret), label);
    assert.equal(delivered.counters.unsupportedDetails, 1, label);
  }
  const write = JSON.parse(lines[1]);
  write.payload.toolName = "fs_write";
  write.payload.args = {path: "/synthetic/.env", text: strictSamples["assignment to a secret-named variable"]};
  assert.equal(deliveredInput(write).input, undefined);
});

test("a shell command that passes a secret as an argument is withheld whole", () => {
  const commands = [`curl -u deploy:${value} https://example.test`, `mysql -p${value} app`, `docker login -p ${value} registry.example.test`,
    `curl -H "Cookie: sid=${value}" https://example.test`, `deploy-tool --api-key ${value}`,
    // The rule cannot tell a port or an unrelated short option from a password.
    "psql -p 5432 app", "zip -p out.zip notes.txt"];
  for (const command of commands) {
    const delivered = deliveredInput(bashCall(command));
    assert.equal(delivered.input, undefined, command);
    assert.ok(!delivered.stored.includes(value), command);
    assert.equal(delivered.counters.unsupportedDetails, 1, command);
  }
  // The rule is for shell commands only: the same text as a file path is not a command line.
  const read = JSON.parse(lines[1]);
  read.payload.toolName = "read_file";
  read.payload.args = {path: "/synthetic/notes/psql -p 5432.md"};
  assert.deepEqual(JSON.parse(deliveredInput(read).input!), read.payload.args);
});

test("an ordinary command, path and prompt pass through unchanged", () => {
  for (const command of ["npm test -- --grep transport", "git status", "ls -la /synthetic/src/tokens", "node scripts/build.ts --watch"]) {
    const delivered = deliveredInput(bashCall(command));
    assert.deepEqual(JSON.parse(delivered.input!), {command, cwd: "/synthetic", run_in_background: false}, command);
    assert.equal(delivered.counters.unsupportedDetails, 0, command);
  }
  const read = JSON.parse(lines[1]);
  read.payload.toolName = "read_file";
  read.payload.args = {path: "/synthetic/src/tokens/keyboard.ts", offset: 0, limit: 40};
  assert.deepEqual(JSON.parse(deliveredInput(read).input!), read.payload.args);
  const prompt = "Explain how the token bucket and the password reset flow work in src/auth/keys.ts";
  const captured = applyKiroRecord(emptyRecordState(), bytes(userRecord(prompt)), sessionId, CONTENT, emptyRecordCounters())[0];
  assert.equal(source(captured).payload.content, prompt);
});

test("a tool input stored by an earlier version is checked again with the stricter rules", () => {
  const call = JSON.parse(lines[1]);
  for (const command of [`curl -u deploy:${value} https://example.test`, `export AWS_SECRET_ACCESS_KEY=${value}`]) {
    const state = emptyRecordState(), counters = emptyRecordCounters();
    state.calls.push({id: call.payload.toolCallId, name: "execute_bash", executionId: call.payload.executionId,
      input: JSON.stringify({command, cwd: "/synthetic", run_in_background: false})});
    const result = applyKiroRecord(state, Buffer.from(lines[2]), sessionId, CONTENT, counters)[0];
    assert.equal(source(result).context[0].input, undefined, command);
    assert.ok(!JSON.stringify(result).includes(value), command);
    assert.equal(counters.unsupportedDetails, 1, command);
  }
});

test("scrubbing does not change the replay ledger, so a checkpoint from an earlier version still deduplicates", () => {
  const records = [userRecord(`use ${strictSamples["password given in prose"]}`), bashCall(`curl -u deploy:${value} https://example.test`), JSON.parse(lines[2])];
  const ledger = (policy: {prompts: boolean; toolDetails: boolean}) => {
    const state = emptyRecordState();
    for (const record of records) applyKiroRecord(state, bytes(record), sessionId, policy, emptyRecordCounters());
    return state;
  };
  const metadataOnly = ledger(NO_CONTENT), withContent = ledger(CONTENT);
  // The ledger is a digest of the source record, taken before any scrubbing.
  assert.deepEqual(withContent.seen, metadataOnly.seen);
  assert.equal(withContent.seen.length, 3);
  const counters = emptyRecordCounters();
  for (const record of records) assert.deepEqual(applyKiroRecord(metadataOnly, bytes(record), sessionId, CONTENT, counters), []);
  assert.equal(counters.duplicates, 3);
});
