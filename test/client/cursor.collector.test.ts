// The Cursor collector, driven the way the service drives it but with a clock,
// a transport and a state directory that belong to the test. Every path is in a
// temporary directory, no request leaves the process, and the import below moves
// the home directory, so nothing here can reach a real ~/.cursor or ~/.local.
import "../support/isolateHome.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IDEMPOTENCY_HEADER, SOURCE_FORMAT_HEADER, type CollectorPost, type CollectorPostResult } from "../../src/client/collector/transport.ts";
import {
  CursorCollector, cursorDestinationHash, cursorTransport, readCursorHealth, requestCursorRetryRejected, runCursorCollector, writeCursorHealth,
  type CursorCollectorOptions, type CursorHealth,
} from "../../src/client/cursor/collector.ts";
import { cursorStateFiles, type CursorPolicy } from "../../src/client/cursor/config.ts";
import { CURSOR_HOOK_LIMITS, cursorHookProgram, type CursorHookEvent, type CursorSpoolLine } from "../../src/client/cursor/hookProgram.ts";
import {
  CURSOR_LIMITS, CURSOR_SOURCE_EVENT, CURSOR_SOURCE_FORMAT, CURSOR_SOURCE_SCOPE, CURSOR_SOURCE_SERVICE, CURSOR_UPLOADED_HOOKS,
  CursorContext, cursorEnvelope, parseCursorSpoolLine,
} from "../../src/client/cursor/records.ts";

const KEY = "cot_synthetictestkey00000000000000";
const ENDPOINT = "https://ingest.example.test";
const DESTINATION = cursorDestinationHash({ key: KEY, ingestEndpoint: ENDPOINT });
/** 2100-01-01T00:00:30Z: thirty seconds into a ten-minute spool bucket. */
const START = 4_102_444_830_000;
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CONVERSATION = "3c9d1e52-7a40-4b8e-9f16-2d5a6b7c8e90";
const TURN = "7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const NEXT_TURN = "8f2a3b4c-5d6e-4f7a-9b0c-1d2e3f4a5b6c";
const CURSOR_VERSION = "2099.1.2-synthetic";
const METADATA: CursorPolicy = { prompts: false, toolDetails: false, email: false };
const EVERYTHING: CursorPolicy = { prompts: true, toolDetails: true, email: true };
const OK: CollectorPostResult = { outcome: "ok", detail: "accepted", httpStatus: 200 };
const SERVER_ERROR: CollectorPostResult = { outcome: "retry", detail: "server", httpStatus: 503 };
const UNSUPPORTED: CollectorPostResult = { outcome: "unsupported", detail: "unsupported", httpStatus: 415 };
const INVALID: CollectorPostResult = { outcome: "rejected", detail: "invalid", httpStatus: 400 };

type Sent = { at: number; key: string; body: string };
type LineOptions = { at?: number; t?: string; id?: string; conversation?: string; p?: Partial<CursorPolicy> };
type Framed = { time: string; session: string; id: string; hook: string; payload: Record<string, any>; context: Record<string, any> };
type Harness = ReturnType<typeof harness>;

/** The uploaded records of one request body, with the source record parsed. */
function framed(body: string): Framed[] {
  return JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords.map((row: any) => {
    const value = (key: string) => row.attributes.find((attribute: any) => attribute.key === key).value.stringValue;
    return { time: row.timeUnixNano, session: value("session.id"), id: value("source.event.id"), ...JSON.parse(value("cursor.source.record")) };
  });
}

function harness(t: TestContext, defaults: Partial<CursorCollectorOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-collector-"));
  const stateDir = path.join(root, "state"), files = cursorStateFiles(stateDir);
  fs.mkdirSync(files.spool, { recursive: true, mode: 0o700 });
  const clock = { now: START };
  const requests: Sent[] = [];
  const service = { answer: (_sent: Sent, _index: number): CollectorPostResult | Promise<CollectorPostResult> => OK };
  const post: CollectorPost = async (body, key) => {
    const sent = { at: clock.now, key, body };
    requests.push(sent);
    return service.answer(sent, requests.length - 1);
  };
  const collectors: CursorCollector[] = [];
  t.after(async () => {
    for (const collector of collectors) await collector.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let sequence = 0;
  const segment = (at: number = clock.now) => path.join(files.spool, `seg-${Math.floor(at / CURSOR_HOOK_LIMITS.segmentMs)}.jsonl`);
  return {
    root, stateDir, files, clock, requests, service, post, segment,
    /** One spool line as the hook writes it, without its newline. `at` is the capture time in milliseconds. */
    line(hook: CursorHookEvent, payload: Record<string, unknown>, opts: LineOptions = {}): string {
      return JSON.stringify({
        v: 1, id: opts.id ?? (++sequence).toString(16).padStart(32, "0"), t: opts.t ?? `${opts.at ?? clock.now}000000`, hook,
        conversation_id: opts.conversation ?? CONVERSATION, p: { ...METADATA, ...opts.p }, payload,
      });
    },
    /** Append whole lines to the segment a hook would have chosen at `at`. */
    append(lines: string | string[], at: number = clock.now): void {
      fs.appendFileSync(segment(at), [lines].flat().map(line => `${line}\n`).join(""), { mode: 0o600 });
    },
    async start(extra: Partial<CursorCollectorOptions> = {}): Promise<CursorCollector> {
      const collector = new CursorCollector({
        stateDir, destinationHash: DESTINATION, policy: METADATA, post, now: () => clock.now, random: () => 0, connectVersion: "0.4.0", ...defaults, ...extra,
      });
      await collector.open();
      collectors.push(collector);
      return collector;
    },
    checkpoint: (): Record<string, any> => JSON.parse(fs.readFileSync(files.checkpoint, "utf8")),
    pending: (): Record<string, any> | null => fs.existsSync(files.pending) ? JSON.parse(fs.readFileSync(files.pending, "utf8")) : null,
    quarantined: (): string[] => fs.readdirSync(files.rejected).sort(),
    sent: (index: number): Framed[] => framed(requests[index]!.body),
    /** Every uploaded record so far, in the order it was sent. */
    delivered: (): Framed[] => requests.flatMap(request => framed(request.body)),
  };
}

/** Tick every `step` until `duration` has passed; returns the last health. */
async function run(h: Harness, collector: CursorCollector, duration: number, step = 2 * SECOND): Promise<CursorHealth> {
  let health = collector.snapshot();
  for (const end = h.clock.now + duration; h.clock.now < end;) {
    h.clock.now = Math.min(end, h.clock.now + step);
    health = await collector.tick();
  }
  return health;
}

/** No two requests started closer together than the request gap. */
function assertRequestGap(h: Harness): void {
  for (let index = 1; index < h.requests.length; index++) {
    assert.ok(h.requests[index]!.at - h.requests[index - 1]!.at >= CURSOR_LIMITS.postGapMs, `request ${index} started inside the gap`);
  }
}

const prompt = (turn = TURN, extra: Record<string, unknown> = {}) =>
  ({ generation_id: turn, model: "default", cursor_version: CURSOR_VERSION, composer_mode: "agent", prompt_length: 57, attachment_count: 0, ...extra });
const stop = (turn = TURN, extra: Record<string, unknown> = {}) => ({
  generation_id: turn, model: "default", cursor_version: CURSOR_VERSION, status: "completed", loop_count: 0,
  input_tokens: 31744, output_tokens: 512, cache_read_tokens: 30720, cache_write_tokens: 0, ...extra,
});
const tool = (name: string, id: string, extra: Record<string, unknown> = {}) =>
  ({ generation_id: TURN, model: "default", cursor_version: CURSOR_VERSION, tool_name: name, tool_use_id: id, duration: 12.5, tool_input_size_bytes: 40, result: {}, ...extra });
const thought = (generation: string, model: string, extra: Record<string, unknown> = {}) => ({ generation_id: generation, model, ...extra });
const shell = (id: string, sandbox: boolean) => ({ tool_use_id: id, sandbox });

test("the limits are the ones the wire contract names, and the cadence keeps a machine to four requests a minute", () => {
  assert.equal(CURSOR_SOURCE_FORMAT, "cursor-hooks-source-v1");
  assert.equal(CURSOR_SOURCE_EVENT, "cursor.source_record");
  assert.equal(CURSOR_SOURCE_SERVICE, "cursor");
  assert.deepEqual(CURSOR_SOURCE_SCOPE, { name: "codetelemetry-connect.cursor-hooks", version: "1" });
  assert.deepEqual(CURSOR_UPLOADED_HOOKS, ["beforeSubmitPrompt", "stop", "postToolUse", "postToolUseFailure", "afterAgentResponse"]);
  const { envelopeBytes, envelopeRecords, recordBytes, frameBytes, models, modelParams, replyThoughts } = CURSOR_LIMITS;
  assert.deepEqual({ envelopeBytes, envelopeRecords, recordBytes, frameBytes, models, modelParams, replyThoughts },
    { envelopeBytes: 262_144, envelopeRecords: 256, recordBytes: 65_536, frameBytes: 204_800, models: 4, modelParams: 8, replyThoughts: 32 });
  assert.equal(CURSOR_HOOK_LIMITS.recordBytes, CURSOR_LIMITS.recordBytes, "the hook and the collector bound a record alike");
  const { tickMs, settleMs, lingerMs, lingerRecords, postGapMs, postJitterMs, expireMs } = CURSOR_LIMITS;
  assert.deepEqual({ tickMs, settleMs, lingerMs, lingerRecords, postGapMs, postJitterMs, expireMs },
    { tickMs: 2000, settleMs: 2000, lingerMs: 15_000, lingerRecords: 64, postGapMs: 15_000, postJitterMs: 3000, expireMs: 14 * DAY });
  const { readBytes, recordsPerTick, tickBudgetMs, conversations, thoughts, sandboxFlags, reads } = CURSOR_LIMITS;
  assert.deepEqual({ readBytes, recordsPerTick, tickBudgetMs, conversations, thoughts, sandboxFlags, reads },
    { readBytes: 2 * 1024 * 1024, recordsPerTick: 256, tickBudgetMs: 500, conversations: 64, thoughts: 64, sandboxFlags: 32, reads: 8 });
  const { checkpointBytes, pendingBytes, healthBytes, rejectedBytes, quarantineMs, reframeMs, slowRetryMs, rejectedRetryMs } = CURSOR_LIMITS;
  assert.deepEqual({ checkpointBytes, pendingBytes, healthBytes, rejectedBytes, quarantineMs, reframeMs, slowRetryMs, rejectedRetryMs },
    { checkpointBytes: 1024 * 1024, pendingBytes: 1024 * 1024, healthBytes: 16 * 1024, rejectedBytes: 16 * 1024 * 1024, quarantineMs: DAY,
      reframeMs: 6 * DAY, slowRetryMs: 15 * MINUTE, rejectedRetryMs: [MINUTE, 5 * MINUTE, 30 * MINUTE, HOUR] });
  // Four requests a minute at most, and the framing bound leaves room under the wire bound.
  assert.ok(CURSOR_LIMITS.postGapMs * 4 >= MINUTE);
  assert.ok(CURSOR_LIMITS.frameBytes < CURSOR_LIMITS.envelopeBytes);
  // A pending file holds the body as a JSON string (at most twice its bytes) beside the context.
  assert.ok(2 * CURSOR_LIMITS.frameBytes + CURSOR_LIMITS.contextBytes + 64 * 1024 < CURSOR_LIMITS.pendingBytes);
});

test("an envelope built from spool records is exactly the document the contract describes", async t => {
  const h = harness(t), at = START - MINUTE;
  const readId = "call-11112222-3333-4444-8555-666677778888-0\nfc_99990000-aaaa-4bbb-8ccc-ddddeeeeffff_0";
  const shellId = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
  h.append([
    h.line("beforeSubmitPrompt", prompt(TURN, { transcript_path: "/srv/fixture/CANARY.jsonl", note: "CANARY not allow-listed" }),
      { id: "00000000000000000000000000000a01", t: "4102444770604854000" }),
    h.line("afterAgentThought", thought(`${TURN}-0-ab12`, "synthetic-model-high",
      { model_id: "synthetic-model", model_params: [{ id: "effort", value: "high" }, { id: "speed", value: "default" }], text: "CANARY thought" }),
      { id: "00000000000000000000000000000a02", t: "4102444772101200000" }),
    h.line("afterAgentThought", thought(TURN, "default"), { id: "00000000000000000000000000000a03", t: "4102444772101950000" }),
    h.line("postToolUse", tool("Read", readId, { duration: 4.75, tool_input_size_bytes: 49, result: { content_length: 118 }, content: "CANARY file text" }),
      { id: "00000000000000000000000000000a04", t: "4102444775848907000" }),
    h.line("afterShellExecution", { ...shell(shellId, false), command: "CANARY command", output: "CANARY output" },
      { id: "00000000000000000000000000000a05", t: "4102444776560101000" }),
    h.line("postToolUse", tool("Shell", shellId, { duration: 442.25, tool_input_size_bytes: 59, result: { exit_code: 0, output_bytes: 3 } }),
      { id: "00000000000000000000000000000a06", t: "4102444776582711000" }),
    h.line("stop", stop(), { id: "00000000000000000000000000000a07", t: "4102444777701881000" }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const fixed = [
    { key: "event.name", value: { stringValue: "cursor.source_record" } },
    { key: "session.id", value: { stringValue: "3c9d1e52-7a40-4b8e-9f16-2d5a6b7c8e90" } },
  ];
  const record = (time: string, id: string, source: string) => ({
    timeUnixNano: time, observedTimeUnixNano: time, severityNumber: 9, severityText: "INFO",
    attributes: [...fixed, { key: "source.event.id", value: { stringValue: id } }, { key: "cursor.source.version", value: { intValue: "1" } },
      { key: "cursor.source.record", value: { stringValue: source } }],
  });
  const expected = {
    resourceLogs: [{
      resource: { attributes: [
        { key: "service.name", value: { stringValue: "cursor" } },
        { key: "codetelemetry.connect.version", value: { stringValue: "0.4.0" } },
      ] },
      scopeLogs: [{
        scope: { name: "codetelemetry-connect.cursor-hooks", version: "1" },
        logRecords: [
          record("4102444770604854000", "00000000000000000000000000000a01",
            '{"hook":"beforeSubmitPrompt","payload":{"generation_id":"7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b","model":"default",' +
            '"cursor_version":"2099.1.2-synthetic","composer_mode":"agent","prompt_length":57,"attachment_count":0},"context":{}}'),
          record("4102444775848907000", "00000000000000000000000000000a04",
            '{"hook":"postToolUse","payload":{"generation_id":"7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b","model":"default",' +
            '"cursor_version":"2099.1.2-synthetic","tool_name":"Read",' +
            '"tool_use_id":"call-11112222-3333-4444-8555-666677778888-0\\nfc_99990000-aaaa-4bbb-8ccc-ddddeeeeffff_0",' +
            '"duration":4.75,"tool_input_size_bytes":49,"result":{"content_length":118}},"context":{}}'),
          record("4102444776582711000", "00000000000000000000000000000a06",
            '{"hook":"postToolUse","payload":{"generation_id":"7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b","model":"default",' +
            '"cursor_version":"2099.1.2-synthetic","tool_name":"Shell","tool_use_id":"0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",' +
            '"duration":442.25,"tool_input_size_bytes":59,"result":{"exit_code":0,"output_bytes":3}},"context":{"shell":{"sandbox":false}}}'),
          record("4102444777701881000", "00000000000000000000000000000a07",
            '{"hook":"stop","payload":{"generation_id":"7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b","model":"default",' +
            '"cursor_version":"2099.1.2-synthetic","status":"completed","loop_count":0,"input_tokens":31744,"output_tokens":512,' +
            '"cache_read_tokens":30720,"cache_write_tokens":0},"context":{"models":[{"model":"synthetic-model-high",' +
            '"model_id":"synthetic-model","model_params":[{"id":"effort","value":"high"},{"id":"speed","value":"default"}]},{"model":"default"}]}}'),
        ],
      }],
    }],
  };
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0]!.body), expected);
  assert.equal(h.requests[0]!.body, JSON.stringify(expected), "the bytes, not only the shape");
  assert.match(h.requests[0]!.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.doesNotMatch(h.requests[0]!.body, /CANARY/);
  // The frame is inside every bound the service checks before it reads a record.
  const rows = expected.resourceLogs[0]!.scopeLogs[0]!.logRecords;
  assert.ok(Buffer.byteLength(h.requests[0]!.body) <= CURSOR_LIMITS.frameBytes && rows.length <= CURSOR_LIMITS.envelopeRecords);
  for (const row of rows) {
    assert.ok(row.attributes.length <= 32 && new Set(row.attributes.map(attribute => attribute.key)).size === row.attributes.length);
    assert.ok(Buffer.byteLength((row.attributes[4]!.value as { stringValue: string }).stringValue) <= CURSOR_LIMITS.recordBytes);
  }
  // No Connect version, no resource attribute for it; a version the envelope cannot carry is refused up front.
  assert.equal(cursorEnvelope([]), '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"cursor"}}]},' +
    '"scopeLogs":[{"scope":{"name":"codetelemetry-connect.cursor-hooks","version":"1"},"logRecords":[]}]}]}');
  assert.throws(() => new CursorCollector({ stateDir: h.stateDir, destinationHash: DESTINATION, policy: METADATA, post: h.post, connectVersion: "x".repeat(33) }),
    /Connect version/);
});

for (const [mode, policy] of [["metadata only", METADATA], ["every option on", EVERYTHING]] as const) {
  test(`what the hook program writes is read whole and framed unchanged (${mode})`, async t => {
    const h = harness(t, { policy });
    const events = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor", "hook-events.json"), "utf8")) as Record<string, unknown>;
    const program = path.join(h.root, "hook.cjs");
    fs.writeFileSync(program, cursorHookProgram({ stateDir: h.stateDir, content: { prompts: policy.prompts, toolDetails: policy.toolDetails }, identity: { email: policy.email } }));
    for (const event of Object.values(events)) {
      const ran = spawnSync(process.execPath, [program], { input: JSON.stringify(event), env: {}, encoding: "utf8", timeout: 20_000 });
      assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, "", ""]);
    }
    const lines = fs.readdirSync(h.files.spool).sort().flatMap(name => fs.readFileSync(path.join(h.files.spool, name), "utf8").split("\n").filter(Boolean))
      .map(text => JSON.parse(text) as CursorSpoolLine);
    // A reply and a file read are kept for their content only.
    assert.equal(lines.length, Object.keys(events).length - (policy.prompts ? 0 : 2));
    assert.equal(lines.some(line => line.hook === "afterAgentResponse" || line.hook === "beforeReadFile"), policy.prompts);
    assert.equal(fs.existsSync(h.files.dropped), false);
    // The capture times are real, so the collector's clock starts after them.
    h.clock.now = Date.now() + 30 * SECOND;
    const collector = await h.start();
    const health = await collector.tick();
    const uploaded = lines.filter(line => (CURSOR_UPLOADED_HOOKS as readonly string[]).includes(line.hook));
    const rows = h.sent(0);
    assert.deepEqual(rows.map(row => [row.hook, row.session, row.id, row.time]), uploaded.map(line => [line.hook, line.conversation_id, line.id, line.t]));
    // Byte for byte: the collector's allow-list is the hook's, key order included.
    assert.deepEqual(rows.map(row => JSON.stringify(row.payload)), uploaded.map(line => JSON.stringify(line.payload)));
    assert.equal(rows.some(row => "prompt" in row.payload || "tool_input" in row.payload || "workspace_root" in row.payload || "user_email" in row.payload), policy.prompts);
    // In the fixture the shell execution and the file read follow their tool records, two
    // thoughts with one text precede the stop, and the reply follows it.
    assert.deepEqual(rows.filter(row => Object.keys(row.context).length).map(row => [row.hook, row.payload.tool_name, row.context]), [
      ...(policy.toolDetails ? [["postToolUse", "Read", { read: { content: "CANARY_READ_CONTENT export const helper = 1;\n" } }]] : []),
      ["postToolUse", "Shell", { shell: { sandbox: true } }],
      ["stop", undefined, { models: [{ model: "synthetic-model-high", model_id: "synthetic-model",
        model_params: [{ id: "effort", value: "high" }, { id: "speed", value: "default" }] }, { model: "default" }] }],
      ...(policy.prompts ? [["afterAgentResponse", undefined, { thoughts: [{ text: "CANARY_THOUGHT the helper is used in two modules" }] }]] : []),
    ]);
    assert.deepEqual([health.recordsSpooled, health.recordsAcknowledged, health.recordsMalformed, health.backlogBytes, health.hookDrops], [lines.length, uploaded.length, 0, 0, 0]);
    assert.deepEqual(h.checkpoint().conversations.map((conversation: any) => [conversation.thoughts, conversation.sandbox, conversation.used]), [[[], [], undefined]]);
  });
}

test("through the real transport the request carries the format header and the envelope's own key", async t => {
  const h = harness(t), calls: Array<{ url: string; init: RequestInit }> = [];
  const post = cursorTransport({ endpoint: ENDPOINT, key: KEY, env: {}, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response("{}", { status: 200, headers: { [SOURCE_FORMAT_HEADER]: CURSOR_SOURCE_FORMAT } });
  } });
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }));
  const collector = await h.start({ post });
  const health = await collector.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://ingest.example.test/v1/logs");
  assert.equal(calls[0]!.init.method, "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), ["authorization", "content-type", IDEMPOTENCY_HEADER, SOURCE_FORMAT_HEADER].sort());
  assert.equal(headers[SOURCE_FORMAT_HEADER], "cursor-hooks-source-v1");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers[IDEMPOTENCY_HEADER], h.checkpoint().lastEnvelope);
  assert.equal(framed(calls[0]!.init.body as string).length, 1);
  assert.deepEqual([health.lastOutcome, health.lastDetail, health.recordsAcknowledged, health.status], ["ok", "accepted", 1, "idle"]);
});

