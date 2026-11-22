// Loaded here as well as by the test scripts, so this file cannot reach the
// real home directory however it is run.
import "../support/isolateHome.ts";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { collectorTransport, IDEMPOTENCY_HEADER, RETRY_AFTER_MAX_MS, SOURCE_ENVELOPE_INVALID, SOURCE_FORMAT_HEADER,
  type CollectorPostResult, type CollectorTransportOptions } from "../../src/client/collector/transport.ts";
import { kiroTransport } from "../../src/client/kiro/transport.ts";

const key = "cot_synthetictestkey00000000000000";
const delivery = "22222222-2222-4222-8222-222222222222";
const format = "cursor-hooks-source-v1";
const echo = {[SOURCE_FORMAT_HEADER]: format};
const envelope = '{"resourceLogs":[]}';
const cursor = (fetchImpl: CollectorTransportOptions["fetchImpl"], extra: Partial<CollectorTransportOptions> = {}) =>
  collectorTransport({endpoint: "https://ingest.example.test", key, format, envelopeBytes: 200 * 1024, requestMs: 10_000, label: "Cursor", env: {}, fetchImpl, ...extra});
const answer = (status: number, body = "", headers: Record<string, string> = {}) => cursor(async () => new Response(status === 204 ? null : body, {status, headers}));
const failure = (code: string, nested = false) => {
  const cause = Object.assign(new Error(`connect failed with ${key}`), {code});
  return new TypeError("fetch failed", {cause: nested ? new AggregateError([cause], "all attempts failed") : cause});
};

test("the wire literals are the ones the service contract names", () => {
  assert.equal(SOURCE_FORMAT_HEADER, "x-codetelemetry-source-format");
  assert.equal(IDEMPOTENCY_HEADER, "x-code-telemetry-idempotency-key");
  assert.equal(SOURCE_ENVELOPE_INVALID, "source_envelope_invalid");
});

test("every body carries the format header, exact bytes and one key, and only an echoed 2xx is accepted", async () => {
  const requests: Array<{url: string; init: RequestInit}> = [];
  const send = cursor(async (url, init) => {requests.push({url: String(url), init: init!}); return new Response("{}", {status: 200, headers: echo});});
  assert.deepEqual(await send(envelope, delivery), {outcome: "ok", detail: "accepted", httpStatus: 200});
  assert.deepEqual(await send(envelope, delivery), {outcome: "ok", detail: "accepted", httpStatus: 200});
  assert.equal(requests[0].url, "https://ingest.example.test/v1/logs");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.body, envelope);
  assert.equal(requests[0].init.redirect, "error");
  assert.deepEqual(requests[0].init.headers, {"content-type": "application/json", authorization: `Bearer ${key}`,
    "x-code-telemetry-idempotency-key": delivery, "x-codetelemetry-source-format": "cursor-hooks-source-v1"});
  assert.deepEqual(requests[1].init.headers, requests[0].init.headers);
  assert.deepEqual(await answer(200, "", echo)(envelope, delivery), {outcome: "ok", detail: "accepted", httpStatus: 200});
  assert.deepEqual(await answer(204, "", echo)(envelope, delivery), {outcome: "ok", detail: "accepted", httpStatus: 204});
  assert.deepEqual(await answer(200, '{"partialSuccess":{"rejectedLogRecords":"0"}}', echo)(envelope, delivery), {outcome: "ok", detail: "accepted", httpStatus: 200});
});

test("a service that does not serve the format is unsupported, never a rejected frame", async () => {
  const unsupported = (httpStatus: number) => ({outcome: "unsupported", detail: "unsupported", httpStatus});
  assert.deepEqual(await answer(415, '{"error":"unsupported source format","code":"source_format_unsupported"}')(envelope, delivery), unsupported(415));
  assert.deepEqual(await answer(200, "{}")(envelope, delivery), unsupported(200));
  assert.deepEqual(await answer(200, "{}", {[SOURCE_FORMAT_HEADER]: "kiro-v3-source-v1"})(envelope, delivery), unsupported(200));
  for (const body of ['{"error":"invalid or unsupported source envelope"}', "", "not json", "[]", "null", '{"code":"source_format_unsupported"}',
    '{"code":["source_envelope_invalid"]}', JSON.stringify({code: "source_envelope_invalid", padding: "x".repeat(5000)})]) {
    assert.deepEqual(await answer(400, body)(envelope, delivery), unsupported(400), `400 with body ${body.slice(0, 40)}`);
  }
  assert.deepEqual(await answer(400, '{"error":"invalid source envelope","code":"source_envelope_invalid"}')(envelope, delivery),
    {outcome: "rejected", detail: "invalid", httpStatus: 400});
});

