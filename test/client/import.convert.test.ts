// Session-history import: conversion to native live shapes, the honesty
// contract (no live-only shapes), the commit protocol and the ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CONTENT, NO_CONTENT } from "../../src/client/import/model.ts";
import {
  IMPORT_FORBIDDEN_ATTRIBUTES,
  IMPORT_FORBIDDEN_EVENTS,
  IMPORT_FORBIDDEN_METRICS,
  REDACTED,
  TOKEN_USAGE_METRIC,
  convertSession,
} from "../../src/client/import/convert.ts";
import { chunkForPost, toOtlpLogs, toOtlpMetrics } from "../../src/client/import/otlpImport.ts";
import { parseCandidate, scanClaudeSessions, scanCodexSessions } from "../../src/client/import/sources/files.ts";
import { decide, type SessionStatus } from "../../src/client/import/protocol.ts";
import { LedgerStore, MAX_LEDGER_KEYS, type LedgerEntry } from "../../src/client/import/ledger.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "import");

async function sessions(keep = NO_CONTENT) {
  const out = [];
  for (const c of [...scanClaudeSessions(path.join(FIX, "claude-projects")), ...scanCodexSessions(path.join(FIX, "codex-sessions"))]) {
    const r = await parseCandidate(c, keep);
    assert.ok(r.ok && r.session);
    out.push(r.session);
  }
  return out;
}

test("no imported record uses a live-only shape (latency, decisions, cost, active time)", async () => {
  for (const s of await sessions(ALL_CONTENT)) {
    const { logs, metrics } = convertSession(s, ALL_CONTENT);
    for (const l of logs) {
      assert.ok(!IMPORT_FORBIDDEN_EVENTS.includes(String(l.attributes["event.name"])), `${s.source} emitted ${l.attributes["event.name"]}`);
      for (const a of IMPORT_FORBIDDEN_ATTRIBUTES) assert.equal(a in l.attributes, false, `${s.source} emitted ${a}`);
    }
    for (const m of metrics) {
      assert.equal(m.name, TOKEN_USAGE_METRIC);
      assert.ok(!IMPORT_FORBIDDEN_METRICS.includes(m.name));
    }
  }
});

test("claude: prompts and tools are native events; tokens are hourly delta points per model and type", async () => {
  const [claude] = (await sessions()).filter((s) => s.source === "claude-code");
  const { logs, metrics } = convertSession(claude, NO_CONTENT);
  const names = logs.map((l) => l.attributes["event.name"]);
  assert.deepEqual([...new Set(names)].sort(), ["tool_result", "user_prompt"]);
  const prompt = logs.find((l) => l.attributes["event.name"] === "user_prompt")!;
  assert.equal(prompt.attributes.prompt, REDACTED, "the default exports no prompt text");
  assert.equal(prompt.attributes["prompt.id"], "p-1");
  assert.equal(prompt.attributes["session.id"], "cs-test-1");
  const tool = logs.find((l) => l.attributes.tool_use_id === "toolu-2")!;
  assert.equal(tool.attributes.success, "false");
  assert.equal("tool_input" in tool.attributes, false);
  // Opus calls at 10:00 and 11:30 land in two hourly buckets; one per type.
  const opusInput = metrics.filter((m) => m.attributes.model === "claude-opus-4-8" && m.attributes.type === "input");
  assert.deepEqual(opusInput.map((m) => m.asInt), [100, 7]);
  const total = metrics.reduce((n, m) => n + m.asInt, 0);
  const expected = claude.modelCalls.reduce((n, c) => n + c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens, 0);
  assert.equal(total, expected, "token points sum exactly to the session's calls");
  for (const m of metrics) assert.equal(m.attributes["session.id"], "cs-test-1");
});