test("the bytes and key are on disk before the first request and are resent unchanged across retries and a restart", async t => {
  const h = harness(t);
  let onDisk: Record<string, any> | null = null;
  h.service.answer = (sent, index) => {
    if (index === 0) onDisk = h.pending();
    return index < 3 ? SERVER_ERROR : OK;
  };
  h.append([h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), h.line("stop", stop(), { at: START - 50 * SECOND })], START - MINUTE);
  let collector = await h.start();
  await collector.tick();
  assert.equal(h.requests.length, 1);
  assert.ok(onDisk, "pending.json existed when the request left");
  const persisted = onDisk as Record<string, any>;
  assert.deepEqual([persisted.id, persisted.body, persisted.attempts, persisted.records], [h.requests[0]!.key, h.requests[0]!.body, 1, 2]);
  assert.equal(persisted.destinationHash, DESTINATION);
  assert.deepEqual(persisted.policy, METADATA);
  assert.equal(fs.statSync(h.files.pending).mode & 0o777, 0o600);
  // Unanswered: nothing is consumed.
  assert.equal(fs.existsSync(h.files.checkpoint), false);
  await run(h, collector, 20 * SECOND);
  assert.equal(h.requests.length, 2);
  await collector.close();
  collector = await h.start();
  await run(h, collector, 40 * SECOND);
  assert.equal(h.requests.length, 4);
  for (const request of h.requests) assert.deepEqual([request.key, request.body], [h.requests[0]!.key, h.requests[0]!.body]);
  // Answered: committed once, and never sent again.
  assert.equal(h.pending(), null);
  assert.equal(h.checkpoint().offsets[path.basename(h.segment(START - MINUTE))], fs.statSync(h.segment(START - MINUTE)).size);
  assert.equal(h.checkpoint().lastEnvelope, h.requests[0]!.key);
  assert.equal(fs.statSync(h.files.checkpoint).mode & 0o777, 0o600);
  await run(h, collector, 5 * MINUTE);
  await collector.close();
  await run(h, await h.start(), 5 * MINUTE);
  assert.equal(h.requests.length, 4);
  assert.deepEqual([collector.snapshot().requests, collector.snapshot().recordsAcknowledged], [4, 2]);
});

test("a crash between the answer and the checkpoint resends once under the same key; after the checkpoint, never", async t => {
  const h = harness(t);
  let before: { pending: Buffer; checkpoint: Buffer | null } | null = null;
  h.service.answer = (_sent, index) => {
    if (index === 0) before = { pending: fs.readFileSync(h.files.pending), checkpoint: fs.existsSync(h.files.checkpoint) ? fs.readFileSync(h.files.checkpoint) : null };
    return OK;
  };
  h.append([h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), h.line("stop", stop(), { at: START - 50 * SECOND })], START - MINUTE);
  let collector = await h.start();
  await collector.tick();
  await collector.close();
  assert.equal(h.requests.length, 1);
  const committed = fs.readFileSync(h.files.checkpoint);
  const crashed = before as unknown as { pending: Buffer; checkpoint: Buffer | null };
  // The process died after the service answered and before anything was written.
  fs.writeFileSync(h.files.pending, crashed.pending);
  if (crashed.checkpoint) fs.writeFileSync(h.files.checkpoint, crashed.checkpoint); else fs.rmSync(h.files.checkpoint);
  collector = await h.start();
  await run(h, collector, MINUTE);
  await collector.close();
  assert.equal(h.requests.length, 2, "exactly one duplicate request");
  assert.deepEqual([h.requests[1]!.key, h.requests[1]!.body], [h.requests[0]!.key, h.requests[0]!.body]);
  assert.equal(h.pending(), null);
  // The process died after the checkpoint was written and before pending.json was removed.
  fs.writeFileSync(h.files.checkpoint, committed);
  fs.writeFileSync(h.files.pending, crashed.pending);
  collector = await h.start();
  assert.equal(h.pending(), null, "an answered envelope is dropped at start");
  await run(h, collector, 5 * MINUTE);
  assert.equal(h.requests.length, 2);
  assert.equal(h.delivered().filter(row => row.hook === "stop").length, 2);
  assert.equal(h.checkpoint().totals.acknowledged, 2);
});

test("offsets move only when an envelope is answered or a tick reads nothing to upload", async t => {
  const h = harness(t), name = path.basename(h.segment());
  const size = () => fs.statSync(h.segment()).size;
  h.service.answer = (_sent, index) => index === 0 ? SERVER_ERROR : OK;
  const collector = await h.start();
  h.append([h.line("beforeSubmitPrompt", prompt()), h.line("afterAgentThought", thought(`${TURN}-0-k1`, "synthetic-model-high"))]);
  // Settled but still lingering: read every tick, never consumed.
  await run(h, collector, 14 * SECOND);
  assert.equal(h.requests.length, 0);
  assert.equal(fs.existsSync(h.files.checkpoint), false);
  // Framed and refused: the advance waits in pending.json.
  await run(h, collector, 2 * SECOND);
  assert.equal(h.requests.length, 1);
  assert.equal(fs.existsSync(h.files.checkpoint), false);
  assert.deepEqual(h.pending()!.advance.offsets, { [name]: size() });
  assert.deepEqual(h.pending()!.advance.counts, { spooled: 2, malformed: 0, expired: 0 });
  // Records that arrive while an envelope is in flight are not read at all.
  h.append(h.line("stop", stop()));
  const grown = size();
  await run(h, collector, 10 * SECOND);
  assert.equal(fs.existsSync(h.files.checkpoint), false);
  await run(h, collector, 6 * SECOND);
  assert.equal(h.requests.length, 2);
  assert.ok(h.checkpoint().offsets[name] < grown, "the answer commits the envelope's own advance, not what came later");
  // The thought was consumed with the envelope and stays in the context for its stop.
  assert.deepEqual(h.checkpoint().conversations, [{ id: CONVERSATION, prompt: TURN, thoughts: [{ generation_id: `${TURN}-0-k1`, model: "synthetic-model-high" }], sandbox: [] }]);
  await run(h, collector, 20 * SECOND);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.sent(2)[0]!.context, { models: [{ model: "synthetic-model-high" }] });
  assert.equal(h.checkpoint().offsets[name], grown);
  assert.deepEqual(h.checkpoint().conversations, [{ id: CONVERSATION, prompt: TURN, thoughts: [], sandbox: [] }]);
  // Context-only records: committed directly, with no request.
  h.append([h.line("afterAgentThought", thought(`${NEXT_TURN}-0-k2`, "synthetic-model-low")), "not a record", ""]);
  await run(h, collector, 4 * SECOND);
  assert.equal(h.requests.length, 3);
  assert.equal(h.checkpoint().offsets[name], size());
  assert.deepEqual(h.checkpoint().totals, { spooled: 4, acknowledged: 2, malformed: 1, expired: 0, rejected: 0, lost: 0, reframed: 0, requests: 3 });
});

test("a thought-only tail is committed without a request, and its segment is deleted once it has closed", async t => {
  const h = harness(t), first = h.segment();
  const collector = await h.start();
  // A headless run: tool records and thoughts, no prompt and no stop.
  h.append([
    h.line("postToolUse", tool("Read", "call-a", { generation_id: CONVERSATION })),
    h.line("afterAgentThought", thought(CONVERSATION, "default")),
    h.line("postToolUse", tool("Write", "call-b", { generation_id: CONVERSATION })),
  ]);
  await run(h, collector, 16 * SECOND);
  assert.deepEqual(h.delivered().map(row => row.payload.tool_name), ["Read", "Write"]);
  h.append(h.line("afterAgentThought", thought(CONVERSATION, "default")));
  let health = await run(h, collector, 4 * SECOND);
  assert.equal(h.requests.length, 1, "nothing to upload, nothing sent");
  assert.equal(h.checkpoint().offsets[path.basename(first)], fs.statSync(first).size);
  assert.deepEqual([health.status, health.backlogBytes, health.spoolSegments, health.recordsSpooled], ["idle", 0, 1, 4]);
  // Consumed to its end but not closed yet: a hook of the next bucket's first moments may still append to it.
  await run(h, collector, 10 * MINUTE, MINUTE);
  assert.ok(fs.existsSync(first));
  // A record in a later segment does not hold the first one back, and its own segment stays while it is open.
  h.append(h.line("postToolUse", tool("Read", "call-c", { generation_id: CONVERSATION })));
  const second = h.segment();
  assert.notEqual(second, first);
  health = await run(h, collector, 11 * MINUTE, MINUTE);
  assert.equal(fs.existsSync(first), false, "closed and consumed");
  assert.ok(fs.existsSync(second));
  assert.equal(h.requests.length, 2);
  health = await run(h, collector, 20 * MINUTE, MINUTE);
  assert.deepEqual(fs.readdirSync(h.files.spool), []);
  assert.deepEqual([health.spoolSegments, health.spoolBytes, h.requests.length], [0, 0, 2]);
});

test("a closed segment is kept while any of it is unanswered, and an empty closed one is removed", async t => {
  const h = harness(t), old = START - 45 * MINUTE;
  h.service.answer = () => SERVER_ERROR;
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: old }), old);
  fs.writeFileSync(h.segment(START - 35 * MINUTE), "");
  fs.writeFileSync(path.join(h.files.spool, "notes.txt"), "not a segment\n");
  const collector = await h.start();
  await run(h, collector, 2 * HOUR, 10 * MINUTE);
  assert.ok(h.requests.length > 1);
  assert.ok(fs.existsSync(h.segment(old)), "its record is still only in pending.json");
  assert.deepEqual(fs.readdirSync(h.files.spool).sort(), ["notes.txt", path.basename(h.segment(old))]);
  h.service.answer = () => OK;
  await run(h, collector, 2 * MINUTE);
  assert.deepEqual(fs.readdirSync(h.files.spool), ["notes.txt"]);
});