test("each status maps to one outcome and one finer class", async () => {
  const cases: Array<[number, string, Record<string, string>, CollectorPostResult]> = [
    [401, "", {}, {outcome: "auth", detail: "auth", httpStatus: 401}],
    [403, "", {}, {outcome: "auth", detail: "auth", httpStatus: 403}],
    [402, '{"error":"credit exhausted"}', {}, {outcome: "budget", detail: "budget", httpStatus: 402}],
    [408, "", {}, {outcome: "retry", detail: "server", httpStatus: 408}],
    [429, "", {}, {outcome: "retry", detail: "rate_limited", httpStatus: 429}],
    [500, "", {}, {outcome: "retry", detail: "server", httpStatus: 500}],
    [503, "", {"retry-after": "1"}, {outcome: "retry", detail: "server", httpStatus: 503, retryAfterMs: 1000}],
    [409, "", {}, {outcome: "rejected", detail: "conflict", httpStatus: 409}],
    [404, "", {}, {outcome: "rejected", detail: "refused", httpStatus: 404}],
    [413, "", {}, {outcome: "rejected", detail: "refused", httpStatus: 413}],
    [200, '{"partialSuccess":{"rejectedLogRecords":"3"}}', echo, {outcome: "rejected", detail: "partial", httpStatus: 200}],
    [200, "x".repeat(4097), echo, {outcome: "retry", detail: "server", httpStatus: 200}],
    [200, "[]", echo, {outcome: "retry", detail: "server", httpStatus: 200}],
    [200, '{"partialSuccess":null}', echo, {outcome: "retry", detail: "server", httpStatus: 200}],
  ];
  for (const [status, body, headers, expected] of cases) assert.deepEqual(await answer(status, body, headers)(envelope, delivery), expected, `status ${status} ${body.slice(0, 30)}`);
});

test("retry-after is parsed from seconds or a date, bounded, and ignored when malformed", async () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  const after = async (status: number, value: string) =>
    (await cursor(async () => new Response("", {status, headers: {"retry-after": value}}), {now: () => now})(envelope, delivery)).retryAfterMs;
  assert.equal(await after(429, "60"), 60_000);
  assert.equal(await after(503, " 5 "), 5000);
  assert.equal(await after(429, "0"), 0);
  assert.equal(await after(503, "Sat, 21 Nov 2026 10:00:30 GMT"), 30_000);
  assert.equal(await after(503, "Sat, 21 Nov 2026 09:00:00 GMT"), 0);
  assert.equal(await after(429, "86400"), RETRY_AFTER_MAX_MS);
  assert.equal(RETRY_AFTER_MAX_MS, 3_600_000);
  assert.equal(await after(429, "soon"), undefined);
  assert.equal(await after(429, "-5"), undefined);
  assert.equal(await after(429, "1.5"), undefined);
  assert.equal(await after(429, "2026-11-21T10:00:30Z"), undefined);
  assert.equal(await after(429, "Sat, 21 Nov 2026 10:00:30 GMT; x"), undefined);
  assert.equal("retryAfterMs" in await answer(429)(envelope, delivery), false);
  assert.equal((await answer(400, "", {"retry-after": "60"})(envelope, delivery)).retryAfterMs, undefined);
});