test("claude: content opt-in carries prompt text and tool input", async () => {
  const [claude] = (await sessions(ALL_CONTENT)).filter((s) => s.source === "claude-code");
  const { logs } = convertSession(claude, ALL_CONTENT);
  assert.equal(logs.find((l) => l.attributes["prompt.id"] === "p-2")!.attributes.prompt, "Now add a test");
  assert.equal(logs.find((l) => l.attributes.tool_use_id === "toolu-2")!.attributes.tool_input, JSON.stringify({ command: "npm test" }));
  // Parsed with content but exported without: the policy at conversion wins.
  const { logs: bare } = convertSession(claude, NO_CONTENT);
  assert.ok(bare.every((l) => l.attributes.prompt === undefined || l.attributes.prompt === REDACTED));
  assert.ok(bare.every((l) => !("tool_input" in l.attributes)));
});

test("codex: sse completions carry Codex's wire convention (input includes cached)", async () => {
  const codex = (await sessions()).find((s) => s.sessionId.endsWith("0002"))!;
  const { logs, metrics } = convertSession(codex, NO_CONTENT);
  assert.equal(metrics.length, 0, "Codex tokens reach dashboards through the sse_event rows");
  const done = logs.filter((l) => l.attributes["event.kind"] === "response.completed");
  assert.deepEqual(done.map((l) => [l.attributes.input_token_count, l.attributes.cached_token_count, l.attributes.output_token_count]),
    [[28000, 20000, 140], [29000, 28000, 60]]);
  assert.ok(done.every((l) => l.attributes["event.name"] === "codex.sse_event" && l.attributes["conversation.id"] === codex.sessionId));
  const tool = logs.find((l) => l.attributes["event.name"] === "codex.tool_result")!;
  assert.equal(tool.attributes.call_id, "call_a");
  assert.equal(tool.attributes.success, "false");
});

test("conversion and chunking are deterministic (the basis of resumable plans)", async () => {
  const [claude] = (await sessions()).filter((s) => s.source === "claude-code");
  const a = convertSession(claude, NO_CONTENT);
  const b = convertSession(claude, NO_CONTENT);
  assert.deepEqual(a, b);
  assert.deepEqual(chunkForPost(a.logs, 3, 1e9), chunkForPost(b.logs, 3, 1e9));
  assert.equal(a.logs.length, 6, "2 prompts + 4 tool results");
  assert.deepEqual(chunkForPost(a.logs, 4, 1e9).map((c) => c.length), [4, 2]);
  assert.equal(chunkForPost(a.logs, 100, 10).length, a.logs.length, "the byte bound splits too; oversized records ship alone");
});

test("OTLP JSON: resource carries provenance, ints are strings, sums are delta", async () => {
  const [claude] = (await sessions()).filter((s) => s.source === "claude-code");
  const { logs, metrics } = convertSession(claude, NO_CONTENT);
  const resource = { "service.name": "claude-code", "ingest.source": "history-import", "import.plan": "abc" };
  const body = toOtlpLogs(logs.slice(0, 1), resource) as any;
  const attrs = Object.fromEntries(body.resourceLogs[0].resource.attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs["ingest.source"], { stringValue: "history-import" });
  const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.deepEqual(rec.attributes.find((a: any) => a.key === "prompt_length").value, { intValue: String(claude.prompts[0].length) });
  const m = toOtlpMetrics(metrics, resource) as any;
  const sum = m.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
  assert.equal(sum.aggregationTemporality, 1);
  assert.equal(typeof sum.dataPoints[0].asInt, "string");
});

// ── Commit protocol ─────────────────────────────────────────────────────────

const PLAN = { id: "a".repeat(32), logParts: 3, metricParts: 2 };
const NOW = Date.parse("2026-10-10T00:00:00Z");
const SETTLE = 300_000;
const st = (over: Partial<SessionStatus> = {}): SessionStatus => ({ sessionId: "s", live: false, plans: [], ...over });
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  plan: PLAN.id, fileSig: "1:1:0", state: "partial", logParts: [], metricParts: [], uncertainMetricParts: [],
  logPartCount: 3, metricPartCount: 2, run: "r", atMs: NOW - 3_600_000, ...over,
});