test("a stop carries the thoughts of its own turn: by turn key, de-duplicated, newest four, then evicted", async t => {
  const h = harness(t), at = START - MINUTE;
  const params = [{ id: "effort", value: "high" }];
  h.append([
    h.line("beforeSubmitPrompt", prompt(), { at }),
    h.line("afterAgentThought", thought(`${TURN}-0-a`, "model-a", { model_id: "a" }), { at }),
    h.line("afterAgentThought", thought(`${NEXT_TURN}-0-z`, "model-of-another-turn"), { at }),
    h.line("afterAgentThought", thought(`${TURN}-1-b`, "model-b"), { at }),
    h.line("afterAgentThought", thought(`${TURN}-2-c`, "model-c"), { at }),
    h.line("afterAgentThought", thought(`${TURN}-3-a`, "model-a", { model_id: "a", model_params: params }), { at }),
    h.line("afterAgentThought", thought(`${TURN}-4-d`, "model-d"), { at }),
    h.line("afterAgentThought", thought(`${TURN}x`, "model-with-a-longer-id"), { at }),
    h.line("afterAgentThought", thought(TURN, "default"), { at }),
    h.line("afterAgentThought", { generation_id: `${TURN}-5-e`, text: "names no model" }, { at }),
    h.line("stop", stop(), { at }),
    h.line("stop", stop(), { at }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const [, first, second] = h.sent(0);
  // model-b is the oldest of five distinct models and is cut; model-a moved to where it was last seen.
  assert.deepEqual(first!.context, { models: [{ model: "model-c" }, { model: "model-a", model_id: "a", model_params: params }, { model: "model-d" }, { model: "default" }] });
  assert.deepEqual(second!.context, {}, "the first stop used them up");
  // What is left belongs to another turn, or only looks like this one's. It waits for a stop that names it.
  assert.deepEqual(h.checkpoint().conversations, [{ id: CONVERSATION, prompt: TURN, sandbox: [],
    thoughts: [{ generation_id: `${NEXT_TURN}-0-z`, model: "model-of-another-turn", prior: true }, { generation_id: `${TURN}x`, model: "model-with-a-longer-id", prior: true }] }]);
  h.append(h.line("stop", stop(NEXT_TURN), { at }), at);
  await run(h, collector, 16 * SECOND);
  assert.deepEqual(h.sent(1)[0]!.context, { models: [{ model: "model-of-another-turn" }] });
});

test("without a turn key, a stop takes the thoughts read since its own prompt and no others", async t => {
  const h = harness(t), at = START - MINUTE;
  h.append([
    h.line("afterAgentThought", thought("unkeyed-0", "model-before-the-prompt"), { at }),
    h.line("beforeSubmitPrompt", prompt(), { at }),
    h.line("afterAgentThought", thought("unkeyed-1", "model-a"), { at }),
    h.line("afterAgentThought", { model: "model-b" }, { at }),
    h.line("stop", stop(NEXT_TURN), { at }),
    h.line("stop", stop(), { at }),
    h.line("stop", stop(), { at }),
    // A conversation whose prompt was never seen: nothing ties a thought to the stop.
    h.line("afterAgentThought", thought("unkeyed-2", "model-c"), { at, conversation: "other-conversation" }),
    h.line("stop", stop(), { at, conversation: "other-conversation" }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const stops = h.sent(0).filter(row => row.hook === "stop");
  assert.deepEqual(stops.map(row => row.context), [{}, { models: [{ model: "model-a" }, { model: "model-b" }] }, {}, {}]);
  assert.deepEqual(h.checkpoint().conversations.map((conversation: any) => [conversation.id, conversation.thoughts.map((item: any) => item.model)]),
    [[CONVERSATION, ["model-before-the-prompt"]], ["other-conversation", ["model-c"]]]);
});

test("two-turn race: the next prompt reaches the spool before the previous stop, and each stop keeps its own model", async t => {
  const h = harness(t), at = START - MINUTE;
  h.append([
    h.line("beforeSubmitPrompt", prompt(TURN), { at }),
    h.line("afterAgentThought", thought(`${TURN}-0-p`, "model-of-turn-one"), { at }),
    h.line("beforeSubmitPrompt", prompt(NEXT_TURN), { at: at + 1 }),
    h.line("stop", stop(TURN), { at: at + 2 }),
    h.line("afterAgentThought", thought(`${NEXT_TURN}-0-q`, "model-of-turn-two"), { at: at + 3 }),
    h.line("stop", stop(NEXT_TURN), { at: at + 4 }),
  ], at);
  // The same race in a conversation whose thoughts carry no turn key: the first stop goes without, never with the wrong one.
  h.append([
    h.line("beforeSubmitPrompt", prompt(TURN), { at, conversation: "unkeyed" }),
    h.line("afterAgentThought", thought("x-1", "model-of-turn-one"), { at, conversation: "unkeyed" }),
    h.line("beforeSubmitPrompt", prompt(NEXT_TURN), { at: at + 1, conversation: "unkeyed" }),
    h.line("stop", stop(TURN), { at: at + 2, conversation: "unkeyed" }),
    h.line("afterAgentThought", thought("x-2", "model-of-turn-two"), { at: at + 3, conversation: "unkeyed" }),
    h.line("stop", stop(NEXT_TURN), { at: at + 4, conversation: "unkeyed" }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const stops = h.sent(0).filter(row => row.hook === "stop").map(row => [row.session, row.payload.generation_id, row.context]);
  assert.deepEqual(stops, [
    [CONVERSATION, TURN, { models: [{ model: "model-of-turn-one" }] }],
    [CONVERSATION, NEXT_TURN, { models: [{ model: "model-of-turn-two" }] }],
    ["unkeyed", TURN, {}],
    ["unkeyed", NEXT_TURN, { models: [{ model: "model-of-turn-two" }] }],
  ]);
});

test("a thought that reaches the spool after its stop is still attached, and is not kept afterwards", async t => {
  const h = harness(t), at = START - MINUTE;
  h.append([
    h.line("beforeSubmitPrompt", prompt(), { at }),
    h.line("stop", stop(), { at: at + 40 }),
    h.line("afterAgentThought", thought(`${TURN}-0-late`, "synthetic-model-high"), { at: at + 30 }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0)[1]!.context, { models: [{ model: "synthetic-model-high" }] });
  assert.deepEqual(h.checkpoint().conversations, [{ id: CONVERSATION, prompt: TURN, thoughts: [], sandbox: [] }]);
});

test("a sandbox flag is attached whether it reached the spool before its tool record or after it", async t => {
  const h = harness(t), at = START - MINUTE;
  h.append([
    h.line("afterShellExecution", shell("shell-before", true), { at }),
    h.line("postToolUse", tool("Shell", "shell-before"), { at: at + 25 }),
    h.line("postToolUse", tool("Shell", "shell-after"), { at: at + 1000 }),
    h.line("afterShellExecution", shell("shell-after", false), { at: at + 1022 }),
    h.line("postToolUseFailure", tool("Shell", "shell-failed", { result: undefined, failure_type: "timeout", is_interrupt: false, error_bytes: 12 }), { at: at + 2000 }),
    h.line("afterShellExecution", shell("shell-failed", true), { at: at + 2001 }),
    // Used once: a second record with the same raw id finds nothing.
    h.line("postToolUse", tool("Shell", "shell-before"), { at: at + 3000 }),
    h.line("postToolUse", tool("Read", "call-read"), { at: at + 3000 }),
    // The same id in another conversation, and the same id minutes later, are not this record's execution.
    h.line("postToolUse", tool("Shell", "shell-elsewhere"), { at: at + 4000 }),
    h.line("afterShellExecution", shell("shell-elsewhere", true), { at: at + 4001, conversation: "other-conversation" }),
    h.line("postToolUse", tool("Shell", "shell-reused"), { at: at + 5000 }),
    h.line("afterShellExecution", shell("shell-reused", true), { at: at + 5000 + 3 * SECOND }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0).map(row => [row.payload.tool_use_id, row.context]), [
    ["shell-before", { shell: { sandbox: true } }],
    ["shell-after", { shell: { sandbox: false } }],
    ["shell-failed", { shell: { sandbox: true } }],
    ["shell-before", {}],
    ["call-read", {}],
    ["shell-elsewhere", {}],
    ["shell-reused", {}],
  ]);
  assert.deepEqual(h.checkpoint().conversations, [
    { id: "other-conversation", thoughts: [], sandbox: [["shell-elsewhere", true]] },
    { id: CONVERSATION, thoughts: [], sandbox: [["shell-reused", true]] },
  ]);
});

test("a flag that has not settled is read for its tool record but consumed only later, and leaves nothing behind", async t => {
  const h = harness(t), name = path.basename(h.segment());
  const collector = await h.start();
  // Sixty-four waiting records frame at once; the last is a shell call whose flag is 30 ms younger.
  h.append(Array.from({ length: 63 }, (_, index) => h.line("postToolUse", tool("Read", `call-${index}`), { at: START - 10 * SECOND })));
  h.append(h.line("postToolUse", tool("Shell", "shell-edge"), { at: START - 2010 }));
  const consumed = fs.statSync(h.segment()).size;
  h.append(h.line("afterShellExecution", shell("shell-edge", true), { at: START - 1980 }));
  await collector.tick();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.sent(0).at(-1)!.context, { shell: { sandbox: true } });
  assert.equal(h.checkpoint().offsets[name], consumed, "the flag's own line is not consumed yet");
  assert.equal(h.checkpoint().conversations[0].used.length, 1);
  await run(h, collector, 4 * SECOND);
  assert.equal(h.checkpoint().offsets[name], fs.statSync(h.segment()).size);
  assert.deepEqual(h.checkpoint().conversations, [], "the flag was already used, so it is not kept for a later record");
  assert.equal(h.requests.length, 1);
});

test("a record at the edge of a bounded read waits for the companions the read did not reach", async t => {
  const h = harness(t), at = START - 10 * MINUTE;
  // The 256th record of a backlog is a shell call; its flag is the 257th line.
  h.append([
    ...Array.from({ length: 255 }, (_, index) => h.line("postToolUse", tool("Read", `call-${index}`), { at: at + index * SECOND })),
    h.line("postToolUse", tool("Shell", "shell-edge"), { at: at + 255 * SECOND }),
    h.line("afterShellExecution", shell("shell-edge", true), { at: at + 255 * SECOND + 20 }),
    h.line("postToolUse", tool("Read", "call-after"), { at: at + 256 * SECOND }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0).map(row => row.payload.tool_use_id), Array.from({ length: 254 }, (_, index) => `call-${index}`),
    "the records of the window's last two seconds are held back");
  await run(h, collector, 20 * SECOND);
  assert.deepEqual(h.sent(1).map(row => [row.payload.tool_use_id, row.context]),
    [["call-254", {}], ["shell-edge", { shell: { sandbox: true } }], ["call-after", {}]]);
  assert.deepEqual(h.checkpoint().conversations, []);
});

test("no record younger than the settle window is framed, unless the pass is immediate", async t => {
  const h = harness(t);
  const collector = await h.start();
  h.append(Array.from({ length: 70 }, (_, index) => h.line("postToolUse", tool("Read", `old-${index}`), { at: START - 5 * SECOND })));
  h.append(h.line("postToolUse", tool("Read", "young"), { at: START - 1500 }));
  // Behind a record that has not settled, an older one waits too: consumption never skips ahead.
  h.append(h.line("postToolUse", tool("Read", "behind"), { at: START - 5 * SECOND }));
  await collector.tick();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.sent(0).map(row => row.payload.tool_use_id), Array.from({ length: 70 }, (_, index) => `old-${index}`));
  // The request gap holds the rest back even on an immediate pass.
  let health = await collector.tick({ immediate: true });
  assert.deepEqual([h.requests.length, health.status], [1, "waiting"]);
  h.clock.now += 15 * SECOND;
  h.append(h.line("postToolUse", tool("Read", "just-written")));
  health = await collector.tick({ immediate: true });
  assert.deepEqual(h.sent(1).map(row => row.payload.tool_use_id), ["young", "behind", "just-written"]);
  assert.equal(health.status, "idle");
});

test("a record older than fourteen days when it is read is dropped and counted", async t => {
  const h = harness(t), old = START - 14 * DAY;
  h.append([
    h.line("beforeSubmitPrompt", prompt(), { at: old - SECOND }),
    h.line("afterAgentThought", thought(`${TURN}-0-e`, "expired-model"), { at: old - SECOND }),
    h.line("stop", stop(), { at: old + MINUTE }),
  ], old);
  // A capture time more than a day ahead of the clock is not a capture time. One that is less far ahead means
  // the clock was set back: the record is sent as stamped and at once, so it cannot hold the spool until then.
  h.append([h.line("stop", stop(), { at: START + 2 * DAY }), h.line("stop", stop(NEXT_TURN), { at: START + 6 * HOUR }),
    h.line("postToolUse", tool("Read", "after-the-future"), { at: START - MINUTE })]);
  const collector = await h.start();
  const health = await collector.tick();
  assert.deepEqual(h.delivered().map(row => [row.hook, row.payload.generation_id, row.context, row.time]), [
    ["stop", TURN, {}, `${old + MINUTE}000000`], ["stop", NEXT_TURN, {}, `${START + 6 * HOUR}000000`], ["postToolUse", TURN, {}, `${START - MINUTE}000000`]]);
  assert.deepEqual([health.recordsExpired, health.recordsSpooled, health.recordsAcknowledged, health.recordsMalformed, health.backlogBytes], [2, 3, 3, 1, 0]);
  assert.deepEqual(h.checkpoint().conversations, []);
});

test("malformed, foreign, oversized and partial lines are skipped and counted, and their neighbours are delivered", async t => {
  const h = harness(t), at = START - MINUTE, good = (id: string) => h.line("postToolUse", tool("Read", id), { at });
  const valid = JSON.parse(good("template"));
  const variants = [
    { ...valid, v: 2 }, { ...valid, id: "short" }, { ...valid, id: "G".repeat(32) }, { ...valid, t: "soon" }, { ...valid, t: "1".repeat(20) },
    { ...valid, hook: "sessionStart" }, { ...valid, conversation_id: "has space" }, { ...valid, conversation_id: "x".repeat(257) },
    { ...valid, p: { prompts: false, toolDetails: false } }, { ...valid, p: "none" }, { ...valid, payload: [] }, { ...valid, payload: null },
    [valid], "text", 7, null,
  ];
  h.append([
    good("first"),
    "{\"v\":1,\"id\":\"cut off in the middle",
    ...variants.map(variant => JSON.stringify(variant)),
    "\u00ff\u00fe not json",
    "",
    `{"v":1,"padding":"${"x".repeat(CURSOR_HOOK_LIMITS.lineBytes)}"}`,
    good("second"),
  ], at);
  fs.appendFileSync(h.segment(at), Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x0a]));
  h.append(good("third"), at);
  const collector = await h.start();
  let health = await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["first", "second", "third"]);
  assert.deepEqual([health.recordsMalformed, health.recordsSpooled, health.backlogBytes], [variants.length + 4, 3, 0]);
  // An unfinished last line in an open segment waits for its writer.
  const whole = good("completed-later"), cut = 40;
  fs.appendFileSync(h.segment(at), whole.slice(0, cut));
  const offset = h.checkpoint().offsets[path.basename(h.segment(at))];
  health = await run(h, collector, 20 * SECOND);
  assert.deepEqual([h.requests.length, health.backlogBytes, h.checkpoint().offsets[path.basename(h.segment(at))]], [1, cut, offset]);
  fs.appendFileSync(h.segment(at), `${whole.slice(cut)}\n`);
  await run(h, collector, 20 * SECOND);
  assert.deepEqual(h.sent(1).map(row => row.payload.tool_use_id), ["completed-later"]);
  // In a closed segment it is skipped: no writer will finish it.
  fs.appendFileSync(h.segment(at), good("never-finished").slice(0, cut));
  health = await run(h, collector, 25 * MINUTE, MINUTE);
  assert.equal(health.recordsMalformed, variants.length + 5);
  assert.equal(fs.existsSync(h.segment(at)), false);
  assert.equal(h.requests.length, 2);
});

test("a line longer than any record is skipped even when its newline is far away", async t => {
  const h = harness(t), at = START - MINUTE;
  h.append(h.line("postToolUse", tool("Read", "before"), { at }), at);
  fs.appendFileSync(h.segment(at), "y".repeat(300 * 1024));
  const collector = await h.start({ limits: { readBytes: 128 * 1024 } });
  const health = await run(h, collector, 10 * SECOND);
  fs.appendFileSync(h.segment(at), `\n${h.line("postToolUse", tool("Read", "after"), { at })}\n`);
  await run(h, collector, 30 * SECOND);
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["before", "after"]);
  assert.ok(health.recordsMalformed >= 1 && collector.snapshot().recordsMalformed <= 4);
  assert.equal(collector.snapshot().backlogBytes, 0);
});

test("a segment that is a link or a pipe is never read, followed or removed", { skip: process.platform === "win32" }, async t => {
  const h = harness(t), outside = path.join(h.root, "outside.jsonl"), at = START - 40 * MINUTE;
  fs.writeFileSync(outside, `${h.line("postToolUse", tool("Read", "outside"), { at })}\n`);
  fs.symlinkSync(outside, h.segment(at));
  h.append(h.line("postToolUse", tool("Read", "inside"), { at: START - MINUTE }), START - MINUTE);
  const collector = await h.start();
  await run(h, collector, HOUR, 5 * MINUTE);
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["inside"]);
  assert.ok(fs.lstatSync(h.segment(at)).isSymbolicLink());
  assert.ok(fs.existsSync(outside));
});

test("cadence: nothing is framed before sixty-four records or fifteen seconds, and request starts are fifteen seconds apart", async t => {
  const h = harness(t);
  const collector = await h.start();
  h.append(Array.from({ length: 63 }, (_, index) => h.line("postToolUse", tool("Read", `call-${index}`))));
  await run(h, collector, 14 * SECOND);
  assert.equal(h.requests.length, 0, "sixty-three records, fourteen seconds");
  await run(h, collector, 2 * SECOND);
  assert.deepEqual([h.requests.length, h.requests[0]!.at - START], [1, 16 * SECOND]);
  // Sixty-four waiting records do not wait for the linger, but they do wait for the gap.
  h.append(Array.from({ length: 64 }, (_, index) => h.line("postToolUse", tool("Read", `burst-${index}`))));
  let health = await run(h, collector, 14 * SECOND);
  assert.deepEqual([h.requests.length, health.status], [1, "waiting"]);
  await run(h, collector, 2 * SECOND);
  assert.deepEqual([h.requests.length, h.requests[1]!.at - h.requests[0]!.at, h.sent(1).length], [2, 16 * SECOND, 64]);
  // With the gap long past, sixty-four records leave as soon as they have settled.
  h.clock.now += MINUTE;
  h.append(Array.from({ length: 64 }, (_, index) => h.line("postToolUse", tool("Read", `ready-${index}`))));
  health = await run(h, collector, 2 * SECOND);
  assert.equal(h.requests.length, 3);
  assert.equal(health.requestsLastMinute, 1);
});

test("a burst of a thousand records in one minute produces at most four requests in any minute", async t => {
  const h = harness(t);
  // A fixed sequence, so the jitter is exercised and the run is repeatable.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const collector = await h.start({ random });
  h.append(Array.from({ length: 1000 }, (_, index) => h.line("postToolUse", tool("Read", `call-${index}`), { at: START + index * 60 })));
  let health = await run(h, collector, 3 * MINUTE);
  const starts = h.requests.map(request => request.at - START);
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), Array.from({ length: 1000 }, (_, index) => `call-${index}`), "everything, once, in order");
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index]! - starts[index - 1]! >= CURSOR_LIMITS.postGapMs, `gap before request ${index}`);
  for (const from of starts) assert.ok(starts.filter(at => at >= from && at < from + MINUTE).length <= 4, `window from ${from}`);
  assert.ok(starts.filter(at => at < MINUTE).length <= 4);
  for (const request of h.requests) {
    assert.ok(framed(request.body).length <= CURSOR_LIMITS.envelopeRecords);
    assert.ok(Buffer.byteLength(request.body) <= CURSOR_LIMITS.frameBytes);
  }
  assert.deepEqual([health.recordsAcknowledged, health.backlogBytes, health.requests], [1000, 0, starts.length]);
  assert.ok(starts.length <= 8, `${starts.length} requests for a thousand records`);
});

test("a backlog drains in bounded passes: at most 256 records read and one envelope per request", async t => {
  const h = harness(t), at = START - HOUR;
  // Six hundred records of one instant, spread over three segments.
  for (let part = 0; part < 3; part++) {
    h.append(Array.from({ length: 200 }, (_, index) => h.line("postToolUse", tool("Read", `call-${part * 200 + index}`), { at })), at + part * 10 * MINUTE);
  }
  const collector = await h.start();
  await run(h, collector, 2 * MINUTE);
  assert.deepEqual(h.requests.map(request => framed(request.body).length), [256, 256, 88]);
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), Array.from({ length: 600 }, (_, index) => `call-${index}`));
  assert.deepEqual(fs.readdirSync(h.files.spool), [], "closed and consumed");
  assertRequestGap(h);
  // The record bound of an envelope holds on its own, whatever a pass reads.
  h.append(Array.from({ length: 250 }, (_, index) => h.line("postToolUse", tool("Read", `more-${index}`), { at: h.clock.now - MINUTE })));
  await collector.close();
  await run(h, await h.start({ limits: { envelopeRecords: 100 } }), 2 * MINUTE);
  assert.deepEqual(h.requests.slice(3).map(request => framed(request.body).length), [100, 100, 50]);
});

test("a pass is bounded in lines and in time, and still moves forward", async t => {
  const h = harness(t), at = START - HOUR;
  // Nine thousand lines of noise ahead of one record: 4096 lines a pass.
  h.append([...Array.from({ length: 9000 }, () => "x"), h.line("postToolUse", tool("Read", "after-the-noise"), { at })], at);
  let collector = await h.start();
  const passes: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    h.clock.now += 2 * SECOND;
    passes.push((await collector.tick()).recordsMalformed);
  }
  assert.deepEqual(passes, [4096, 8192, 9000]);
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["after-the-noise"]);
  await collector.close();
  // With no time left after its first read, a pass takes one segment and the next pass takes the next.
  for (let part = 0; part < 3; part++) h.append(h.line("postToolUse", tool("Read", `segment-${part}`), { at: h.clock.now - MINUTE }), at + (part + 1) * 10 * MINUTE);
  collector = await h.start({ limits: { tickBudgetMs: 0 } });
  await run(h, collector, MINUTE);
  assert.deepEqual(h.requests.slice(1).map(request => framed(request.body).map(row => row.payload.tool_use_id)), [["segment-0"], ["segment-1"], ["segment-2"]]);
});

test("the frame stays under 200 KiB however large the records are, and the read budget bounds a pass", async t => {
  const h = harness(t, { policy: EVERYTHING }), at = START - MINUTE;
  const text = "p".repeat(16_000);
  h.append(Array.from({ length: 40 }, (_, index) => h.line("beforeSubmitPrompt", prompt(TURN, { prompt: text, prompt_length: index }), { at, p: EVERYTHING })), at);
  const collector = await h.start({ limits: { readBytes: 256 * 1024 } });
  await run(h, collector, 5 * MINUTE);
  assert.deepEqual(h.delivered().map(row => row.payload.prompt_length), Array.from({ length: 40 }, (_, index) => index));
  assert.ok(h.requests.length >= 4);
  for (const request of h.requests) {
    assert.ok(Buffer.byteLength(request.body) <= CURSOR_LIMITS.frameBytes);
    assert.ok(framed(request.body).length <= 12 && framed(request.body).every(row => row.payload.prompt === text));
  }
});

test("a prompt the hook cut to fill the line bound exactly is uploaded whole, inside the record bound", async t => {
  const h = harness(t, { policy: EVERYTHING }), at = START - MINUTE, id = "a".repeat(32);
  const lineOf = (text: string) => h.line("beforeSubmitPrompt", prompt(TURN, { prompt: text }), { at, p: EVERYTHING, id });
  // Three bytes a character, as in a long prompt that is not ASCII: the line and its newline fill the bound.
  const room = CURSOR_HOOK_LIMITS.promptLineBytes - 1 - Buffer.byteLength(lineOf(""));
  const text = String.fromCodePoint(0x4e16).repeat(Math.floor(room / 3)) + "x".repeat(room % 3);
  assert.equal(Buffer.byteLength(lineOf(text)) + 1, CURSOR_HOOK_LIMITS.promptLineBytes);
  h.append(lineOf(text), at);
  const collector = await h.start();
  const health = await collector.tick();
  assert.equal(h.sent(0)[0]!.payload.prompt, text);
  assert.deepEqual([health.recordsMalformed, health.recordsAcknowledged, health.backlogBytes], [0, 1, 0]);
  const record = JSON.parse(h.requests[0]!.body).resourceLogs[0].scopeLogs[0].logRecords[0].attributes
    .find((attribute: any) => attribute.key === "cursor.source.record").value.stringValue;
  assert.ok(Buffer.byteLength(record) < 32 * 1024, "a prompt record stays inside the record bound of every service release");
});

