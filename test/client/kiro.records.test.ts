import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyKiroRecord, emptyRecordCounters, emptyRecordState, KIRO_LIMITS, KiroSourceConflictError } from "../../src/client/kiro/records.ts";
import { NO_CONTENT } from "../../src/client/import/model.ts";

const lines = readFileSync(new URL("./fixtures/kiro-v3/transcript-fixture.jsonl", import.meta.url), "utf8").trim().split("\n");
const sessionId = "sess_0d9782e1-c28a-4107-ac98-5033e20ee658";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test("V3 saved corpus emits common prompt/tools and separate exact usage/completion without content", () => {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  const logs = lines.flatMap(line => applyKiroRecord(state, Buffer.from(line), sessionId, NO_CONTENT, counters));
  assert.deepEqual(logs.map(log => log.attributes["event.name"]), ["user_prompt", "tool_result", "tool_result", "provider_turn_usage", "turn_completion"]);
  assert.deepEqual(logs.filter(log => log.attributes["event.name"] === "tool_result").map(log => [log.attributes.tool_name, log.attributes.success]), [["read_file", true], ["read_file", false]]);
  assert.equal(logs[3].attributes["usage.amount"], 0.08638084941956882);
  assert.equal(logs[3].attributes["turn.elapsed_ms"], 4589);
  assert.equal(logs[3].attributes["turn.status"], "success");
  assert.equal(logs[4].attributes["turn.status"], "unknown");
  assert.equal(logs[0].timeUnixNano, "1792434493699000000");
  assert.doesNotMatch(JSON.stringify(logs), /synthetic\/workspace|Telemetry experiment|Caught error|reasoning|signature|duration_ms|input_tokens|cost_usd/);
  assert.equal(state.calls.length, 0);
  assert.deepEqual(counters, emptyRecordCounters());
  assert.equal(lines.flatMap(line => applyKiroRecord(state, Buffer.from(line), sessionId, NO_CONTENT, counters)).length, 0);
  assert.equal(counters.duplicates, 7);
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
  assert.equal(result.attributes.success, false);
  assert.equal(result.attributes.tool_name, undefined);
  assert.equal(result.attributes.duration_ms, undefined);
});

test("only verified shapes can opt in; secrets are scrubbed before capture", () => {
  const state = emptyRecordState(), counters = emptyRecordCounters();
  const prompt = JSON.parse(lines[0]);
  prompt.payload.content = "api_key=private-value sk-ant-abcdefghijklmnopqrstuvwxyz cot_abcdefghijklmnopqrstuvwxyz123456";
  const captured = applyKiroRecord(state, bytes(prompt), sessionId, {prompts: true, toolDetails: true}, counters)[0];
  assert.doesNotMatch(String(captured.attributes.prompt), /private-value|abcdefghijklmnopqrstuvwxyz/);
  const call = JSON.parse(lines[1]);
  call.payload.toolName = "execute_bash";
  call.payload.args = {command: "echo unverified"};
  applyKiroRecord(state, bytes(call), sessionId, {prompts: false, toolDetails: true}, counters);
  const result = applyKiroRecord(state, Buffer.from(lines[2]), sessionId, {prompts: false, toolDetails: true}, counters)[0];
  assert.equal(result.attributes.tool_name, "execute_bash");
  assert.equal(result.attributes.tool_input, undefined);
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

// ELL-414 native consent fixture: a denied fs_write has a false result while
// the surrounding turn can still succeed. Approval cancellation is not a turn cancellation.
test("denied source calls remain denied across checkpoint round trips without inventing turn cancellation", () => {
  const state=emptyRecordState(), counters=emptyRecordCounters();
  const call=JSON.parse(lines[1]);
  call.payload.toolName="fs_write";call.payload.status="denied";
  applyKiroRecord(state,bytes(call),sessionId,NO_CONTENT,counters);
  const resumed=JSON.parse(JSON.stringify(state));
  const result=JSON.parse(lines[2]);result.payload.success=false;
  const log=applyKiroRecord(resumed,bytes(result),sessionId,NO_CONTENT,counters)[0];
  assert.equal(log.attributes.decision,"deny");
  assert.equal(log.attributes.success,false);
  assert.equal(log.attributes["turn.status"],undefined);
  assert.equal(log.attributes.tool_input,undefined);
  const conflict=JSON.parse(JSON.stringify(state));result.payload.success=true;
  assert.throws(()=>applyKiroRecord(conflict,bytes(result),sessionId,NO_CONTENT,counters),KiroSourceConflictError);
});

test("opt-in details reject unverified argument keys and shapes before persistence/export",()=>{
 for(const extra of [{reasoningSignature:"synthetic-do-not-export"},{futureMode:"synthetic-do-not-export"},{offset:{private:"synthetic-do-not-export"}}]) {
  const state=emptyRecordState(),counters=emptyRecordCounters(),call=JSON.parse(lines[1]);
  call.payload.args={path:"/synthetic/input.txt",...extra};
  applyKiroRecord(state,bytes(call),sessionId,{prompts:false,toolDetails:true},counters);
  assert.doesNotMatch(JSON.stringify(state),/synthetic-do-not-export/);
  const logs=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},counters);
  assert.equal(logs[0].attributes.tool_name,"read_file");
  assert.equal(logs[0].attributes.tool_input,undefined);
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
    assert.equal(logs[0].attributes.tool_name,name);
    if(variant==="valid") assert.deepEqual(JSON.parse(String(logs[0].attributes.tool_input)),args);
    else assert.equal(logs[0].attributes.tool_input,undefined);
    assert.doesNotMatch(JSON.stringify({logs,state}),/private-provider-marker|reasoningSignature/);
  }
});

test("complete and incomplete credential blocks are redacted from prompts and withhold exact tool input",()=>{
 for(const end of ["\n-----END EC PRIVATE KEY-----",""]){
  const secret="-----BEGIN EC PRIVATE KEY-----\nsynthetic-private-body"+end;
  const prompt=JSON.parse(lines[0]);prompt.payload.content="before "+secret;
  const captured=applyKiroRecord(emptyRecordState(),bytes(prompt),sessionId,{prompts:true,toolDetails:true},emptyRecordCounters())[0];
  assert.doesNotMatch(String(captured.attributes.prompt),/synthetic-private-body|PRIVATE KEY/);
  const state=emptyRecordState(),counters=emptyRecordCounters(),call=JSON.parse(lines[1]);
  call.payload.toolName="fs_write";call.payload.args={path:"/synthetic/key.txt",text:secret};
  applyKiroRecord(state,bytes(call),sessionId,{prompts:false,toolDetails:true},counters);
  assert.doesNotMatch(JSON.stringify(state),/synthetic-private-body|PRIVATE KEY/);
  const result=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},counters)[0];
  assert.equal(result.attributes.tool_input,undefined);assert.equal(result.attributes.tool_name,"fs_write");
  assert.equal(counters.unsupportedDetails,1);
 }
});
test("older cached tool inputs are checked against the current privacy contract",()=>{
 const call=JSON.parse(lines[1]),state=emptyRecordState(),counters=emptyRecordCounters();
 state.calls.push({id:call.payload.toolCallId,name:"fs_write",executionId:call.payload.executionId,input:JSON.stringify({path:"/synthetic/key.txt",text:"<REDACTED>\nsynthetic-private-body\n-----END EC PRIVATE KEY-----"})});
 const result=applyKiroRecord(state,Buffer.from(lines[2]),sessionId,{prompts:false,toolDetails:true},counters)[0];
 assert.equal(result.attributes.tool_input,undefined);assert.equal(counters.unsupportedDetails,1);
});