test("a failure without a response is classified from its code and never carries the raw error", async () => {
  const classify = async (error: unknown, env: NodeJS.ProcessEnv = {}, extra: Partial<CollectorTransportOptions> = {}) =>
    await cursor(async () => {throw error;}, {env, ...extra})(envelope, delivery);
  for (const [code, expected] of [["ECONNREFUSED", "connect"], ["ECONNRESET", "connect"], ["EHOSTUNREACH", "connect"], ["UND_ERR_SOCKET", "connect"],
    ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls"], ["CERT_HAS_EXPIRED", "tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"], ["EPROTO", "tls"],
    ["ETIMEDOUT", "timeout"], ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["UND_ERR_HEADERS_TIMEOUT", "timeout"], ["ESOMETHINGNEW", "network"]] as const) {
    const result = await classify(failure(code));
    assert.deepEqual(result, {outcome: "network", detail: expected, errorClass: expected}, code);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  assert.equal((await classify(failure("ECONNREFUSED", true))).errorClass, "connect");
  assert.equal((await classify(new Error("opaque"))).errorClass, "network");
  assert.equal((await classify("not an error")).errorClass, "network");
  // Behind an environment proxy every connection goes to the proxy.
  const proxy = {NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://user:secret@proxy.example.test:3128"};
  assert.equal((await classify(failure("ECONNREFUSED"), proxy)).errorClass, "proxy");
  assert.equal((await classify(failure("ENOTFOUND"), proxy)).errorClass, "proxy");
  assert.equal((await classify(new Error("Proxy response (407) !== 200 when HTTP Tunneling"), proxy)).errorClass, "proxy");
  assert.equal((await classify(failure("SELF_SIGNED_CERT_IN_CHAIN"), proxy)).errorClass, "tls");
  assert.equal((await classify(failure("ETIMEDOUT"), proxy)).errorClass, "timeout");
  assert.equal((await classify(failure("ECONNREFUSED"), {HTTPS_PROXY: proxy.HTTPS_PROXY})).errorClass, "connect", "Node ignores the variable without NODE_USE_ENV_PROXY");
  assert.equal((await classify(failure("ECONNREFUSED"), {NODE_USE_ENV_PROXY: "1", https_proxy: "", HTTPS_PROXY: proxy.HTTPS_PROXY})).errorClass, "connect", "an empty lower-case variable hides the upper-case one");
  assert.equal((await classify(failure("ECONNREFUSED"), {NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.HTTPS_PROXY})).errorClass, "proxy", "https falls back to the http proxy");
  for (const [exclusions, expected] of [["ingest.example.test", "connect"], [".example.test", "connect"], ["*.example.test", "connect"], ["*", "connect"],
    ["other.test, ingest.example.test:443", "connect"], ["ingest.example.test:8443", "proxy"], ["example.test", "proxy"], ["", "proxy"]] as const) {
    assert.equal((await classify(failure("ECONNREFUSED"), {...proxy, NO_PROXY: exclusions})).errorClass, expected, `NO_PROXY=${exclusions}`);
  }
  const loopback = {endpoint: "http://127.0.0.1:9", allowHttp: true};
  assert.equal((await classify(failure("ECONNREFUSED"), proxy, loopback)).errorClass, "connect", "an http target does not use the https proxy");
  assert.equal((await classify(failure("ECONNREFUSED"), {NODE_USE_ENV_PROXY: "1", http_proxy: proxy.HTTPS_PROXY}, loopback)).errorClass, "proxy");
  assert.equal((await classify(failure("ECONNREFUSED"), {NODE_USE_ENV_PROXY: "1", http_proxy: proxy.HTTPS_PROXY, no_proxy: "127.0.0.1:9"}, loopback)).errorClass, "connect");
});

test("the request has an absolute timeout reported as a timeout", async context => {
  context.mock.timers.enable({apis: ["setTimeout"]});
  const send = cursor((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error(key)), {once: true});
  }), {requestMs: 2500});
  const result = send(envelope, delivery);
  context.mock.timers.tick(2500);
  assert.deepEqual(await result, {outcome: "network", detail: "timeout", errorClass: "timeout"});
});

test("endpoint, key, format, envelope size and delivery key are validated before any request", async () => {
  let requests = 0;
  const fetchImpl = async () => {requests++; return new Response("{}", {status: 200, headers: echo});};
  assert.throws(() => cursor(fetchImpl, {endpoint: "http://ingest.example.test"}), /invalid Cursor ingest endpoint/);
  assert.throws(() => cursor(fetchImpl, {endpoint: "http://127.0.0.1:4318"}), /invalid Cursor ingest endpoint/);
  assert.throws(() => cursor(fetchImpl, {endpoint: "https://user:secret@ingest.example.test"}), /invalid Cursor ingest endpoint/);
  assert.throws(() => cursor(fetchImpl, {endpoint: "https://ingest.example.test/?tenant=1"}), /invalid Cursor ingest endpoint/);
  assert.doesNotThrow(() => cursor(fetchImpl, {endpoint: "http://127.0.0.1:4318/", allowHttp: true}));
  assert.throws(() => cursor(fetchImpl, {endpoint: "http://ingest.example.test", allowHttp: true}), /invalid Cursor ingest endpoint/);
  assert.throws(() => cursor(fetchImpl, {key: "not-a-key"}), /ingest key/);
  assert.throws(() => cursor(fetchImpl, {format: "Cursor Hooks\r\nx-injected: 1"}), /invalid Cursor source format/);
  const send = cursor(fetchImpl, {envelopeBytes: 64});
  await assert.rejects(send("x".repeat(65), delivery), /invalid Cursor retry envelope/);
  await assert.rejects(send(envelope, "not-a-delivery-key"), /invalid Cursor retry envelope/);
  await assert.rejects(send(envelope, "ABCDEF22-2222-4222-8222-222222222222"), /invalid Cursor retry envelope/);
  assert.equal(requests, 0);
});