test("the state files stay inside their bounds in the worst case for escaping", async t => {
  const h = harness(t, { policy: EVERYTHING }), at = START - MINUTE;
  // Quotes double in the record, again in the envelope and again in pending.json.
  const quotes = "\"".repeat(15_000);
  const huge = { id: "p".repeat(64), value: "v".repeat(64) };
  h.service.answer = (_sent, index) => index === 0 ? SERVER_ERROR : OK;
  h.append([
    ...Array.from({ length: 12 }, (_, index) => h.line("afterAgentThought", thought(`${TURN}-${index}-${"g".repeat(200)}`, `${"m".repeat(120)}-${index}`,
      { model_id: "i".repeat(128), model_params: Array.from({ length: 8 }, () => huge) }), { at })),
    ...Array.from({ length: 4 }, () => h.line("beforeSubmitPrompt", prompt(TURN, { prompt: quotes }), { at, p: EVERYTHING })),
    h.line("stop", stop(), { at }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0).map(row => row.payload.prompt), [quotes, quotes, quotes], "the fourth does not fit the frame");
  assert.ok(Buffer.byteLength(h.requests[0]!.body) <= CURSOR_LIMITS.frameBytes);
  assert.ok(Buffer.byteLength(h.requests[0]!.body) > 150 * 1024, "a meaningful worst case");
  assert.ok(fs.statSync(h.files.pending).size > 1.9 * Buffer.byteLength(h.requests[0]!.body), "the body nearly doubles on disk");
  assert.ok(fs.statSync(h.files.pending).size <= CURSOR_LIMITS.pendingBytes);
  await run(h, collector, MINUTE);
  assert.equal(h.requests[1]!.body, h.requests[0]!.body);
  const last = h.sent(2).at(-1)!;
  assert.deepEqual([last.hook, last.context.models.length, last.context.models.map((model: any) => model.model_params.length)], ["stop", 4, [8, 8, 8, 8]]);
  assert.deepEqual(last.context.models.map((model: any) => model.model.slice(-3)), ["m-8", "m-9", "-10", "-11"], "the newest four");
  assert.ok(Buffer.byteLength(JSON.stringify(last)) < CURSOR_LIMITS.recordBytes);
  assert.ok(fs.statSync(h.files.checkpoint).size <= CURSOR_LIMITS.checkpointBytes);
});

test("context memory is bounded per conversation, in conversations and in bytes, least recently used first to go", async t => {
  const h = harness(t), at = START - MINUTE;
  const huge = { id: "p".repeat(64), value: "v".repeat(64) };
  const big = (index: number) => thought(`g-${index}-${"g".repeat(240)}`, `${"m".repeat(120)}-${index}`, { model_id: "i".repeat(128), model_params: Array.from({ length: 8 }, () => huge) });
  const lines: string[] = [];
  for (let conversation = 0; conversation < 70; conversation++) {
    for (let index = 0; index < 70; index++) lines.push(h.line("afterAgentThought", big(index), { at, conversation: `conversation-${conversation}` }));
    for (let index = 0; index < 40; index++) lines.push(h.line("afterShellExecution", shell(`id-${index}-${"s".repeat(480)}`, true), { at, conversation: `conversation-${conversation}` }));
  }
  h.append(lines, at);
  const collector = await h.start();
  let health = await run(h, collector, 2 * MINUTE);
  assert.deepEqual([health.recordsSpooled, health.backlogBytes, h.requests.length], [70 * 110, 0, 0]);
  const saved = h.checkpoint().conversations as Array<{ id: string; thoughts: Array<{ generation_id: string }>; sandbox: Array<[string, boolean]> }>;
  assert.ok(saved.length < CURSOR_LIMITS.conversations, "the byte bound bites before the count does here");
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= CURSOR_LIMITS.contextBytes);
  assert.ok(fs.statSync(h.files.checkpoint).size <= CURSOR_LIMITS.checkpointBytes);
  assert.equal(saved.at(-1)!.id, "conversation-69", "the most recently used survive");
  for (const conversation of saved) {
    assert.deepEqual(conversation.thoughts.map(item => item.generation_id.split("-")[1]), Array.from({ length: 64 }, (_, index) => String(index + 6)), "the newest sixty-four");
    assert.equal(conversation.sandbox.length, 32);
    assert.equal(conversation.sandbox[0]![0].slice(0, 5), "id-8-");
  }
  // Small states: the count bound.
  h.append(Array.from({ length: 80 }, (_, index) => h.line("afterAgentThought", thought("g", "m"), { at, conversation: `small-${index}` })), at);
  health = await run(h, collector, 10 * SECOND);
  const ids = (h.checkpoint().conversations as Array<{ id: string }>).map(conversation => conversation.id);
  assert.equal(ids.length, CURSOR_LIMITS.conversations);
  assert.deepEqual([ids[0], ids.at(-1)], ["small-16", "small-79"]);
});

test("retry-after is honoured, a failed connection backs off like a server error, and neither ever parks", async t => {
  const h = harness(t);
  const answers: CollectorPostResult[] = [
    { outcome: "retry", detail: "rate_limited", httpStatus: 429, retryAfterMs: 60 * SECOND },
    { outcome: "retry", detail: "server", httpStatus: 503, retryAfterMs: 5 * SECOND },
    { outcome: "network", detail: "proxy", errorClass: "proxy" },
    { outcome: "network", detail: "tls", errorClass: "tls" },
    SERVER_ERROR, SERVER_ERROR, SERVER_ERROR, SERVER_ERROR,
  ];
  h.service.answer = (_sent, index) => answers[index] ?? OK;
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), START - MINUTE);
  const collector = await h.start();
  let health = await collector.tick();
  assert.deepEqual([health.status, health.lastOutcome, health.lastDetail, health.nextAttemptAt! - START], ["retrying", "retry", "rate_limited", 60 * SECOND]);
  await run(h, collector, 59 * SECOND, SECOND);
  assert.equal(h.requests.length, 1, "not one second early");
  health = await run(h, collector, SECOND, SECOND);
  assert.equal(h.requests.length, 2);
  // A retry-after shorter than the collector's own gap does not shorten it; the backoff doubles to a minute.
  const waits: number[] = [];
  for (let index = 2; index <= answers.length; index++) {
    const next = collector.snapshot().nextAttemptAt!;
    waits.push(next - h.requests.at(-1)!.at);
    h.clock.now = next - 1;
    await collector.tick();
    assert.equal(h.requests.length, index, "not one millisecond early");
    h.clock.now = next;
    health = await collector.tick();
    assert.equal(h.requests.length, index + 1);
    if (index === 2) assert.deepEqual([health.lastOutcome, health.lastErrorClass, health.lastDetail], ["network", "proxy", "proxy"]);
    if (index === 3) assert.deepEqual([health.lastOutcome, health.lastErrorClass], ["network", "tls"]);
  }
  assert.deepEqual(waits, [15, 15, 16, 32, 60, 60, 60].map(seconds => seconds * SECOND));
  assert.deepEqual([health.lastOutcome, health.lastErrorClass, health.status, health.recordsAcknowledged], ["ok", null, "idle", 1]);
  for (const request of h.requests) assert.deepEqual([request.key, request.body], [h.requests[0]!.key, h.requests[0]!.body]);
});

test("a transport that throws is a failed connection, not a crash", async t => {
  const h = harness(t);
  h.service.answer = (_sent, index) => {
    if (index === 0) throw new Error(`secret ${KEY}`);
    return OK;
  };
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), START - MINUTE);
  const collector = await h.start();
  const health = await collector.tick();
  assert.deepEqual([health.lastOutcome, health.lastErrorClass, health.status], ["network", "network", "retrying"]);
  assert.doesNotMatch(JSON.stringify(health) + fs.readFileSync(h.files.pending, "utf8"), /secret|cot_/);
  await run(h, collector, 20 * SECOND);
  assert.equal(collector.snapshot().recordsAcknowledged, 1);
});

test("a refused key is retried after a minute and then every fifteen minutes; an exhausted budget every fifteen", async t => {
  const h = harness(t);
  const auth: CollectorPostResult = { outcome: "auth", detail: "auth", httpStatus: 401 };
  const budget: CollectorPostResult = { outcome: "budget", detail: "budget", httpStatus: 402 };
  const answers = [auth, auth, auth, budget, budget, auth];
  h.service.answer = (_sent, index) => answers[index] ?? OK;
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), START - MINUTE);
  const collector = await h.start();
  await collector.tick();
  await run(h, collector, 3 * HOUR, 5 * SECOND);
  const gaps = h.requests.slice(1).map((request, index) => request.at - h.requests[index]!.at);
  // A different answer in between starts the one-minute step again.
  assert.deepEqual(gaps, [MINUTE, 15 * MINUTE, 15 * MINUTE, 15 * MINUTE, 15 * MINUTE, MINUTE]);
  assert.deepEqual([collector.snapshot().recordsAcknowledged, h.quarantined().length], [1, 0]);
});

for (const [name, status, body] of [
  ["a 415", 415, '{"error":"unsupported source format","code":"source_format_unsupported"}'],
  ["a 400 without the invalid-frame code", 400, '{"error":"invalid or unsupported source envelope"}'],
  ["a 2xx without the format echo", 200, "{}"],
] as const) {
  test(`${name} is a service that does not serve the format: retried every fifteen minutes and never quarantined`, async t => {
    const h = harness(t);
    let supported = false;
    const post = cursorTransport({ endpoint: ENDPOINT, key: KEY, env: {}, fetchImpl: async (_url, init) => {
      h.requests.push({ at: h.clock.now, key: (init!.headers as Record<string, string>)[IDEMPOTENCY_HEADER]!, body: init!.body as string });
      return supported ? new Response("{}", { status: 200, headers: { [SOURCE_FORMAT_HEADER]: CURSOR_SOURCE_FORMAT } }) : new Response(body, { status });
    } });
    h.append([h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), h.line("stop", stop(), { at: START - MINUTE })], START - MINUTE);
    const collector = await h.start({ post });
    await collector.tick();
    let health = await run(h, collector, 48 * HOUR, MINUTE);
    assert.equal(h.requests.length, 1 + 48 * 4);
    assert.ok(h.requests.slice(1).every((request, index) => request.at - h.requests[index]!.at === 15 * MINUTE));
    assert.ok(h.requests.every(request => request.key === h.requests[0]!.key && request.body === h.requests[0]!.body));
    assert.deepEqual([health.status, health.lastOutcome, health.lastDetail, health.recordsRejected, health.recordsLost, health.rejectedEnvelopes],
      ["retrying", "unsupported", "unsupported", 0, 0, 0]);
    assert.deepEqual(h.quarantined(), []);
    assert.equal(fs.existsSync(h.files.checkpoint), false, "the records wait in the spool");
    assert.ok(fs.existsSync(h.segment(START - MINUTE)), "a closed segment with unanswered records is kept");
    supported = true;
    health = await run(h, collector, 15 * MINUTE, MINUTE);
    assert.deepEqual([health.status, health.recordsAcknowledged, health.requests], ["idle", 2, 2 + 48 * 4]);
  });
}

test("a refused frame is retried at one, five and thirty minutes, then hourly, and set aside after a day", async t => {
  const h = harness(t);
  const post = cursorTransport({ endpoint: ENDPOINT, key: KEY, env: {}, fetchImpl: async (_url, init) => {
    const sent = { at: h.clock.now, key: (init!.headers as Record<string, string>)[IDEMPOTENCY_HEADER]!, body: init!.body as string };
    h.requests.push(sent);
    return framed(sent.body).some(row => row.payload.generation_id === TURN)
      ? new Response('{"error":"invalid source envelope","code":"source_envelope_invalid"}', { status: 400 })
      : new Response("{}", { status: 200, headers: { [SOURCE_FORMAT_HEADER]: CURSOR_SOURCE_FORMAT } });
  } });
  h.append([h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), h.line("afterAgentThought", thought(`${TURN}-0-r`, "synthetic-model-high"), { at: START - MINUTE }),
    h.line("stop", stop(), { at: START - MINUTE })], START - MINUTE);
  const collector = await h.start({ post });
  let health = await collector.tick();
  assert.deepEqual([health.lastOutcome, health.lastDetail, health.nextAttemptAt! - START], ["rejected", "invalid", MINUTE]);
  // Records captured meanwhile wait behind it; they are not lost and not reordered.
  h.append(h.line("beforeSubmitPrompt", prompt(NEXT_TURN)));
  health = await run(h, collector, 24 * HOUR - MINUTE, 30 * SECOND);
  const first = h.requests[0]!, refused = h.requests.length;
  assert.deepEqual(h.requests.slice(0, 6).map(request => (request.at - START) / MINUTE), [0, 1, 6, 36, 96, 156]);
  assert.ok(h.requests.every(request => request.key === first.key && request.body === first.body));
  assert.deepEqual([health.status, health.recordsRejected, h.quarantined().length], ["retrying", 0, 0]);
  assert.equal(fs.existsSync(h.files.checkpoint), false);
  health = await run(h, collector, 2 * HOUR, 30 * SECOND);
  // The refusal that falls after the day moves the envelope aside and commits what it covered.
  assert.equal(h.requests.filter(request => request.key === first.key).length, refused + 1);
  assert.deepEqual(h.quarantined(), [`${first.key}.json`]);
  const file = path.join(h.files.rejected, `${first.key}.json`), kept = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([kept.version, kept.id, kept.body, kept.records, kept.destinationHash, kept.policy, kept.createdAt, kept.rejectedAt - START >= DAY],
    [1, first.key, first.body, 2, DESTINATION, METADATA, START, true]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.files.rejected).mode & 0o777, 0o700);
  assert.deepEqual([health.recordsRejected, health.recordsLost, health.rejectedEnvelopes, health.rejectedBytes, health.recordsSpooled],
    [2, 0, 1, fs.statSync(file).size, 4]);
  // The queue moved on: the next envelope is the record that waited.
  assert.deepEqual(h.delivered().filter(row => row.payload.generation_id === NEXT_TURN).length, 1);
  assert.deepEqual([health.status, health.recordsAcknowledged, h.pending()], ["idle", 1, null]);
  assert.deepEqual(h.checkpoint().conversations, [{ id: CONVERSATION, prompt: NEXT_TURN, thoughts: [], sandbox: [] }]);
  assertRequestGap(h);
});

test("the quarantine is bounded in bytes and files: the oldest envelopes go first and their records are counted lost", async t => {
  const h = harness(t), at = START - MINUTE;
  h.service.answer = () => INVALID;
  // Each envelope is one record of about a kilobyte; the budget holds three.
  const pad = "m".repeat(100);
  const collector = await h.start({ limits: { rejectedBytes: 5 * 1024, lingerRecords: 1, envelopeRecords: 1 } });
  const keys: string[] = [];
  for (let index = 0; index < 6; index++) {
    h.append(h.line("postToolUse", tool("Read", `call-${index}`, { model: pad }), { at: h.clock.now - MINUTE }));
    await run(h, collector, 26 * HOUR, 10 * MINUTE);
    const key = h.requests.at(-1)!.key;
    assert.ok(!keys.includes(key));
    keys.push(key);
    const health = collector.snapshot();
    assert.ok(health.rejectedBytes <= 5 * 1024, `inside the budget after envelope ${index}`);
    assert.equal(health.rejectedBytes, h.quarantined().reduce((sum, name) => sum + fs.statSync(path.join(h.files.rejected, name)).size, 0));
    assert.equal(health.recordsRejected, index + 1);
    assert.equal(health.recordsLost + health.rejectedEnvelopes, index + 1);
  }
  const kept = h.quarantined().map(name => name.replace(".json", ""));
  assert.ok(kept.length >= 2 && kept.length < 6);
  assert.deepEqual(kept.sort(), keys.slice(-kept.length).sort(), "the newest envelopes are the ones kept");
  // A lower file bound applies at the next start, again oldest first.
  await collector.close();
  const restarted = await h.start({ limits: { rejectedFiles: 1 } });
  assert.deepEqual(h.quarantined(), [`${keys.at(-1)}.json`]);
  assert.deepEqual([restarted.snapshot().recordsLost, restarted.snapshot().rejectedEnvelopes], [5, 1]);
  assert.equal(h.checkpoint().totals.lost, 5);
});

test("retry-rejected returns quarantined envelopes to the head of the queue with their bytes and their key", async t => {
  const h = harness(t), marker = path.join(h.stateDir, "retry-rejected");
  let accept = false;
  h.service.answer = () => accept ? OK : INVALID;
  const collector = await h.start({ limits: { lingerRecords: 1, envelopeRecords: 1 } });
  h.append(h.line("postToolUse", tool("Read", "first"), { at: START - MINUTE }), START - MINUTE);
  await run(h, collector, 26 * HOUR, 10 * MINUTE);
  h.append(h.line("postToolUse", tool("Read", "second"), { at: h.clock.now - MINUTE }));
  await run(h, collector, 26 * HOUR, 10 * MINUTE);
  const of = (id: string) => h.requests.find(request => framed(request.body)[0]!.payload.tool_use_id === id)!;
  const first = of("first"), second = of("second");
  assert.equal(h.quarantined().length, 2);
  const since = (from: number) => h.requests.slice(from).map(request => [request.key, request.body]);

  // Still refused: each one is tried once and goes straight back, without another day at the head of the queue.
  h.clock.now += SECOND;
  assert.deepEqual(await requestCursorRetryRejected(h.stateDir, h.clock.now), { envelopes: 2 });
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
  let from = h.requests.length;
  let health = await run(h, collector, MINUTE);
  assert.deepEqual(since(from), [[first.key, first.body], [second.key, second.body]]);
  assert.deepEqual([health.rejectedEnvelopes, health.recordsRejected, health.recordsLost, health.status], [2, 2, 0, "idle"]);
  assert.equal(fs.existsSync(marker), false, "the request is finished");

  // The service is fixed. Asked again, both are delivered ahead of a record that was only just captured.
  accept = true;
  h.clock.now += SECOND;
  h.append(h.line("postToolUse", tool("Read", "third")));
  await requestCursorRetryRejected(h.stateDir, h.clock.now);
  from = h.requests.length;
  health = await run(h, collector, MINUTE);
  assert.deepEqual(since(from).slice(0, 2), [[first.key, first.body], [second.key, second.body]]);
  assert.deepEqual(h.sent(from + 2).map(row => row.payload.tool_use_id), ["third"]);
  assert.equal(h.requests.length, from + 3);
  assert.deepEqual(h.quarantined(), []);
  assert.deepEqual([health.rejectedEnvelopes, health.rejectedBytes, health.recordsAcknowledged, health.recordsRejected, health.status], [0, 0, 3, 2, "idle"]);
  assert.equal(fs.existsSync(marker), false);

  // An envelope in flight is tried again at once instead of waiting out its schedule.
  accept = false;
  h.append(h.line("postToolUse", tool("Read", "fourth")));
  await run(h, collector, 2 * MINUTE);
  from = h.requests.length;
  assert.ok(collector.snapshot().nextAttemptAt! - h.clock.now > 3 * MINUTE);
  accept = true;
  await requestCursorRetryRejected(h.stateDir, h.clock.now);
  health = await run(h, collector, 4 * SECOND);
  assert.deepEqual([h.requests.length, health.recordsAcknowledged, health.status], [from + 1, 4, "idle"]);
  assert.equal(h.requests.at(-1)!.key, h.requests[from - 1]!.key);
  assert.equal(fs.existsSync(marker), false);

  // With nothing quarantined the request is simply cleared, and so is one that cannot be read.
  assert.deepEqual(await requestCursorRetryRejected(h.stateDir, h.clock.now), { envelopes: 0 });
  await run(h, collector, 2 * SECOND);
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(marker, "not a request");
  await run(h, collector, 2 * SECOND);
  assert.equal(fs.existsSync(marker), false);
  // Returned envelopes and an expedited one are requests like any other.
  assertRequestGap(h);
});

test("an envelope returned from quarantine survives a restart with its key and is answered once", async t => {
  const h = harness(t), limits = { lingerRecords: 1 };
  h.service.answer = () => INVALID;
  let collector = await h.start({ limits });
  h.append(h.line("postToolUse", tool("Read", "only"), { at: START - MINUTE }), START - MINUTE);
  await run(h, collector, 26 * HOUR, 10 * MINUTE);
  const original = h.requests[0]!;
  // Setting it aside was the last commit, under the very key it is returned with.
  assert.equal(h.checkpoint().lastEnvelope, original.key);
  h.service.answer = () => SERVER_ERROR;
  h.clock.now += SECOND;
  await requestCursorRetryRejected(h.stateDir, h.clock.now);
  await collector.tick();
  assert.deepEqual([h.pending()!.id, h.pending()!.requeued, h.pending()!.attempts, h.quarantined()], [original.key, original.key, 1, []]);
  await collector.close();
  collector = await h.start({ limits });
  assert.equal(h.pending()!.id, original.key, "in flight, not taken for answered");
  let saved: Buffer | null = null;
  h.service.answer = () => {
    saved = fs.readFileSync(h.files.pending);
    return OK;
  };
  const from = h.requests.length;
  await run(h, collector, MINUTE);
  assert.deepEqual(h.requests.slice(from).map(request => [request.key, request.body]), [[original.key, original.body]]);
  assert.deepEqual([collector.snapshot().recordsAcknowledged, collector.snapshot().recordsRejected, collector.snapshot().rejectedEnvelopes], [1, 1, 0]);
  // A crash after that answer was committed: the leftover pending file is dropped, not sent again.
  await collector.close();
  fs.writeFileSync(h.files.pending, saved!);
  collector = await h.start({ limits });
  assert.equal(h.pending(), null);
  await run(h, collector, MINUTE);
  assert.equal(h.requests.length, from + 1);
  assert.equal(collector.snapshot().recordsAcknowledged, 1);
});