test("protocol: live, committed and foreign-partial sessions are never sent", () => {
  assert.deepEqual(decide(PLAN, st({ live: true }), undefined, NOW, SETTLE), { action: "skip", reason: "live" });
  assert.deepEqual(
    decide(PLAN, st({ plans: [{ plan: PLAN.id, complete: true, logParts: [], lastArrivalMs: 0 }] }), undefined, NOW, SETTLE),
    { action: "skip", reason: "already_imported" });
  assert.equal(
    (decide(PLAN, st({ plans: [{ plan: "b".repeat(32), complete: true, logParts: [], lastArrivalMs: 0 }] }), undefined, NOW, SETTLE) as any).reason,
    "changed_since_import");
  const foreign = decide(PLAN, st({ plans: [{ plan: "c".repeat(32), complete: false, logParts: ["L0"], lastArrivalMs: 0 }] }), undefined, NOW, SETTLE);
  assert.deepEqual(foreign, { action: "skip", reason: "conflicting_partial", plans: ["c".repeat(32)] });
});

test("protocol: a local unfinished plan with token parts blocks a different plan", () => {
  const other = entry({ plan: "d".repeat(32), metricParts: [], uncertainMetricParts: [0] });
  assert.deepEqual(decide(PLAN, st(), other, NOW, SETTLE), { action: "skip", reason: "conflicting_partial", plans: ["d".repeat(32)] });
  const logsOnly = entry({ plan: "d".repeat(32), logParts: [0] });
  assert.equal(decide(PLAN, st(), logsOnly, NOW, SETTLE).action, "send", "log rows alone collapse; they don't block");
});

test("protocol: a fresh session sends everything", () => {
  assert.deepEqual(decide(PLAN, st(), undefined, NOW, SETTLE), { action: "send", skipLogParts: [], skipMetricParts: [], resumed: false });
});

test("protocol: a partial plan resumes from the ledger without resending accepted metric parts", () => {
  const d = decide(PLAN, st(), entry({ logParts: [0, 1], metricParts: [0] }), NOW, SETTLE);
  assert.deepEqual(d, { action: "send", skipLogParts: [0, 1], skipMetricParts: [0], resumed: true });
});

test("protocol: an uncertain metric part (or a missing ledger) forces a server probe first", () => {
  assert.deepEqual(decide(PLAN, st(), entry({ metricParts: [0], uncertainMetricParts: [1] }), NOW, SETTLE), { action: "probe" });
  const serverOnly = st({ plans: [{ plan: PLAN.id, complete: false, logParts: ["L0", "L2"], lastArrivalMs: NOW - 3_600_000 }] });
  assert.deepEqual(decide(PLAN, serverOnly, undefined, NOW, SETTLE), { action: "probe" });
  const probed = st({ plans: [{ plan: PLAN.id, complete: false, logParts: ["L0", "L2"], metricParts: ["M1"], lastArrivalMs: NOW - 3_600_000 }] });
  assert.deepEqual(decide(PLAN, probed, undefined, NOW, SETTLE, true),
    { action: "send", skipLogParts: [0, 2], skipMetricParts: [1], resumed: true });
  assert.deepEqual(decide(PLAN, serverOnly, undefined, NOW, SETTLE, true), { action: "skip", reason: "unverifiable" },
    "a probe that returned nothing for the plan cannot rule out a landed part");
});

test("protocol: rows that may still be in flight block a resume until they settle", () => {
  assert.deepEqual(decide(PLAN, st(), entry({ logParts: [0], atMs: NOW - 10_000 }), NOW, SETTLE), { action: "skip", reason: "settling" });
  const recent = st({ plans: [{ plan: PLAN.id, complete: false, logParts: ["L0"], lastArrivalMs: NOW - 60_000 }] });
  assert.deepEqual(decide(PLAN, recent, undefined, NOW, SETTLE), { action: "skip", reason: "settling" });
});