test("a marker event limits the header to source envelopes and refuses a body that is not JSON", async () => {
  const seen: Array<string | undefined> = [];
  const send = cursor(async (_url, init) => {
    seen.push((init!.headers as Record<string, string>)[SOURCE_FORMAT_HEADER]);
    return new Response("{}", {status: 200});
  }, {markerEvent: "cursor.source_record"});
  const source = JSON.stringify({resourceLogs: [{scopeLogs: [{logRecords: [{attributes: [{key: "event.name", value: {stringValue: "cursor.source_record"}}]}]}]}]});
  assert.equal((await send(source, delivery)).outcome, "unsupported");
  assert.equal((await send(envelope, delivery)).outcome, "ok");
  assert.deepEqual(seen, [format, undefined]);
  assert.deepEqual(await send("{", delivery), {outcome: "rejected", detail: "invalid"});
  assert.equal(seen.length, 2);
});

test("Kiro's wrapper still answers with its five original strings", async () => {
  const source = JSON.stringify({resourceLogs: [{scopeLogs: [{logRecords: [{attributes: [{key: "event.name", value: {stringValue: "kiro.source_record"}}]}]}]}]});
  const kiroEcho = {[SOURCE_FORMAT_HEADER]: "kiro-v3-source-v1"};
  const kiro = (respond: () => Promise<Response>) => kiroTransport({endpoint: "https://ingest.example.test", key, fetchImpl: respond});
  const cases: Array<[() => Promise<Response>, string]> = [
    [async () => new Response("{}", {status: 200, headers: kiroEcho}), "ok"],
    [async () => new Response("{}", {status: 200}), "rejected"],
    [async () => new Response('{"code":"source_format_unsupported"}', {status: 415}), "rejected"],
    [async () => new Response('{"error":"invalid or unsupported Kiro source envelope"}', {status: 400}), "rejected"],
    [async () => new Response('{"code":"source_envelope_invalid"}', {status: 400}), "rejected"],
    [async () => new Response("", {status: 409}), "rejected"],
    [async () => new Response('{"partialSuccess":{"rejectedLogRecords":"1"}}', {status: 200, headers: kiroEcho}), "rejected"],
    [async () => new Response("", {status: 401}), "auth"],
    [async () => new Response("", {status: 402}), "budget"],
    [async () => new Response("", {status: 429, headers: {"retry-after": "60"}}), "retry"],
    [async () => new Response("", {status: 503}), "retry"],
    [async () => {throw failure("ECONNREFUSED");}, "retry"],
    [async () => {throw failure("DEPTH_ZERO_SELF_SIGNED_CERT");}, "retry"],
  ];
  for (const [respond, expected] of cases) assert.equal(await kiro(respond)(source, delivery), expected);
  assert.equal(await kiro(async () => {throw new Error("must not be sent");})("{", delivery), "rejected");
  assert.throws(() => kiroTransport({endpoint: "http://example.test", key}), /invalid Kiro ingest endpoint/);
  await assert.rejects(kiro(async () => new Response("{}"))("x".repeat(256 * 1024 + 1), delivery), /invalid Kiro retry envelope/);
});