test("a quarantined envelope older than six days, or framed for another destination, is returned under a new key", async t => {
  const h = harness(t), limits = { lingerRecords: 1 };
  h.service.answer = () => INVALID;
  let collector = await h.start({ limits });
  h.append(h.line("postToolUse", tool("Read", "old"), { at: START - MINUTE }), START - MINUTE);
  await run(h, collector, 26 * HOUR, 10 * MINUTE);
  const old = h.requests[0]!;
  h.clock.now = START + 7 * DAY;
  h.append(h.line("postToolUse", tool("Read", "recent"), { at: h.clock.now - MINUTE }));
  await run(h, collector, 26 * HOUR, 10 * MINUTE);
  const recent = h.requests.at(-1)!;
  assert.deepEqual(h.quarantined().sort(), [`${old.key}.json`, `${recent.key}.json`].sort());
  const oldFile = path.join(h.files.rejected, `${old.key}.json`), copy = fs.readFileSync(oldFile);
  h.service.answer = () => SERVER_ERROR;
  h.clock.now += SECOND;
  await requestCursorRetryRejected(h.stateDir, h.clock.now);
  await collector.tick();
  assert.deepEqual([h.pending()!.requeued, h.pending()!.body, h.pending()!.advance], [old.key, old.body, undefined]);
  assert.notEqual(h.requests.at(-1)!.key, old.key, "past six days the service may have forgotten the key");
  assert.equal(fs.existsSync(oldFile), false);
  await collector.close();
  // A crash after pending.json was written and before the quarantined file was removed: it is not returned twice.
  fs.writeFileSync(oldFile, copy);
  h.service.answer = () => OK;
  const from = h.requests.length;
  collector = await h.start({ destinationHash: cursorDestinationHash({ key: "cot_anothersynthetickey0000000000", ingestEndpoint: ENDPOINT }), limits });
  assert.equal(fs.existsSync(oldFile), false);
  await run(h, collector, MINUTE);
  assert.deepEqual(h.requests.slice(from).map(request => request.body), [old.body, recent.body]);
  assert.notEqual(h.requests.at(-1)!.key, recent.key, "another destination never saw the key");
  assert.equal(new Set(h.requests.map(request => request.key)).size, 5);
  assert.deepEqual(h.quarantined(), []);
  assert.deepEqual([collector.snapshot().recordsAcknowledged, collector.snapshot().recordsRejected], [2, 2]);
  assertRequestGap(h);
});

test("after six days without an answer the records are framed again from the spool under a new key", async t => {
  const h = harness(t), at = START - MINUTE;
  h.service.answer = () => UNSUPPORTED;
  h.append([h.line("beforeSubmitPrompt", prompt(), { at }), h.line("stop", stop(), { at })], at);
  const collector = await h.start();
  await collector.tick();
  await run(h, collector, 6 * DAY - HOUR, 15 * MINUTE);
  const first = h.requests[0]!;
  assert.ok(h.requests.every(request => request.key === first.key && request.body === first.body));
  assert.equal(collector.snapshot().envelopesReframed, 0);
  let health = await run(h, collector, 2 * HOUR, 15 * MINUTE);
  const second = h.requests.at(-1)!;
  assert.notEqual(second.key, first.key);
  assert.equal(second.body, first.body, "the same records frame to the same bytes");
  assert.equal(h.pending()!.createdAt >= START + 6 * DAY, true);
  assert.deepEqual([health.envelopesReframed, health.recordsExpired, health.status], [1, 0, "retrying"]);
  // Past fourteen days they are no longer sent at all: the next framing drops them and says so.
  h.clock.now = START + 15 * DAY;
  health = await collector.tick();
  assert.deepEqual([health.recordsExpired, health.recordsAcknowledged, health.envelopesReframed, health.status, h.requests.at(-1)!.key, h.pending()],
    [2, 0, 2, "idle", second.key, null]);
});

test("turning capture off discards the envelope in flight, reduces spooled records and deletes quarantined ones", async t => {
  const h = harness(t), at = START - MINUTE;
  const lines = [
    h.line("beforeSubmitPrompt", prompt(TURN, { prompt: "CANARY_PROMPT rename the helper", workspace_root: "/srv/fixture/CANARY_ROOT", user_email: "canary.dev@example.test" }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Shell", "shell-1", { tool_input: { command: "npm test -- CANARY_COMMAND", cwd: "/srv/fixture/CANARY_ROOT", timeout: 30000 },
      workspace_root: "/srv/fixture/CANARY_ROOT", user_email: "canary.dev@example.test" }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Task", "task-1", { tool_input: { subagent_type: "explore", run_in_background: false, model: "fast", description: "CANARY_DESCRIPTION list callers" } }), { at, p: EVERYTHING }),
    h.line("postToolUseFailure", tool("Read", "read-1", { result: undefined, failure_type: "error", tool_input: { file_path: "/srv/fixture/CANARY_ROOT/a.ts" } }), { at, p: EVERYTHING }),
    h.line("stop", stop(TURN, { workspace_root: "/srv/fixture/CANARY_ROOT", user_email: "canary.dev@example.test" }), { at, p: EVERYTHING }),
  ];
  h.service.answer = () => INVALID;
  let collector = await h.start({ policy: EVERYTHING, limits: { lingerRecords: 1 } });
  h.append(lines.slice(0, 1), at);
  await run(h, collector, 26 * HOUR, 10 * MINUTE);
  assert.equal(h.quarantined().length, 1);
  assert.match(fs.readFileSync(path.join(h.files.rejected, h.quarantined()[0]!), "utf8"), /CANARY_PROMPT/);
  h.service.answer = () => SERVER_ERROR;
  h.append(lines.slice(1));
  await run(h, collector, MINUTE);
  const captured = h.sent(h.requests.length - 1);
  assert.deepEqual(captured.map(row => Object.keys(row.payload.tool_input ?? {})), [["command", "cwd", "timeout"], ["subagent_type", "run_in_background", "model", "description"], ["file_path"], []]);
  assert.deepEqual(captured.map(row => [row.payload.workspace_root, row.payload.user_email]), [
    ["/srv/fixture/CANARY_ROOT", "canary.dev@example.test"], [undefined, undefined], [undefined, undefined], ["/srv/fixture/CANARY_ROOT", "canary.dev@example.test"]]);
  assert.match(fs.readFileSync(h.files.pending, "utf8"), /CANARY_COMMAND/);
  const inFlight = h.requests.at(-1)!;
  await collector.close();

  // Prompts off, the rest still on: only what the prompts option adds is removed.
  collector = await h.start({ policy: { prompts: false, toolDetails: true, email: true }, limits: { lingerRecords: 1 } });
  assert.equal(h.pending(), null, "the framing under the old options is gone");
  assert.deepEqual(h.quarantined(), [], "and so is the quarantined envelope that held prompt text");
  assert.deepEqual([collector.snapshot().recordsLost, collector.snapshot().envelopesReframed], [1, 1]);
  await run(h, collector, MINUTE);
  let reduced = h.sent(h.requests.length - 1);
  assert.notEqual(h.requests.at(-1)!.key, inFlight.key);
  assert.deepEqual(reduced.map(row => Object.keys(row.payload.tool_input ?? {})), [["command", "cwd", "timeout"], ["subagent_type", "run_in_background", "model"], ["file_path"], []]);
  assert.doesNotMatch(h.requests.at(-1)!.body, /CANARY_DESCRIPTION|CANARY_PROMPT/);
  assert.match(h.requests.at(-1)!.body, /CANARY_COMMAND/);
  await collector.close();

  // Everything off: prompt, tool input, workspace root and email all go; the metadata stays.
  h.service.answer = () => OK;
  collector = await h.start({ policy: METADATA, limits: { lingerRecords: 1 } });
  assert.equal(h.pending(), null);
  await run(h, collector, MINUTE);
  reduced = h.sent(h.requests.length - 1);
  assert.doesNotMatch(h.requests.at(-1)!.body, /CANARY|example[.]test/);
  for (const row of reduced) for (const key of ["prompt", "tool_input", "workspace_root", "user_email"]) assert.equal(key in row.payload, false, `${row.hook} ${key}`);
  assert.deepEqual(reduced.map(row => [row.hook, row.payload.tool_name, row.payload.tool_input_size_bytes, row.payload.failure_type, row.payload.status]), [
    ["postToolUse", "Shell", 40, undefined, undefined], ["postToolUse", "Task", 40, undefined, undefined],
    ["postToolUseFailure", "Read", 40, "error", undefined], ["stop", undefined, undefined, undefined, "completed"]]);
  assert.equal(collector.snapshot().envelopesReframed, 2);
  // A restart that discards the envelope in flight still owes the gap after its last request.
  assertRequestGap(h);
});

test("an option adds a field only when it was on for the line and is on now; arguments holding a credential are withheld whole", async t => {
  const h = harness(t, { policy: EVERYTHING }), at = START - MINUTE;
  const secret = "token=CANARYSECRETVALUE0123456789";
  h.append([
    // Written while every option was off, yet the payload holds opted-in fields: a line no hook of ours writes.
    h.line("beforeSubmitPrompt", prompt(TURN, { prompt: "CANARY_A", workspace_root: "/srv/CANARY_A", user_email: "canary.a@example.test" }), { at }),
    h.line("postToolUse", tool("Shell", "s-1", { tool_input: { command: "echo CANARY_A" } }), { at }),
    h.line("beforeSubmitPrompt", prompt(TURN, { prompt: "kept prompt", workspace_root: "/srv/kept", user_email: "kept.dev@example.test" }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Shell", "s-2", { tool_input: { command: `curl -H ${secret}`, cwd: "/srv/kept" } }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Shell", "s-3", { workspace_root: `/srv/${secret}`, tool_input: { command: "x".repeat(1100) } }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Edit", "s-4", { tool_input: { file_path: "/srv/kept/a.ts" } }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Grep", "s-5", { tool_input: { pattern: "kept", glob: 7, head_limit: 20, file_path: "/srv/kept" } }), { at, p: EVERYTHING }),
    h.line("postToolUse", tool("Task", "s-6", { tool_input: { description: "kept description", prompt: "CANARY_TASK_PROMPT" } }), { at, p: { prompts: true, toolDetails: true } }),
    h.line("beforeSubmitPrompt", prompt(TURN, { prompt: "x".repeat(16_385), user_email: "not an email" }), { at, p: EVERYTHING }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const rows = h.sent(0);
  assert.doesNotMatch(h.requests[0]!.body, /CANARY/);
  assert.deepEqual(rows.map(row => [row.payload.prompt, row.payload.workspace_root, row.payload.user_email, row.payload.tool_input]), [
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, undefined],
    ["kept prompt", "/srv/kept", "kept.dev@example.test", undefined],
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, { pattern: "kept", file_path: "/srv/kept" }],
    [undefined, undefined, undefined, { description: "kept description" }],
    [undefined, undefined, undefined, undefined],
  ]);
});

test("only allow-listed fields of the expected type and size are uploaded, whatever the spool line holds", async t => {
  const h = harness(t), at = START - MINUTE;
  h.append([
    h.line("stop", { generation_id: TURN, model: "m".repeat(129), model_id: 7, cursor_version: "v".repeat(65), composer_mode: "", status: "s".repeat(65),
      loop_count: "0", input_tokens: "31744", output_tokens: 512, cache_read_tokens: "x".repeat(33), cache_write_tokens: null, cost_usd: 1.5, text: "CANARY" }, { at }),
    h.line("postToolUse", { generation_id: TURN, tool_name: "Shell", tool_use_id: "u".repeat(513), duration: "fast", tool_input_size_bytes: 1.5,
      result: { exit_code: 0.5, output_bytes: 3, content_length: "9", success: "yes", agent_id: "a".repeat(257), output: "CANARY" }, tool_output: "CANARY" }, { at }),
    h.line("postToolUse", { tool_name: "Read", tool_use_id: "r-1", result: "CANARY" }, { at }),
    h.line("postToolUseFailure", { tool_name: "Read", tool_use_id: "r-2", failure_type: "f".repeat(65), is_interrupt: "no", error_bytes: 12, error_message: "CANARY", result: { success: false } }, { at }),
    h.line("beforeSubmitPrompt", { generation_id: TURN, prompt_length: 1e20, attachment_count: 2, attachments: ["CANARY"], prompt: "CANARY" }, { at }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0).map(row => row.payload), [
    { generation_id: TURN, input_tokens: "31744", output_tokens: 512 },
    { generation_id: TURN, tool_name: "Shell", result: { output_bytes: 3 } },
    { tool_name: "Read", tool_use_id: "r-1", result: {} },
    { tool_name: "Read", tool_use_id: "r-2", error_bytes: 12 },
    { generation_id: TURN, attachment_count: 2 },
  ]);
  assert.doesNotMatch(h.requests[0]!.body, /CANARY/);
  // The line parser accepts exactly what the hook writes.
  const line = h.line("stop", stop(), { at });
  assert.deepEqual(parseCursorSpoolLine(Buffer.from(line)), JSON.parse(line));
  assert.equal(parseCursorSpoolLine(Buffer.from(`${line} `.padEnd(CURSOR_HOOK_LIMITS.lineBytes, " "))), null, "a line at the bound cannot have come from the hook");
});

test("a pending file that cannot be trusted is discarded and its records framed again; a newer contract is refused", async t => {
  const h = harness(t), at = START - MINUTE;
  h.service.answer = () => SERVER_ERROR;
  h.append([h.line("beforeSubmitPrompt", prompt(), { at }), h.line("stop", stop(), { at })], at);
  let collector = await h.start();
  await collector.tick();
  await collector.close();
  const original = h.pending()!, first = h.requests[0]!;
  const damaged: Array<[string, string | Record<string, unknown>]> = [
    ["a changed body", { ...original, body: original.body.replace("completed", "tampered!") }],
    ["another destination", { ...original, destinationHash: "b".repeat(64) }],
    ["other capture options", { ...original, policy: EVERYTHING }],
    ["no advance", { ...original, advance: undefined }],
    ["a malformed advance", { ...original, advance: { ...original.advance, offsets: { "../checkpoint.json": 1 } } }],
    ["a count that is not a count", { ...original, attempts: -1 }],
    ["not an object", "[]"],
    ["not JSON", "{\"version\":1,"],
    ["an older contract", { ...original, version: 0 }],
  ];
  let sent = h.requests.length, reframed = 0;
  for (const [name, value] of damaged) {
    fs.writeFileSync(h.files.pending, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    collector = await h.start();
    assert.equal(h.pending(), null, `${name}: removed at start`);
    assert.equal(collector.snapshot().envelopesReframed, ++reframed, name);
    await run(h, collector, 14 * SECOND);
    assert.equal(h.requests.length, sent + 1, `${name}: framed again`);
    assert.notEqual(h.requests.at(-1)!.key, first.key, name);
    assert.equal(h.requests.at(-1)!.body, first.body, name);
    sent = h.requests.length;
    await collector.close();
  }
  for (const [file, value, message] of [
    [h.files.pending, { ...h.pending()!, version: 2 }, /unsupported Cursor pending contract/],
    [h.files.checkpoint, { version: 2, offsets: {}, conversations: [], totals: {} }, /unsupported Cursor checkpoint contract/],
    [h.files.checkpoint, { version: 1, offsets: { "seg-1.jsonl": -1 }, conversations: [], totals: {} }, /invalid Cursor checkpoint/],
    [h.files.checkpoint, { version: 1, offsets: {}, conversations: [{ id: "c", thoughts: "none", sandbox: [] }], totals: {} }, /invalid Cursor checkpoint/],
    [h.files.checkpoint, { version: 1, offsets: {}, conversations: [], totals: { spooled: "many" } }, /invalid Cursor checkpoint/],
  ] as const) {
    const before = fs.readFileSync(file);
    fs.writeFileSync(file, JSON.stringify(value));
    await assert.rejects(h.start(), message);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), value, "refused state is left exactly as it was found");
    fs.writeFileSync(file, before);
  }
  // The refusals released the state: a collector can still start, and the envelope in flight is intact.
  h.service.answer = () => OK;
  collector = await h.start();
  await run(h, collector, 20 * SECOND);
  assert.equal(h.requests.length, sent + 1);
  assert.equal(collector.snapshot().recordsAcknowledged, 2);
});

test("one collector owns a state directory; stray files and crash leftovers do not stop it", async t => {
  const h = harness(t);
  fs.mkdirSync(h.files.rejected, { recursive: true });
  for (const name of ["checkpoint.json.tmp", "pending.json.tmp", "health.json.tmp", "retry-rejected.tmp", ".DS_Store", "notes.txt"]) fs.writeFileSync(path.join(h.stateDir, name), "{}");
  fs.writeFileSync(path.join(h.files.rejected, "11111111-2222-4333-8444-555555555555.json.tmp"), "{");
  fs.writeFileSync(path.join(h.files.rejected, "11111111-2222-4333-8444-555555555555.json"), "{\"version\":1}");
  fs.writeFileSync(path.join(h.files.rejected, "README"), "kept");
  fs.writeFileSync(h.files.dropped, "...");
  const collector = await h.start();
  await assert.rejects(h.start(), /Cursor collector is already running/);
  await assert.rejects(collector.open(), /already open/);
  assert.deepEqual(fs.readdirSync(h.stateDir).sort(), [".DS_Store", "collector.lock", "dropped", "notes.txt", "rejected", "spool"]);
  assert.deepEqual(fs.readdirSync(h.files.rejected), ["README"], "an unreadable envelope and a crash leftover are removed");
  const health = await collector.tick();
  assert.deepEqual([health.hookDrops, health.status, health.requests], [3, "idle", 0]);
  await collector.close();
  await assert.rejects(collector.tick(), /not open/);
  assert.equal(fs.existsSync(h.files.lock), false);
  assert.equal(fs.statSync(h.stateDir).mode & 0o777, 0o700);
  // A lease from before the machine restarted is stale although its pid is alive
  // again; without a boot to compare, the pid alone decides.
  const boot = "11111111-2222-4333-8444-555555555555";
  for (const [lease, opens] of [[{ boot: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, true], [{ boot }, false], [{}, false]] as const) {
    fs.writeFileSync(h.files.lock, JSON.stringify({ version: 1, pid: process.pid, token: "left-behind", ...lease }), { mode: 0o600 });
    if (opens) {
      const restarted = await h.start({ bootId: boot });
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(h.files.lock, "utf8"))), ["version", "pid", "token", "boot"]);
      await restarted.close();
    } else {
      await assert.rejects(h.start({ bootId: boot }), /Cursor collector is already running/);
      fs.rmSync(h.files.lock);
    }
  }
  // A spool that is a link is refused before anything is read through it.
  fs.rmSync(h.files.spool, { recursive: true });
  fs.symlinkSync(h.root, h.files.spool);
  await assert.rejects(h.start(), /must not be a symlink/);
  assert.equal(fs.existsSync(h.files.lock), false);
  assert.throws(() => new CursorCollector({ stateDir: "relative", destinationHash: DESTINATION, policy: METADATA, post: h.post }), /absolute/);
  assert.throws(() => new CursorCollector({ stateDir: h.stateDir, destinationHash: "short", policy: METADATA, post: h.post }), /fingerprint/);
  assert.throws(() => new CursorCollector({ stateDir: h.stateDir, destinationHash: DESTINATION, policy: { prompts: true } as CursorPolicy, post: h.post }), /capture options/);
});