test("protocol: a plan with no metric parts resumes from server log parts alone", () => {
  const plan = { ...PLAN, metricParts: 0 };
  const s = st({ plans: [{ plan: PLAN.id, complete: false, logParts: ["L1"], lastArrivalMs: NOW - 3_600_000 }] });
  assert.deepEqual(decide(plan, s, undefined, NOW, SETTLE), { action: "send", skipLogParts: [1], skipMetricParts: [], resumed: true });
});

// ── Ledger ─────────────────────────────────────────────────────────────────

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ct-ledger-")), "import-ledger.json");

test("ledger: journal events survive a crash (torn last line) and compact into a snapshot", () => {
  const p = tmpLedger();
  const a = LedgerStore.open(p);
  a.record({ k: "h", s: "claude-code:s1", ev: "begin", plan: "p1", fileSig: "1:1:0", logPartCount: 2, metricPartCount: 1, run: "r", atMs: 1 });
  a.record({ k: "h", s: "claude-code:s1", ev: "metric", plan: "p1", part: 0, atMs: 2 });
  fs.appendFileSync(a.journalPath, "{\"k\":\"h\",\"s\":\"claude");
  const b = LedgerStore.open(p);
  assert.deepEqual(b.get("h", "claude-code:s1")!.metricParts, [0]);
  b.record({ k: "h", s: "claude-code:s1", ev: "complete", plan: "p1", atMs: 3 });
  b.compact();
  assert.equal(fs.existsSync(b.journalPath), false);
  assert.equal(LedgerStore.open(p).get("h", "claude-code:s1")!.state, "complete");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test("ledger: events for another plan don't touch an entry; a new begin resets it", () => {
  const s = LedgerStore.open(tmpLedger());
  s.record({ k: "h", s: "x", ev: "begin", plan: "p1", fileSig: "f", logPartCount: 1, metricPartCount: 1, run: "r", atMs: 1 });
  s.record({ k: "h", s: "x", ev: "metric", plan: "p0", part: 0, atMs: 2 });
  assert.deepEqual(s.get("h", "x")!.metricParts, []);
  s.record({ k: "h", s: "x", ev: "uncertain", plan: "p1", part: 0, atMs: 3 });
  s.record({ k: "h", s: "x", ev: "metric", plan: "p1", part: 0, atMs: 4 });
  assert.deepEqual(s.get("h", "x")!.uncertainMetricParts, [], "a confirmed part is no longer uncertain");
  s.record({ k: "h", s: "x", ev: "begin", plan: "p2", fileSig: "g", logPartCount: 1, metricPartCount: 0, run: "r2", atMs: 5 });
  assert.equal(s.get("h", "x")!.plan, "p2");
  assert.deepEqual(s.get("h", "x")!.metricParts, []);
});

test("ledger: bounded keys, and a newer importer's file is never rewritten", () => {
  const p = tmpLedger();
  const s = LedgerStore.open(p);
  for (let i = 0; i < MAX_LEDGER_KEYS + 3; i++) {
    s.record({ k: `key${i}`, s: "x", ev: "begin", plan: "p", fileSig: "f", logPartCount: 1, metricPartCount: 0, run: "r", atMs: i });
  }
  s.compact();
  const keys = Object.keys(JSON.parse(fs.readFileSync(p, "utf8")).keys);
  assert.equal(keys.length, MAX_LEDGER_KEYS);
  assert.ok(!keys.includes("key0"), "the least recently written key goes first");

  fs.writeFileSync(p, JSON.stringify({ version: 99, keys: {} }));
  const foreign = LedgerStore.open(p);
  assert.equal(foreign.readOnly, true);
  foreign.record({ k: "h", s: "x", ev: "begin", plan: "p", fileSig: "f", logPartCount: 1, metricPartCount: 0, run: "r", atMs: 1 });
  foreign.compact();
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).version, 99);
});