test("with a marker event a 400 is answered without reading its body, as Kiro's transport always did", async () => {
  const source = JSON.stringify({resourceLogs: [{scopeLogs: [{logRecords: [{attributes: [{key: "event.name", value: {stringValue: "kiro.source_record"}}]}]}]}]});
  // A body that never arrives: headers, then nothing. Reading it would last until the request timeout.
  const stalled = () => {
    const state = {pulled: 0, cancelled: false};
    const body = new ReadableStream<Uint8Array>({pull() {state.pulled++; return new Promise(() => {});}, cancel() {state.cancelled = true;}}, {highWaterMark: 0});
    return {state, response: new Response(body, {status: 400})};
  };
  const within = async <T>(action: Promise<T>): Promise<T | "waited for the body"> => {
    let timer: NodeJS.Timeout;
    const late = new Promise<"waited for the body">(resolve => {timer = setTimeout(() => resolve("waited for the body"), 2000);});
    try {return await Promise.race([action, late]);} finally {clearTimeout(timer!);}
  };
  const kiroBody = stalled();
  assert.equal(await within(kiroTransport({endpoint: "https://ingest.example.test", key, fetchImpl: async () => kiroBody.response})(source, delivery)), "rejected");
  assert.deepEqual(kiroBody.state, {pulled: 0, cancelled: true}, "the body is cancelled unread");
  const marked = stalled();
  assert.deepEqual(await within(cursor(async () => marked.response, {markerEvent: "kiro.source_record", format: "kiro-v3-source-v1"})(source, delivery)),
    {outcome: "rejected", detail: "refused", httpStatus: 400});
  assert.deepEqual(marked.state, {pulled: 0, cancelled: true});
  // Even the coded answer is not looked at with a marker event; without one it still decides.
  const coded = '{"code":"source_envelope_invalid"}';
  assert.deepEqual(await cursor(async () => new Response(coded, {status: 400}), {markerEvent: "kiro.source_record"})(source, delivery), {outcome: "rejected", detail: "refused", httpStatus: 400});
  assert.deepEqual(await answer(400, coded)(envelope, delivery), {outcome: "rejected", detail: "invalid", httpStatus: 400});
  assert.deepEqual(await answer(400, "no code")(envelope, delivery), {outcome: "unsupported", detail: "unsupported", httpStatus: 400});
});

// The collector process itself: the global fetch, a loopback ingest, and the
// proxy variables its launcher exports.
type Seen = {method: string; url: string; headers: http.IncomingHttpHeaders; body: string};
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
const close = (server: http.Server) => new Promise<void>(resolve => {server.closeAllConnections(); server.close(() => resolve());});
async function post(endpoint: string, env: Record<string, string>): Promise<CollectorPostResult> {
  const module = new URL("../../src/client/collector/transport.ts", import.meta.url).href;
  const script = `const {collectorTransport} = await import(${JSON.stringify(module)});
const send = collectorTransport({endpoint: process.argv[1], key: process.env.COLLECTOR_TEST_KEY, format: ${JSON.stringify(format)}, envelopeBytes: 204800, requestMs: 5000, label: "Cursor", allowHttp: true});
process.stdout.write(JSON.stringify(await send(${JSON.stringify(envelope)}, ${JSON.stringify(delivery)})));`;
  const {stdout} = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, endpoint],
    {env: {PATH: process.env.PATH ?? "", HOME: os.homedir(), COLLECTOR_TEST_KEY: key, ...env}, timeout: 30_000, cwd: fileURLToPath(new URL("../..", import.meta.url))});
  return JSON.parse(stdout);
}

test("the collector process delivers through a recorded CONNECT proxy and names a proxy that is down", {timeout: 90_000}, async () => {
  const requests: Seen[] = [], tunnels: string[] = [];
  const ingest = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      requests.push({method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8")});
      res.writeHead(200, {"content-type": "application/json", ...echo}); res.end("{}");
    });
  });
  const proxy = http.createServer((_req, res) => {res.writeHead(405); res.end();});
  proxy.on("connect", (req, socket, head) => {
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
  });
  const ingestPort = await listen(ingest), proxyPort = await listen(proxy);
  const endpoint = `http://127.0.0.1:${ingestPort}`, recorded = `http://127.0.0.1:${proxyPort}`;
  const variables = {HTTP_PROXY: recorded, HTTPS_PROXY: recorded, NODE_USE_ENV_PROXY: "1"};
  try {
    assert.deepEqual(await post(endpoint, {}), {outcome: "ok", detail: "accepted", httpStatus: 200});
    assert.deepEqual(tunnels, []);
    assert.deepEqual(await post(endpoint, variables), {outcome: "ok", detail: "accepted", httpStatus: 200});
    assert.deepEqual(tunnels, [`127.0.0.1:${ingestPort}`]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/logs"); assert.equal(request.body, envelope);
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers[IDEMPOTENCY_HEADER], delivery);
      assert.equal(request.headers[SOURCE_FORMAT_HEADER], format);
    }
    await close(proxy);
    assert.deepEqual(await post(endpoint, variables), {outcome: "network", detail: "proxy", errorClass: "proxy"});
    assert.equal(requests.length, 2);
    await close(ingest);
    assert.deepEqual(await post(endpoint, {}), {outcome: "network", detail: "connect", errorClass: "connect"});
  } finally {
    if (proxy.listening) await close(proxy);
    if (ingest.listening) await close(ingest);
  }
});