test("the request gap survives a restart, and a clock set back cannot strand a schedule", async t => {
  const h = harness(t);
  let collector = await h.start();
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), START - MINUTE);
  await collector.tick();
  assert.equal(h.requests.length, 1);
  await collector.close();
  // A service that restarts at once does not get a second request inside the gap.
  collector = await h.start();
  h.append(h.line("stop", stop(), { at: START - MINUTE }), START - MINUTE);
  await run(h, collector, 14 * SECOND);
  assert.equal(h.requests.length, 1);
  await run(h, collector, 2 * SECOND);
  assert.equal(h.requests.length, 2);
  // An envelope in flight that can no longer be read still holds the gap: its
  // file was written when its request started.
  h.service.answer = () => SERVER_ERROR;
  h.append(h.line("stop", stop(NEXT_TURN, { loop_count: 1 }), { at: h.clock.now - MINUTE }));
  await run(h, collector, 30 * SECOND);
  assert.equal(h.requests.length, 3);
  await collector.close();
  fs.writeFileSync(h.files.pending, "{\"version\":1,");
  fs.utimesSync(h.files.pending, h.clock.now / 1000, h.clock.now / 1000);
  collector = await h.start();
  assert.equal(h.pending(), null);
  await run(h, collector, 14 * SECOND);
  assert.equal(h.requests.length, 3);
  h.service.answer = () => OK;
  await run(h, collector, 4 * SECOND);
  assert.equal(h.requests.length, 4);
  // The clock goes back an hour while an envelope waits for its next attempt.
  h.service.answer = () => UNSUPPORTED;
  h.append(h.line("stop", stop(NEXT_TURN), { at: h.clock.now - MINUTE }));
  await run(h, collector, 30 * SECOND);
  assert.equal(h.requests.length, 5);
  h.clock.now -= 2 * HOUR;
  const health = await collector.tick();
  assert.ok(health.nextAttemptAt! - h.clock.now <= CURSOR_LIMITS.maxWaitMs);
  await run(h, collector, CURSOR_LIMITS.maxWaitMs, MINUTE);
  assert.equal(h.requests.length, 6);
});

test("the loop makes a pass every tick, a last immediate pass when stopped, and none once it may not proceed", async t => {
  const h = harness(t);
  const collector = await h.start();
  const stopper = new AbortController(), reports: CursorHealth[] = [], sleeps: number[] = [];
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), START - MINUTE);
  const last = await runCursorCollector(collector, {
    signal: stopper.signal,
    report: health => { reports.push(health); },
    sleep: async ms => {
      sleeps.push(ms);
      h.clock.now += 20 * SECOND;
      if (sleeps.length === 2) {
        // Written a moment before the service is stopped: neither settled nor lingered.
        h.append(h.line("stop", stop()));
        stopper.abort();
      }
    },
  });
  assert.deepEqual(sleeps, [CURSOR_LIMITS.tickMs, CURSOR_LIMITS.tickMs]);
  assert.equal(reports.length, 3);
  assert.equal(last, reports[2]);
  assert.deepEqual(h.delivered().map(row => row.hook), ["beforeSubmitPrompt", "stop"]);
  // The settings changed underneath a running collector: it stops without framing under the options it holds.
  h.append(h.line("stop", stop(NEXT_TURN)));
  h.clock.now += MINUTE;
  let asked = 0;
  const halted = await runCursorCollector(collector, { signal: stopper.signal, proceed: () => { asked++; return false; }, report: () => assert.fail("no pass was made") });
  assert.deepEqual([asked, h.requests.length, halted.status], [1, 2, "idle"]);
  // `collect --once`: one immediate pass.
  const once = await runCursorCollector(collector, { once: true, sleep: async () => assert.fail("a single pass does not sleep") });
  assert.deepEqual([h.requests.length, once.recordsAcknowledged], [3, 3]);
});

test("the health file is a fixed set of counters and names, private and bounded", async t => {
  const h = harness(t);
  const collector = await h.start();
  h.append(h.line("beforeSubmitPrompt", prompt(), { at: START - MINUTE }), START - MINUTE);
  const health = await collector.tick();
  assert.equal(await readCursorHealth(h.stateDir), null);
  await writeCursorHealth(h.stateDir, health, { running: true, pid: 4242 });
  assert.equal(fs.statSync(h.files.health).mode & 0o777, 0o600);
  assert.ok(fs.statSync(h.files.health).size < CURSOR_LIMITS.healthBytes / 8);
  assert.deepEqual(await readCursorHealth(h.stateDir), { ...health, running: true, pid: 4242 });
  assert.deepEqual(Object.keys(health).sort(), ["backlogBytes", "envelopesReframed", "hookDrops", "lastAckAt", "lastDetail", "lastErrorClass", "lastOutcome", "lastTickAt",
    "nextAttemptAt", "pendingRecords", "recordsAcknowledged", "recordsExpired", "recordsLost", "recordsMalformed", "recordsRejected", "recordsSpooled", "rejectedBytes",
    "rejectedEnvelopes", "requests", "requestsLastMinute", "spoolBytes", "spoolSegments", "status", "version"]);
  // Whatever else the file holds is not passed on.
  fs.writeFileSync(h.files.health, JSON.stringify({ ...health, status: "<script>", lastOutcome: KEY, lastDetail: 7, requests: -4, recordsLost: "many", pid: "1", running: "yes", note: KEY }));
  const read = (await readCursorHealth(h.stateDir))!;
  assert.deepEqual([read.status, read.lastOutcome, read.lastDetail, read.requests, read.recordsLost, read.pid, read.running], ["idle", null, null, 0, 0, 0, false]);
  assert.doesNotMatch(JSON.stringify(read), /cot_|script|note/);
  for (const content of ["not json", "[]", JSON.stringify({ version: 2 })]) {
    fs.writeFileSync(h.files.health, content);
    assert.equal(await readCursorHealth(h.stateDir), null);
  }
});

test("saved context is rebuilt field by field: a wrong structure is refused and nothing unknown is carried", () => {
  const saved = [{ id: "c-1", prompt: "turn-1", thoughts: [{ generation_id: "turn-1-0", model: "m", prior: true, text: "CANARY" }], sandbox: [["tool-1", true]], used: ["0".repeat(32)], note: "CANARY" }];
  const kept = { id: "c-1", prompt: "turn-1", thoughts: [{ generation_id: "turn-1-0", model: "m", prior: true }], sandbox: [["tool-1", true]], used: ["0".repeat(32)] };
  assert.deepEqual(new CursorContext(saved).snapshot(), [{ ...kept, thoughts: [{ generation_id: "turn-1-0", model: "m", text: "CANARY", prior: true }] }]);
  // Reasoning text and file content are held only while their option is on.
  const held = [{ ...saved[0]!, thoughts: [...saved[0]!.thoughts, { generation_id: "turn-1-1", text: "CANARY only text" }, { generation_id: "turn-1-2", model: "m", text: "CANARY", done: true }],
    reads: [["tool-2", "CANARY file"]] }];
  assert.deepEqual(new CursorContext(held).snapshot()[0]!.reads, [["tool-2", "CANARY file"]]);
  assert.equal(new CursorContext(held).snapshot()[0]!.thoughts.length, 3);
  assert.deepEqual(new CursorContext(held, CURSOR_LIMITS, { prompts: false, toolDetails: false }).snapshot(), [kept]);
  assert.deepEqual(new CursorContext(held, CURSOR_LIMITS, { prompts: true, toolDetails: false }).snapshot()[0]!.reads, undefined);
  assert.doesNotMatch(JSON.stringify(new CursorContext(held, CURSOR_LIMITS, { prompts: false, toolDetails: true }).snapshot()[0]!.thoughts), /CANARY/);
  assert.deepEqual(new CursorContext().snapshot(), []);
  for (const wrong of [
    {}, [null], [{ id: "has space", thoughts: [], sandbox: [] }], [{ id: "c", thoughts: [], sandbox: [] }, { id: "c", thoughts: [], sandbox: [] }],
    [{ id: "c", thoughts: [{}], sandbox: [] }], [{ id: "c", thoughts: [{ model: "m", prior: false }], sandbox: [] }], [{ id: "c", thoughts: [], sandbox: [["tool-1"]] }],
    [{ id: "c", thoughts: [], sandbox: [["tool-1", "yes"]] }], [{ id: "c", thoughts: [], sandbox: [], used: ["not an id"] }], [{ id: "c", prompt: "", thoughts: [], sandbox: [] }],
    [{ id: "c", thoughts: [{ model: "m", done: false }], sandbox: [] }], [{ id: "c", thoughts: [{ text: "x".repeat(2049) }], sandbox: [] }],
    [{ id: "c", thoughts: [], sandbox: [], reads: {} }], [{ id: "c", thoughts: [], sandbox: [], reads: [["tool-1"]] }],
    [{ id: "c", thoughts: [], sandbox: [], reads: [["tool-1", 7]] }], [{ id: "c", thoughts: [], sandbox: [], reads: [["tool-1", "x".repeat(8193)]] }],
  ]) assert.throws(() => new CursorContext(wrong), /invalid Cursor checkpoint context/, JSON.stringify(wrong));
  // A count above today's bound keeps the newest entries instead of failing an upgrade.
  const many = Array.from({ length: 80 }, (_, index) => ({ model: `m-${index}` }));
  assert.deepEqual(new CursorContext([{ id: "c", thoughts: many, sandbox: [] }]).snapshot()[0]!.thoughts, many.slice(-CURSOR_LIMITS.thoughts));
});

test("the numbered segments of a bucket are read in the order they were written and deleted once consumed", async t => {
  const h = harness(t, { limits: { lingerRecords: 1 } }), at = START - 45 * MINUTE, later = START - 30 * MINUTE;
  const base = h.segment(at), numbered = (part: number | string) => base.replace(/[.]jsonl$/, `-${part}.jsonl`);
  const write = (file: string, ids: string[], when = at) =>
    fs.writeFileSync(file, ids.map(id => `${h.line("postToolUse", tool("Read", id), { at: when })}\n`).join(""), { mode: 0o600 });
  // Created out of order, as a directory listing may return them.
  write(numbered(10), ["e"]);
  write(numbered(2), ["c", "d"]);
  write(h.segment(later), ["f"], later);
  write(base, ["a"]);
  write(numbered(1), ["b"]);
  // Names the hook never writes are not segments.
  const foreign = [numbered(0), numbered("01"), numbered(12345), numbered("x")].map(file => path.basename(file));
  for (const name of foreign) write(path.join(h.files.spool, name), ["never"]);
  const collector = await h.start();
  const health = await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual([health.recordsAcknowledged, health.recordsMalformed, health.spoolSegments, health.backlogBytes], [6, 0, 0, 0]);
  assert.deepEqual(fs.readdirSync(h.files.spool).sort(), [...foreign].sort(), "every consumed segment of a closed bucket is deleted, numbered or not");
  assert.deepEqual([h.checkpoint().offsets, h.checkpoint().inodes], [{}, {}]);
  // A checkpoint may name a numbered segment, and nothing else.
  await collector.close();
  const saved = h.checkpoint();
  for (const name of ["seg-5-0.jsonl", "seg-5-01.jsonl", "seg-5-12345.jsonl", "seg-5-1.json"]) {
    fs.writeFileSync(h.files.checkpoint, JSON.stringify({ ...saved, offsets: { [name]: 1 } }));
    await assert.rejects(h.start(), /invalid Cursor checkpoint offsets/, name);
  }
  fs.writeFileSync(h.files.checkpoint, JSON.stringify({ ...saved, offsets: { "seg-5-1.jsonl": 1 }, inodes: { "seg-5-1.jsonl": "not a number" } }));
  await assert.rejects(h.start(), /invalid Cursor checkpoint offsets/);
  fs.writeFileSync(h.files.checkpoint, JSON.stringify({ ...saved, offsets: { "seg-5-9999.jsonl": 1 }, inodes: { "seg-5-9999.jsonl": "7" } }));
  await (await h.start()).tick();
  assert.deepEqual([h.checkpoint().offsets, h.checkpoint().inodes], [{}, {}], "an offset for a segment that is not there is dropped, on disk too");
});

test("segments past the expiry age are counted and deleted while the service holds the queue", async t => {
  const h = harness(t, { limits: { lingerRecords: 1, envelopeRecords: 1 } });
  const oldest = START - 14 * DAY + HOUR, older = oldest + HOUR, fresh = START - MINUTE;
  h.append([h.line("postToolUse", tool("Read", "held-1"), { at: oldest }), h.line("postToolUse", tool("Read", "held-2"), { at: oldest })], oldest);
  h.append([h.line("postToolUse", tool("Read", "old-1"), { at: older }), "", h.line("postToolUse", tool("Read", "old-2"), { at: older })], older);
  h.append(h.line("postToolUse", tool("Read", "fresh"), { at: fresh }), fresh);
  h.service.answer = () => UNSUPPORTED;
  const collector = await h.start();
  let health = await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["held-1"], "the envelope in flight covers the start of the oldest segment");
  assert.equal(health.recordsExpired, 0);
  // Three hours on, both old segments are past fourteen days and the service still refuses.
  health = await run(h, collector, 3 * HOUR, 10 * MINUTE);
  assert.equal(health.status, "retrying");
  assert.equal(health.lastOutcome, "unsupported");
  assert.equal(fs.existsSync(h.segment(older)), false, "a segment no envelope covers is reclaimed without waiting for the service");
  assert.equal(health.recordsExpired, 2, "its records are counted, blank lines are not");
  assert.ok(fs.existsSync(h.segment(oldest)), "the stretch the envelope in flight covers waits for that envelope");
  assert.ok(fs.existsSync(h.segment(fresh)));
  assert.equal(h.pending()!.records, 1);
  assert.deepEqual(h.checkpoint().totals.spooled, 0, "nothing was consumed as read");
  // The envelope gives up after six days; its segment is past the age by then and goes too.
  health = await run(h, collector, 6 * DAY, HOUR);
  assert.equal(health.envelopesReframed, 1);
  assert.equal(fs.existsSync(h.segment(oldest)), false);
  assert.equal(health.recordsExpired, 4);
  h.service.answer = () => OK;
  health = await run(h, collector, HOUR, MINUTE);
  assert.equal(h.delivered().at(-1)!.payload.tool_use_id, "fresh");
  assert.deepEqual([health.recordsAcknowledged, health.recordsExpired, health.spoolSegments, health.status], [1, 4, 0, "idle"]);
  assert.deepEqual(fs.readdirSync(h.files.spool), []);
});

test("a deleted segment's offset is forgotten on disk at once, and another file under its name is read from the start", async t => {
  const h = harness(t, { limits: { lingerRecords: 1 } }), at = START - 45 * MINUTE, name = path.basename(h.segment(at));
  const record = (id: string) => h.line("postToolUse", tool("Read", id), { at });
  h.append([record("a"), record("b")], at);
  let collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["a", "b"]);
  assert.equal(fs.existsSync(h.segment(at)), false);
  assert.deepEqual([h.checkpoint().offsets, h.checkpoint().inodes], [{}, {}], "the removal is in checkpoint.json before the tick ends");
  await collector.close();
  // A hook whose clock is behind the collector's writes the same name again,
  // longer than the file that was deleted.
  h.append([record("c"), record("d"), record("e")], at);
  h.clock.now += MINUTE;
  collector = await h.start();
  let health = await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["a", "b", "c", "d", "e"], "nothing of the new file is skipped");
  assert.equal(health.recordsMalformed, 0, "and it is not entered in the middle of a line");
  await collector.close();

  // A checkpoint a crash left behind still names the old file. The file there
  // now is another one, so its offset does not apply.
  const first = `${record("f")}\n`;
  h.append([first.trimEnd(), record("g")], at);
  const ino = String(fs.statSync(h.segment(at)).ino), saved = h.checkpoint();
  fs.writeFileSync(h.files.checkpoint, JSON.stringify({ ...saved, offsets: { [name]: Buffer.byteLength(first) }, inodes: { [name]: String(Number(ino) + 1) } }));
  h.clock.now += MINUTE;
  collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.delivered().slice(5).map(row => row.payload.tool_use_id), ["f", "g"], "an offset counted in another file is not resumed");
  await collector.close();
  // The same file is resumed where it was left, with or without a recorded file.
  for (const [inodes, label] of [[{ [name]: "" }, "recorded"], [undefined, "not recorded"]] as const) {
    const sent = h.requests.length, line = `${record(`h-${label}`)}\n`;
    h.append([line.trimEnd(), record(`i-${label}`)], at);
    const now = String(fs.statSync(h.segment(at)).ino);
    fs.writeFileSync(h.files.checkpoint, JSON.stringify({ ...h.checkpoint(), offsets: { [name]: Buffer.byteLength(line) }, inodes: inodes && { [name]: now } }));
    h.clock.now += MINUTE;
    collector = await h.start();
    await collector.tick();
    assert.deepEqual(h.requests.slice(sent).flatMap(request => framed(request.body)).map(row => row.payload.tool_use_id), [`i-${label}`], label);
    await collector.close();
  }
  // A file shorter than its offset is another file whatever its number.
  h.append([record("j")], at);
  const short = String(fs.statSync(h.segment(at)).ino);
  fs.writeFileSync(h.files.checkpoint, JSON.stringify({ ...h.checkpoint(), offsets: { [name]: 1_000_000 }, inodes: { [name]: short } }));
  h.clock.now += MINUTE;
  collector = await h.start();
  health = await collector.tick();
  assert.equal(h.delivered().at(-1)!.payload.tool_use_id, "j");
  assert.equal(health.recordsMalformed, 0);
});

test("turning a capture option on keeps the envelope in flight: the same bytes under the same key", async t => {
  const h = harness(t, { limits: { lingerRecords: 1 } }), at = START - MINUTE;
  const narrow: CursorPolicy = { prompts: true, toolDetails: true, email: false };
  h.append(h.line("beforeSubmitPrompt", prompt(TURN, { prompt: "rename the helper", user_email: "fixture.dev@example.test" }), { at, p: EVERYTHING }), at);
  // The service accepted the envelope and the answer was lost on the way back.
  h.service.answer = () => ({ outcome: "network", detail: "timeout", errorClass: "timeout" });
  let collector = await h.start({ policy: narrow });
  await collector.tick();
  assert.equal(h.requests.length, 1);
  await collector.close();
  h.service.answer = () => OK;
  h.clock.now += MINUTE;
  collector = await h.start({ policy: EVERYTHING });
  let health = await collector.tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]!.key, h.requests[0]!.key, "a second key would make the service count the records twice");
  assert.equal(h.requests[1]!.body, h.requests[0]!.body);
  assert.deepEqual([health.envelopesReframed, health.recordsAcknowledged, health.requests], [0, 1, 2]);
  assert.ok(!("user_email" in h.sent(1)[0]!.payload), "the envelope keeps what it was framed with");
  await collector.close();

  // Turning one off, or sending somewhere else, still frames the records again.
  for (const [label, restart] of [["an option turned off", { policy: METADATA }],
    ["another destination", { policy: EVERYTHING, destinationHash: cursorDestinationHash({ key: KEY, ingestEndpoint: "https://other.example.test" }) }]] as const) {
    const sent: number = h.requests.length, moment: number = h.clock.now;
    h.append(h.line("beforeSubmitPrompt", prompt(NEXT_TURN, { prompt: "second" }), { at: moment, p: EVERYTHING }), moment);
    h.service.answer = () => ({ outcome: "network", detail: "timeout", errorClass: "timeout" });
    h.clock.now += MINUTE;
    collector = await h.start({ policy: EVERYTHING });
    await collector.tick();
    assert.equal(h.requests.length, sent + 1, label);
    await collector.close();
    h.service.answer = () => OK;
    h.clock.now += MINUTE;
    collector = await h.start(restart);
    health = await collector.tick();
    assert.equal(h.requests.length, sent + 2, label);
    assert.notEqual(h.requests[sent + 1]!.key, h.requests[sent]!.key, label);
    await collector.close();
    h.clock.now += MINUTE;
  }
  assert.equal(health.envelopesReframed, 2);
});

