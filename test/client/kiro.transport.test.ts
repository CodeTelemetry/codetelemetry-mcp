import assert from "node:assert/strict";
import test from "node:test";
import { kiroTransport } from "../../src/client/kiro/transport.ts";
import { KIRO_LIMITS } from "../../src/client/kiro/records.ts";
const key = "cot_synthetictestkey00000000000000";
const delivery = "11111111-1111-4111-8111-111111111111";

test("transport keeps exact bytes and per-envelope key across retry and never follows redirects", async () => {
  const requests: RequestInit[] = [];
  const send = kiroTransport({endpoint: "https://ingest.example.test", key,
    fetchImpl: async (_url, init) => {requests.push(init!); return new Response("{}", {status: requests.length === 1 ? 503 : 200});}});
  const body = '{"resourceLogs":[]}';
  assert.equal(await send(body, delivery), "retry");
  assert.equal(await send(body, delivery), "ok");
  assert.equal(requests[0].body, body); assert.equal(requests[1].body, body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  assert.equal((requests[0].headers as Record<string,string>)["x-code-telemetry-idempotency-key"], delivery);
  assert.equal(requests[0].redirect, "error");
});

test("partial acceptance, auth, budget and oversized responses do not acknowledge a source offset", async () => {
  for (const [status, response, expected] of [[200, '{"partialSuccess":{"rejectedLogRecords":"1"}}', "rejected"],
    [401, "", "auth"], [402, "", "budget"], [413, "", "rejected"], [429, "", "retry"],
    [200, "x".repeat(4097), "retry"], [200, "[]", "retry"], [200, "null", "retry"], [200, '{"partialSuccess":null}', "retry"]] as const) {
    const send = kiroTransport({endpoint: "https://ingest.example.test", key, fetchImpl: async () => new Response(response, {status})});
    assert.equal(await send("{}", delivery), expected);
  }
  assert.throws(() => kiroTransport({endpoint: "https://user:secret@example.test", key}), /endpoint/);
  assert.throws(() => kiroTransport({endpoint: "http://example.test", key, allowHttp: true}), /endpoint/);
});

test("the request has an absolute timeout and exposes no raw fetch error", async context => {
  context.mock.timers.enable({apis: ["setTimeout"]});
  const send = kiroTransport({endpoint: "https://ingest.example.test", key, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error(key)), {once: true});
  })});
  const result = send("{}", delivery);
  context.mock.timers.tick(KIRO_LIMITS.requestMs);
  assert.equal(await result, "retry");
});

test("source format requires server acknowledgement; legacy pending bytes retain their protocol",async()=>{
 const body=JSON.stringify({resourceLogs:[{scopeLogs:[{logRecords:[{attributes:[{key:"event.name",value:{stringValue:"kiro.source_record"}}]}]}]}]});
 for(const acknowledged of [false,true]) {
  const send=kiroTransport({endpoint:"https://ingest.example.test",key,fetchImpl:async(_url,init)=>{
   assert.equal((init!.headers as Record<string,string>)["x-codetelemetry-source-format"],"kiro-v3-source-v1");
   return new Response("{}",{status:200,headers:acknowledged?{"x-codetelemetry-source-format":"kiro-v3-source-v1"}:{}});
  }});
  assert.equal(await send(body,delivery),acknowledged?"ok":"rejected");
 }
 const old=kiroTransport({endpoint:"https://ingest.example.test",key,fetchImpl:async(_url,init)=>{
  assert.equal((init!.headers as Record<string,string>)["x-codetelemetry-source-format"],undefined);
  return new Response("{}",{status:200});
 }});
 assert.equal(await old('{"resourceLogs":[]}',delivery),"ok");
 assert.equal(await old('{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[{"key":"prompt","value":{"stringValue":"kiro.source_record"}}]}]}]}]}',delivery),"ok");
});