test("a segment that cannot be looked at keeps its offset; only one that is gone loses it", async t => {
  const h = harness(t, { limits: { lingerRecords: 1 } }), at = START - MINUTE, file = h.segment(at), name = path.basename(file);
  const record = (id: string) => h.line("postToolUse", tool("Read", id), { at });
  h.append(record("a"), at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["a"]);
  const consumed = h.checkpoint().offsets[name];
  assert.equal(consumed, fs.statSync(file).size);
  h.append(record("b"), at);
  // One pass in which the segment cannot be examined (a transient I/O or permission error).
  const lstat = fsPromises.lstat.bind(fsPromises);
  let failing: string | null = "EIO";
  t.mock.method(fsPromises, "lstat", async (target: fs.PathLike, ...rest: any[]) => {
    if (failing && String(target) === file) throw Object.assign(new Error(failing), { code: failing });
    return (lstat as any)(target, ...rest);
  });
  for (const code of ["EIO", "EACCES"]) {
    failing = code;
    h.clock.now += 20 * SECOND;
    await collector.tick();
    assert.equal(h.requests.length, 1, "a segment that was not seen is not read");
    assert.equal(h.checkpoint().offsets[name], consumed);
  }
  failing = null;
  h.clock.now += 20 * SECOND;
  await collector.tick();
  assert.deepEqual(h.delivered().map(row => row.payload.tool_use_id), ["a", "b"], "what was sent is not sent again");
  // Gone is different: the next file under the name starts at its beginning.
  failing = "ENOENT";
  h.clock.now += 20 * SECOND;
  await collector.tick();
  assert.equal(name in h.checkpoint().offsets, false);
});

test("the collector withholds a command the stricter patterns catch, whatever hook wrote the line", async t => {
  // Lines as a hook without these patterns would have spooled them. The value is invented.
  const h = harness(t, { limits: { lingerRecords: 1 } }), at = START - MINUTE, secret = "S3cr3tFixture9Zq";
  const commands = [`export AWS_SECRET_ACCESS_KEY=${secret}`, `psql postgres://admin:${secret}@db.example.test/prod`, `mysql -u root -p${secret} prod`,
    `docker login -u me -p ${secret}`, `curl -u admin:${secret} https://api.example.test`, `curl -H 'X-Auth: ${secret}' https://api.example.test`,
    `redis-cli -a ${secret} ping`, `tool --password ${secret}`, `curl -H 'Authorization: Basic ${secret}' https://api.example.test`];
  h.append([...commands.map((command, index) => h.line("postToolUse", tool("Shell", `s-${index}`, { tool_input: { command, cwd: "/srv/kept" } }), { at, p: EVERYTHING })),
    h.line("postToolUse", tool("Shell", "plain", { tool_input: { command: "mkdir -p out && npm test", cwd: "/srv/kept" } }), { at, p: EVERYTHING }),
    h.line("stop", stop(TURN, { workspace_root: `/srv/db_password=${secret}` }), { at, p: EVERYTHING })], at);
  const collector = await h.start({ policy: EVERYTHING });
  await collector.tick();
  assert.equal(h.requests.length, 1);
  assert.ok(!h.requests[0]!.body.includes(secret), "no form of the secret leaves the machine");
  assert.deepEqual(h.sent(0).map(row => row.payload.tool_input), [...commands.map(() => undefined), { command: "mkdir -p out && npm test", cwd: "/srv/kept" }, undefined]);
  assert.ok(!("workspace_root" in h.sent(0).at(-1)!.payload));
});

// ---- Content: reply and reasoning text, tool output, failure text, file content ----

const CONTENT: CursorPolicy = { prompts: true, toolDetails: true, email: false };
const reply = (turn = TURN, extra: Record<string, unknown> = {}) => ({
  generation_id: turn, model: "default", cursor_version: CURSOR_VERSION,
  input_tokens: 31744, output_tokens: 512, cache_read_tokens: 30720, cache_write_tokens: 0, ...extra,
});
const fileRead = (id: string, content: unknown) => ({ tool_use_id: id, content });
const PAIR = String.fromCodePoint(0x1f600);
/** The `cursor.source.record` strings of one request body, as sent. */
const sourceRecords = (body: string): string[] => JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords
  .map((row: any) => row.attributes.find((attribute: any) => attribute.key === "cursor.source.record").value.stringValue);
const savedContext = (h: Harness): Array<Record<string, any>> => h.checkpoint().conversations;

test("a reply carries its text and the reasoning of its own turn: by turn key, one entry per distinct text, in capture order", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  h.append([
    h.line("beforeSubmitPrompt", prompt(), { at, p }),
    // Cursor fires a thought twice: once with the resolved model and a suffixed id, once as "default".
    h.line("afterAgentThought", thought(`${TURN}-0-ab12`, "synthetic-model-high", { text: "first thought" }), { at: at + 1, p }),
    h.line("afterAgentThought", thought(TURN, "default", { text: "first thought" }), { at: at + 2, p }),
    h.line("afterAgentThought", thought(`${NEXT_TURN}-0-cd34`, "synthetic-other", { text: "a thought of another turn" }), { at: at + 3, p }),
    h.line("afterAgentThought", thought(`${TURN}-1-ef56`, "synthetic-model-high", { text: "second thought" }), { at: at + 4, p }),
    h.line("afterAgentThought", thought(TURN, "default", { text: "second thought" }), { at: at + 5, p }),
    h.line("afterAgentThought", thought(`${TURN}-2-ab78`, "synthetic-model-high"), { at: at + 6, p }),
    h.line("afterAgentThought", thought(`${TURN}-3-ab90`, "synthetic-model-high", { text: "first thought" }), { at: at + 7, p }),
    h.line("stop", stop(), { at: at + 8, p }),
    h.line("afterAgentResponse", reply(TURN, { text: "the reply of the turn", status: "CANARY", prompt: "CANARY", note: "CANARY" }), { at: at + 9, p }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const rows = h.sent(0);
  assert.deepEqual(rows.map(row => row.hook), ["beforeSubmitPrompt", "stop", "afterAgentResponse"]);
  assert.deepEqual(rows[1]!.context, { models: [{ model: "default" }, { model: "synthetic-model-high" }] }, "the stop still takes its models from the same thoughts");
  assert.deepEqual(rows[2]!.payload, reply(TURN, { text: "the reply of the turn" }), "the reply text, the four counters and the common keys; nothing else");
  assert.deepEqual(rows[2]!.context, { thoughts: [{ text: "first thought" }, { text: "second thought" }] });
  assert.doesNotMatch(h.requests[0]!.body, /CANARY|another turn/);
  // The other turn's thought waits for its own reply and stop, and nothing else is left.
  assert.deepEqual(savedContext(h).map(conversation => conversation.thoughts.map((item: any) => [item.generation_id, item.text])),
    [[[`${NEXT_TURN}-0-cd34`, "a thought of another turn"]]]);

  // The reply first, then the stop: each still gets its part.
  h.clock.now += MINUTE;
  h.append([
    h.line("afterAgentResponse", reply(NEXT_TURN, { text: "the next reply" }), { at: h.clock.now - 30 * SECOND, p }),
    h.line("stop", stop(NEXT_TURN), { at: h.clock.now - 30 * SECOND + 1, p }),
  ]);
  await collector.tick();
  assert.deepEqual(h.sent(1).map(row => [row.hook, row.context]), [
    ["afterAgentResponse", { thoughts: [{ text: "a thought of another turn" }] }],
    ["stop", { models: [{ model: "synthetic-other" }] }],
  ]);
  assert.deepEqual(savedContext(h), [{ id: CONVERSATION, prompt: TURN, thoughts: [], sandbox: [] }]);
});

test("a thought that reaches the spool after its reply is still attached, gives the stop its model, and is not kept afterwards", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  h.append([
    h.line("afterAgentResponse", reply(TURN, { text: "the reply" }), { at, p }),
    h.line("afterAgentThought", thought(`${TURN}-0-ab12`, "synthetic-model-high", { text: "a late thought" }), { at: at + 1, p }),
    h.line("stop", stop(), { at: at + 2, p }),
    // And the other way round: the stop first, the thought after it, the reply last.
    h.line("stop", stop(NEXT_TURN), { at: at + 3, p }),
    h.line("afterAgentThought", thought(`${NEXT_TURN}-0-cd34`, "synthetic-other", { text: "another late thought" }), { at: at + 4, p }),
    h.line("afterAgentResponse", reply(NEXT_TURN), { at: at + 5, p }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0).map(row => [row.hook, row.payload.generation_id, row.context]), [
    ["afterAgentResponse", TURN, { thoughts: [{ text: "a late thought" }] }],
    ["stop", TURN, { models: [{ model: "synthetic-model-high" }] }],
    ["stop", NEXT_TURN, { models: [{ model: "synthetic-other" }] }],
    ["afterAgentResponse", NEXT_TURN, { thoughts: [{ text: "another late thought" }] }],
  ]);
  assert.ok(!("text" in h.sent(0)[3]!.payload), "a reply may carry reasoning alone");
  assert.deepEqual(savedContext(h), []);
});

test("a reply keeps the newest thirty-two thoughts, each inside its cut, and a turn with thoughts and no reply sends none", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  h.append([
    ...Array.from({ length: 40 }, (_, index) => h.line("afterAgentThought", thought(`${TURN}-${index}-x`, "synthetic-model", { text: `thought ${index}` }), { at: at + index, p })),
    // Text over the cut was not written by the hook; it is not sent.
    h.line("afterAgentThought", thought(`${TURN}-40-x`, "synthetic-model", { text: "x".repeat(CURSOR_HOOK_LIMITS.thoughtChars + 1) }), { at: at + 40, p }),
    h.line("afterAgentThought", thought(`${TURN}-41-x`, "synthetic-model", { text: "y".repeat(CURSOR_HOOK_LIMITS.thoughtChars) }), { at: at + 41, p }),
    h.line("afterAgentResponse", reply(TURN, { text: "r".repeat(CURSOR_HOOK_LIMITS.replyChars) }), { at: at + 42, p }),
    h.line("afterAgentResponse", reply(NEXT_TURN, { text: "r".repeat(CURSOR_HOOK_LIMITS.replyChars + 1) }), { at: at + 43, p }),
    // A turn whose thoughts have no reply: the stop is sent with its models and no reasoning.
    h.line("afterAgentThought", thought("turn-without-reply-0", "synthetic-model", { text: "never sent" }), { at: at + 44, p }),
    h.line("stop", stop("turn-without-reply"), { at: at + 45, p }),
  ], at);
  const collector = await h.start();
  const health = await collector.tick();
  const rows = h.sent(0);
  assert.deepEqual(rows.map(row => [row.hook, row.payload.generation_id]), [["afterAgentResponse", TURN], ["stop", "turn-without-reply"]]);
  assert.deepEqual(rows[0]!.context.thoughts.map((item: any) => item.text),
    [...Array.from({ length: 31 }, (_, index) => `thought ${index + 9}`), "y".repeat(CURSOR_HOOK_LIMITS.thoughtChars)]);
  assert.equal(rows[0]!.payload.text.length, CURSOR_HOOK_LIMITS.replyChars);
  assert.deepEqual(Object.keys(rows[1]!.context), ["models"]);
  assert.doesNotMatch(h.requests[0]!.body, /never sent/);
  // The reply whose text was over its cut had nothing left to carry.
  assert.deepEqual([health.recordsSpooled, health.recordsAcknowledged, health.recordsMalformed], [46, 2, 0]);
});

test("a reply left with neither text nor reasoning is not uploaded", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  h.append([h.line("afterAgentResponse", reply(), { at, p }), h.line("afterAgentResponse", reply(NEXT_TURN, { text: "" }), { at, p })], at);
  const collector = await h.start();
  let health = await collector.tick();
  assert.equal(h.requests.length, 0, "nothing to send, so no request");
  assert.deepEqual([health.recordsSpooled, health.recordsMalformed, health.recordsAcknowledged, health.backlogBytes, health.status], [2, 0, 0, 0, "idle"]);
  // Beside records that are sent, it is consumed and left out.
  h.clock.now += MINUTE;
  const now = h.clock.now - 30 * SECOND;
  h.append([
    h.line("stop", stop(), { at: now, p }),
    h.line("afterAgentResponse", reply(), { at: now, p }),
    h.line("afterAgentResponse", reply("a-turn-with-text", { text: "text alone" }), { at: now, p }),
    // The text was captured while the option was off for the line.
    h.line("afterAgentResponse", reply("a-turn-captured-without-the-option", { text: "CANARY" }), { at: now, p: { toolDetails: true } }),
  ]);
  health = await collector.tick();
  assert.deepEqual(h.sent(0).map(row => [row.hook, row.payload.generation_id, row.payload.text, row.context]),
    [["stop", TURN, undefined, {}], ["afterAgentResponse", "a-turn-with-text", "text alone", {}]]);
  assert.deepEqual([health.recordsSpooled, health.recordsMalformed, health.recordsAcknowledged], [6, 0, 2]);
  assert.doesNotMatch(h.requests[0]!.body, /CANARY/);
});

test("the content a file read returned goes on the Read record of the same call, whichever was written first, and is then forgotten", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  const first = "call-aaaa-0\nfc_bbbb_0", second = "call-aaaa-1\nfc_bbbb_1", reused = "call-aaaa-2\nfc_bbbb_2";
  h.append([
    h.line("beforeReadFile", { ...fileRead(first, "content read first\n"), file_path: "/srv/fixture/CANARY.ts" }, { at, p }),
    h.line("postToolUse", tool("Read", first), { at: at + 5, p }),
    // The tool record reached the spool before the read did.
    h.line("postToolUse", tool("Read", second), { at: at + 10, p }),
    h.line("beforeReadFile", fileRead(second, "content read second\n"), { at: at + 11, p }),
    // Cursor reuses one raw id across calls of different tools: only the Read takes the content.
    h.line("beforeReadFile", fileRead(reused, "content of the reused id\n"), { at: at + 20, p }),
    h.line("postToolUse", tool("Write", reused), { at: at + 21, p }),
    h.line("postToolUseFailure", tool("Read", reused, { failure_type: "error" }), { at: at + 22, p }),
    h.line("postToolUse", tool("Read", reused), { at: at + 23, p }),
    h.line("postToolUse", tool("Read", reused), { at: at + 24, p }),
    // No read for this call, and a read whose call never arrives.
    h.line("postToolUse", tool("Read", "call-without-a-read"), { at: at + 30, p }),
    h.line("beforeReadFile", fileRead("read-without-a-call", "kept until its call or its turn to go\n"), { at: at + 31, p }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  assert.deepEqual(h.sent(0).map(row => [row.payload.tool_name, row.payload.tool_use_id, row.context]), [
    ["Read", first, { read: { content: "content read first\n" } }],
    ["Read", second, { read: { content: "content read second\n" } }],
    ["Write", reused, {}],
    ["Read", reused, {}],
    ["Read", reused, { read: { content: "content of the reused id\n" } }],
    ["Read", reused, {}],
    ["Read", "call-without-a-read", {}],
  ]);
  assert.doesNotMatch(h.requests[0]!.body, /CANARY/, "the path of a read is not sent with its content");
  assert.deepEqual(savedContext(h), [{ id: CONVERSATION, thoughts: [], sandbox: [], reads: [["read-without-a-call", "kept until its call or its turn to go\n"]] }]);

  // A shell call's sandbox flag and a read's content sit side by side on a Read record that has both.
  h.clock.now += MINUTE;
  const now = h.clock.now - 30 * SECOND;
  h.append([
    h.line("afterShellExecution", shell("both", true), { at: now, p }),
    h.line("beforeReadFile", fileRead("both", "both\n"), { at: now, p }),
    h.line("postToolUse", tool("Read", "both"), { at: now + 1, p }),
    ...Array.from({ length: 12 }, (_, index) => h.line("beforeReadFile", fileRead(`unclaimed-${index}`, `content ${index}`), { at: now + 2, p })),
  ]);
  await collector.tick();
  assert.deepEqual(h.sent(1).map(row => row.context), [{ shell: { sandbox: true }, read: { content: "both\n" } }]);
  assert.deepEqual(savedContext(h)[0]!.reads.map((item: [string, string]) => item[0]), Array.from({ length: 8 }, (_, index) => `unclaimed-${index + 4}`), "the newest eight wait");
});

test("tool output, failure text and written content are sent under the tool-details option, each inside its cut", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  const max = CURSOR_HOOK_LIMITS.contentChars, input = { file_path: "/srv/fixture/repo-alpha/a.ts" };
  h.append([
    h.line("postToolUse", tool("Shell", "s-1", { output: "2 passing\n", result: { exit_code: 0, output_bytes: 10 }, tool_input: { command: "npm test" } }), { at, p }),
    h.line("postToolUseFailure", tool("Shell", "s-2", { failure_type: "error", error_bytes: 16, error_message: "command exited 1", output: "CANARY not a failure key" }), { at, p }),
    h.line("postToolUse", tool("Write", "w-1", { tool_input: input, content: "export const a = 1;\n", error_message: "CANARY not a success key" }), { at, p }),
    // Written content goes only with the arguments it belongs to, and only on a Write.
    h.line("postToolUse", tool("Write", "w-2", { content: "CANARY no arguments" }), { at, p }),
    h.line("postToolUse", tool("Write", "w-3", { tool_input: { file_path: "/srv/fixture/password=hunter2-dir/a.ts" }, content: "CANARY withheld arguments" }), { at, p }),
    h.line("postToolUse", tool("Read", "r-1", { tool_input: input, content: "CANARY not a Read key" }), { at, p }),
    // A value at its cut is sent whole; one over it was not written by the hook and is not sent.
    h.line("postToolUse", tool("Grep", "g-1", { output: "o".repeat(max) }), { at, p }),
    h.line("postToolUse", tool("Grep", "g-2", { output: "o".repeat(max + 1) }), { at, p }),
    h.line("postToolUseFailure", tool("Grep", "g-3", { error_message: "e".repeat(max + 1) }), { at, p }),
    h.line("postToolUse", tool("Write", "w-4", { tool_input: input, content: "c".repeat(max + 1) }), { at, p }),
    h.line("postToolUse", tool("Grep", "g-4", { output: 7 }), { at, p }),
    h.line("postToolUse", tool("Grep", "g-5", { output: "" }), { at, p }),
  ], at);
  const collector = await h.start();
  await collector.tick();
  const sent = Object.fromEntries(h.sent(0).map(row => [row.payload.tool_use_id, row.payload]));
  const content = (id: string) => Object.fromEntries(["output", "error_message", "content"].filter(key => key in sent[id]).map(key => [key, sent[id][key]]));
  assert.deepEqual(content("s-1"), { output: "2 passing\n" });
  assert.deepEqual(content("s-2"), { error_message: "command exited 1" });
  assert.deepEqual(content("w-1"), { content: "export const a = 1;\n" });
  assert.deepEqual(sent["w-1"].tool_input, input, "the arguments stay the file path alone");
  assert.deepEqual(content("g-1"), { output: "o".repeat(max) });
  for (const id of ["w-2", "w-3", "r-1", "g-2", "g-3", "w-4", "g-4", "g-5"]) assert.deepEqual(content(id), {}, id);
  assert.doesNotMatch(h.requests[0]!.body, /CANARY/);
  assert.equal(h.sent(0).length, 12, "a value that is left out does not take its record with it");
});

test("turning an option off removes the content it adds from records already on disk and from the saved context", async t => {
  const h = harness(t), at = START - MINUTE, p = EVERYTHING;
  const lines = (turn: string, base: number) => [
    h.line("beforeSubmitPrompt", prompt(turn, { prompt: "CANARY_PROMPT" }), { at: base, p }),
    h.line("afterAgentThought", thought(`${turn}-0-x`, "synthetic-model", { text: "CANARY_THOUGHT" }), { at: base + 1, p }),
    h.line("beforeReadFile", fileRead(`read-${turn}`, "CANARY_READ"), { at: base + 2, p }),
    h.line("postToolUse", tool("Read", `read-${turn}`, { generation_id: turn, output: "CANARY_OUTPUT", tool_input: { file_path: "/srv/fixture/CANARY_PATH" } }), { at: base + 3, p }),
    h.line("postToolUse", tool("Write", `write-${turn}`, { generation_id: turn, tool_input: { file_path: "/srv/fixture/CANARY_PATH" }, content: "CANARY_WRITE" }), { at: base + 4, p }),
    h.line("postToolUseFailure", tool("Shell", `shell-${turn}`, { generation_id: turn, failure_type: "error", error_message: "CANARY_ERROR" }), { at: base + 5, p }),
    h.line("stop", stop(turn), { at: base + 6, p }),
    h.line("afterAgentResponse", reply(turn, { text: "CANARY_REPLY" }), { at: base + 7, p }),
  ];
  const sentContent = (rows: Framed[]) => [...new Set(rows.flatMap(row => JSON.stringify([row.payload, row.context]).match(/CANARY_[A-Z]+/g) ?? []))].sort();

  // Everything on: every kind is sent.
  h.append(lines("turn-a", at), at);
  let collector = await h.start({ policy: EVERYTHING });
  await collector.tick();
  assert.deepEqual(sentContent(h.sent(0)), ["CANARY_ERROR", "CANARY_OUTPUT", "CANARY_PATH", "CANARY_PROMPT", "CANARY_READ", "CANARY_REPLY", "CANARY_THOUGHT", "CANARY_WRITE"]);
  assert.equal(h.sent(0).length, 6);
  // Context that waits for a later record is saved with its content while the options are on.
  h.clock.now += MINUTE;
  h.append([
    h.line("afterAgentThought", thought("turn-waiting-0-x", "synthetic-model", { text: "CANARY_THOUGHT waiting" }), { at: h.clock.now - 30 * SECOND, p }),
    h.line("beforeReadFile", fileRead("read-waiting", "CANARY_READ waiting"), { at: h.clock.now - 30 * SECOND, p }),
  ]);
  await collector.tick();
  assert.match(fs.readFileSync(h.files.checkpoint, "utf8"), /CANARY_THOUGHT waiting.*CANARY_READ waiting/s);
  await collector.close();

  // Prompts off: the reply and the reasoning go, and a reply left empty is not uploaded. Tool content stays.
  const waiting = (turn: string, base: number) => [
    h.line("postToolUse", tool("Read", "read-waiting", { generation_id: turn }), { at: base + 8, p }),
    h.line("afterAgentResponse", reply("turn-waiting", { text: "CANARY_REPLY" }), { at: base + 9, p }),
  ];
  h.clock.now += MINUTE;
  h.append([...lines("turn-b", h.clock.now - 30 * SECOND), ...waiting("turn-b", h.clock.now - 30 * SECOND)]);
  collector = await h.start({ policy: { prompts: false, toolDetails: true, email: true } });
  assert.doesNotMatch(fs.readFileSync(h.files.checkpoint, "utf8"), /CANARY_THOUGHT/, "the saved reasoning left the disk when the collector started");
  assert.match(fs.readFileSync(h.files.checkpoint, "utf8"), /CANARY_READ waiting/);
  await collector.tick();
  assert.deepEqual(sentContent(h.sent(1)), ["CANARY_ERROR", "CANARY_OUTPUT", "CANARY_PATH", "CANARY_READ", "CANARY_WRITE"]);
  assert.deepEqual(h.sent(1).map(row => row.hook), ["beforeSubmitPrompt", "postToolUse", "postToolUse", "postToolUseFailure", "stop", "postToolUse"]);
  assert.deepEqual(h.sent(1).at(-1)!.context, { read: { content: "CANARY_READ waiting" } });
  await collector.close();

  // Tool details off: tool output, failure text and file content go. The reply and the reasoning stay.
  h.clock.now += MINUTE;
  h.append([
    h.line("beforeReadFile", fileRead("read-waiting", "CANARY_READ waiting"), { at: h.clock.now - 50 * SECOND, p }),
    ...lines("turn-c", h.clock.now - 30 * SECOND), ...waiting("turn-c", h.clock.now - 30 * SECOND),
  ]);
  collector = await h.start({ policy: { prompts: true, toolDetails: false, email: true } });
  await collector.tick();
  assert.deepEqual(sentContent(h.sent(2)), ["CANARY_PROMPT", "CANARY_REPLY", "CANARY_THOUGHT"]);
  assert.deepEqual(h.sent(2).filter(row => row.hook === "afterAgentResponse").map(row => [row.payload.generation_id, row.payload.text, row.context]),
    [["turn-c", "CANARY_REPLY", { thoughts: [{ text: "CANARY_THOUGHT" }] }], ["turn-waiting", "CANARY_REPLY", {}]]);
  assert.doesNotMatch(fs.readFileSync(h.files.checkpoint, "utf8"), /CANARY/);
  await collector.close();

  // Both off (--no-enrich): metadata only, and no reply record at all.
  h.clock.now += MINUTE;
  h.append([
    h.line("afterAgentThought", thought("turn-waiting-0-x", "synthetic-model", { text: "CANARY_THOUGHT waiting" }), { at: h.clock.now - 50 * SECOND, p }),
    ...lines("turn-d", h.clock.now - 30 * SECOND), ...waiting("turn-d", h.clock.now - 30 * SECOND),
  ]);
  collector = await h.start({ policy: { prompts: false, toolDetails: false, email: true } });
  const health = await collector.tick();
  assert.deepEqual(sentContent(h.sent(3)), []);
  assert.doesNotMatch(h.requests[3]!.body, /CANARY/);
  assert.deepEqual(h.sent(3).map(row => row.hook), ["beforeSubmitPrompt", "postToolUse", "postToolUse", "postToolUseFailure", "stop", "postToolUse"]);
  assert.deepEqual(h.sent(3).map(row => Object.keys(row.context)), [[], [], [], [], ["models"], []]);
  assert.equal(health.recordsMalformed, 0);
  assert.doesNotMatch(fs.readFileSync(h.files.checkpoint, "utf8"), /CANARY/);
});

test("a record that content takes past 65,536 bytes has its longest content string halved until it fits", async t => {
  const h = harness(t, { policy: CONTENT }), at = START - MINUTE, p = CONTENT;
  const control = (length: number) => "\u0001".repeat(length);
  const BOUND = CURSOR_LIMITS.recordBytes;
  h.append([
    // Six bytes a character: 32 thoughts of 2,048 units are 384 KiB.
    ...Array.from({ length: 32 }, (_, index) => h.line("afterAgentThought", thought(`${TURN}-${index}-x`, "synthetic-model", { text: `${String(index).padStart(2, "0")}${control(2046)}` }), { at: at + index, p })),
    h.line("afterAgentResponse", reply(TURN, { text: "a short reply" }), { at: at + 40, p }),
    // The output and the read content are 48 KiB each: the first of two equals is halved first.
    h.line("beforeReadFile", fileRead("r-1", control(8192)), { at: at + 50, p }),
    h.line("postToolUse", tool("Read", "r-1", { output: control(8192), tool_input: { file_path: "/srv/fixture/repo-alpha/a.bin" } }), { at: at + 51, p }),
    // Half of this text would end inside a pair, so it ends one unit earlier.
    h.line("afterAgentThought", thought(`${NEXT_TURN}-0-x`, "synthetic-model", { text: `a${control(2047)}` }), { at: at + 58, p }),
    h.line("afterAgentThought", thought(`${NEXT_TURN}-1-x`, "synthetic-model", { text: `b${control(2047)}` }), { at: at + 59, p }),
    h.line("afterAgentResponse", reply(NEXT_TURN, { text: control(5000) + PAIR + control(5000) }), { at: at + 60, p }),
    // Three bytes a character fits: nothing is cut.
    h.line("afterAgentResponse", reply("a-wide-turn", { text: String.fromCodePoint(0x4e16).repeat(16_384) }), { at: at + 70, p }),
  ], at);
  const collector = await h.start();
  const health = await run(h, collector, MINUTE);
  const rows = h.delivered(), records = h.requests.flatMap(request => sourceRecords(request.body));
  assert.deepEqual(rows.map(row => [row.hook, row.payload.generation_id]), [["afterAgentResponse", TURN], ["postToolUse", TURN], ["afterAgentResponse", NEXT_TURN], ["afterAgentResponse", "a-wide-turn"]]);
  for (const record of records) assert.ok(Buffer.byteLength(record) <= BOUND, `a record of ${Buffer.byteLength(record)} bytes`);
  for (const request of h.requests) assert.ok(Buffer.byteLength(request.body) <= CURSOR_LIMITS.frameBytes);

  const thoughts = rows[0]!.context.thoughts as Array<{ text: string }>;
  assert.equal(thoughts.length, 32, "halving shortens entries; none is dropped while it has text");
  thoughts.forEach((item, index) => assert.equal(item.text, `${String(index).padStart(2, "0")}${control(item.text.length - 2)}`, "each keeps its own start"));
  assert.deepEqual([...new Set(thoughts.map(item => item.text.length))].sort((a, b) => a - b), [256, 512], "halved in rounds, the longest first");
  assert.ok(thoughts.findIndex(item => item.text.length === 512) > thoughts.map(item => item.text.length).lastIndexOf(256), "the first of equals goes first");
  assert.ok(Buffer.byteLength(records[0]!) + 256 * 6 > BOUND, "it stops at the first size that fits");
  assert.equal(rows[0]!.payload.text, "a short reply");
  assert.equal(rows[0]!.payload.input_tokens, 31744, "metadata is never shortened");

  assert.deepEqual([rows[1]!.payload.output.length, rows[1]!.context.read.content.length], [4096, 4096]);
  assert.deepEqual(rows[1]!.payload.tool_input, { file_path: "/srv/fixture/repo-alpha/a.bin" });
  assert.equal(rows[2]!.payload.text, control(5000), "floor of half is 5,001 units, whose last would be half a pair");
  assert.deepEqual(rows[2]!.context.thoughts.map((item: any) => item.text.length), [2048, 2048], "shorter strings are left as they are");
  assert.equal(rows[3]!.payload.text.length, 16_384);
  assert.deepEqual([health.recordsMalformed, health.recordsAcknowledged, health.backlogBytes], [0, 4, 0]);
});

test("the worked example of the wire contract, from Cursor's events to the uploaded records", async t => {
  const h = harness(t, { policy: CONTENT });
  const conversation = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", turn = "dfbd74c5-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
  const readId = "call-b89e81a2-0c1d-4e2f-8a3b-4c5d6e7f8a9b-0\nfc_7cf51bbd-1e2f-4a3b-8c4d-5e6f7a8b9c0d_0", shellId = "7ccce220-3b4c-4d5e-8f6a-7b8c9d0e1f2a";
  const common = { conversation_id: conversation, session_id: conversation, generation_id: turn, model: "default", cursor_version: "2099.1.2-synthetic",
    workspace_roots: ["/workspace/cursor-fixture"], user_email: "dev.fixture@example.test", transcript_path: null };
  const first = "The user wants me to:\n1. Read calc.py\n...", second = "The user asked me to reply with the single word \"done\".";
  const tokens = { input_tokens: 24869, output_tokens: 195, cache_read_tokens: 24448, cache_write_tokens: 0 };
  const events = [
    { ...common, hook_event_name: "beforeReadFile", tool_use_id: readId, file_path: "/workspace/cursor-fixture/calc.py", content: "def add(a, b):\n    return a + b\n", attachments: [] },
    { ...common, hook_event_name: "postToolUse", tool_name: "Read", tool_use_id: readId, duration: 4.922, tool_input: { file_path: "/workspace/cursor-fixture/calc.py" },
      tool_output: "{\"file_path\":\"/workspace/cursor-fixture/calc.py\",\"content_length\":32}" },
    { ...common, hook_event_name: "afterShellExecution", tool_use_id: shellId, command: "python3 test_calc.py", output: "ok\n", duration: 440.1, sandbox: false },
    { ...common, hook_event_name: "postToolUse", tool_name: "Shell", tool_use_id: shellId, duration: 442.295, tool_input: { command: "python3 test_calc.py", cwd: "", timeout: 30000 },
      tool_output: "{\"output\":\"ok\\n\",\"exitCode\":0}" },
    // Interactive Cursor fires each thought twice: with the resolved model, then as "default".
    { ...common, hook_event_name: "afterAgentThought", generation_id: `${turn}-0-k3x9`, model: "synthetic-model-high", text: first, duration_ms: 1200 },
    { ...common, hook_event_name: "afterAgentThought", text: first, duration_ms: 1200 },
    { ...common, hook_event_name: "afterAgentThought", generation_id: `${turn}-1-p7q2`, model: "synthetic-model-high", text: second, duration_ms: 300 },
    { ...common, hook_event_name: "afterAgentThought", text: second, duration_ms: 300 },
    { ...common, hook_event_name: "stop", status: "completed", loop_count: 0, ...tokens },
    { ...common, hook_event_name: "afterAgentResponse", text: "I'll read `calc.py` and run the tests.done", ...tokens },
  ];
  const program = path.join(h.root, "hook.cjs");
  fs.writeFileSync(program, cursorHookProgram({ stateDir: h.stateDir, content: { prompts: true, toolDetails: true }, identity: { email: false } }));
  for (const event of events) {
    const ran = spawnSync(process.execPath, [program], { input: JSON.stringify(event), env: {}, encoding: "utf8", timeout: 20_000 });
    assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, "", ""]);
  }
  h.clock.now = Date.now() + 30 * SECOND;
  const collector = await h.start();
  await collector.tick();
  const head = `"payload":{"generation_id":"${turn}","model":"default","cursor_version":"2099.1.2-synthetic","workspace_root":"/workspace/cursor-fixture",`;
  assert.deepEqual(sourceRecords(h.requests[0]!.body).filter(record => !record.startsWith('{"hook":"stop"')), [
    `{"hook":"postToolUse",${head}"tool_name":"Read","tool_use_id":${JSON.stringify(readId)},"duration":4.922,"tool_input_size_bytes":49,` +
      `"result":{"content_length":32},"tool_input":{"file_path":"/workspace/cursor-fixture/calc.py"},` +
      `"output":"{\\"file_path\\":\\"/workspace/cursor-fixture/calc.py\\",\\"content_length\\":32}"},` +
      `"context":{"read":{"content":"def add(a, b):\\n    return a + b\\n"}}}`,
    `{"hook":"postToolUse",${head}"tool_name":"Shell","tool_use_id":"${shellId}","duration":442.295,"tool_input_size_bytes":59,` +
      `"result":{"exit_code":0,"output_bytes":3},"tool_input":{"command":"python3 test_calc.py","cwd":"","timeout":30000},"output":"ok\\n"},` +
      `"context":{"shell":{"sandbox":false}}}`,
    `{"hook":"afterAgentResponse",${head}"text":"I'll read \`calc.py\` and run the tests.done","input_tokens":24869,"output_tokens":195,` +
      `"cache_read_tokens":24448,"cache_write_tokens":0},` +
      `"context":{"thoughts":[{"text":"The user wants me to:\\n1. Read calc.py\\n..."},{"text":"The user asked me to reply with the single word \\"done\\"."}]}}`,
  ]);
  assert.deepEqual(h.sent(0).map(row => [row.hook, row.session]), [["postToolUse", conversation], ["postToolUse", conversation], ["stop", conversation], ["afterAgentResponse", conversation]]);
  assert.deepEqual(h.sent(0)[2]!.context, { models: [{ model: "synthetic-model-high" }, { model: "default" }] }, "the stop still names the turn's models");
  assert.deepEqual(savedContext(h), []);
});

test("spool lines written by the 0.5.0 hook program still upload, and a service that knows neither the new hook nor the new keys is sent a valid frame", async t => {
  const h = harness(t, { policy: EVERYTHING }), at = START - MINUTE, p = EVERYTHING;
  // What 0.5.0 wrote: no content keys, six hooks, thoughts without text.
  h.append([
    h.line("beforeSubmitPrompt", prompt(TURN, { prompt: "rename the helper", workspace_root: "/srv/fixture/repo-alpha", user_email: "dev.fixture@example.test" }), { at, p }),
    h.line("afterAgentThought", thought(`${TURN}-0-ab12`, "synthetic-model-high"), { at: at + 1, p }),
    h.line("afterShellExecution", shell("s-1", true), { at: at + 2, p }),
    h.line("postToolUse", tool("Shell", "s-1", { result: { exit_code: 0, output_bytes: 3 }, tool_input: { command: "npm test" } }), { at: at + 3, p }),
    h.line("postToolUse", tool("Read", "r-1", { result: { content_length: 32 }, tool_input: { file_path: "/srv/fixture/repo-alpha/a.ts" } }), { at: at + 4, p }),
    h.line("postToolUseFailure", tool("Shell", "s-2", { failure_type: "error", is_interrupt: false, error_bytes: 16 }), { at: at + 5, p }),
    h.line("stop", stop(), { at: at + 6, p }),
  ], at);
  // A checkpoint as 0.5.0 saved it: no reads, thoughts without text.
  fs.writeFileSync(h.files.checkpoint, JSON.stringify({ version: 1, offsets: {}, inodes: {},
    conversations: [{ id: "an-older-conversation", prompt: "an-older-turn", thoughts: [{ generation_id: "an-older-turn-0", model: "synthetic-model" }], sandbox: [["s-0", false]] }],
    totals: { spooled: 3, acknowledged: 1, malformed: 0, expired: 0, rejected: 0, lost: 0, reframed: 0, requests: 1 } }), { mode: 0o600 });
  const collector = await h.start();
  const health = await collector.tick();
  assert.deepEqual(h.sent(0).map(row => [row.hook, row.payload.tool_use_id, row.context]), [
    ["beforeSubmitPrompt", undefined, {}],
    ["postToolUse", "s-1", { shell: { sandbox: true } }],
    ["postToolUse", "r-1", {}],
    ["postToolUseFailure", "s-2", {}],
    ["stop", undefined, { models: [{ model: "synthetic-model-high" }] }],
  ]);
  assert.equal(h.sent(0)[0]!.payload.prompt, "rename the helper");
  assert.deepEqual(h.sent(0)[1]!.payload.tool_input, { command: "npm test" });
  for (const row of h.sent(0)) for (const key of ["output", "error_message", "content", "text"]) assert.ok(!(key in row.payload));
  assert.deepEqual([health.recordsSpooled, health.recordsAcknowledged, health.recordsMalformed], [3 + 7, 1 + 5, 0]);
  assert.deepEqual(savedContext(h).map(conversation => conversation.id), ["an-older-conversation", CONVERSATION]);
});
