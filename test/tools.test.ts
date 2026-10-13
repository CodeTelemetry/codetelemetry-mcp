// Drives the MCP tool registry against scripted CodeTelemetry responses. The
// recurring assertion is the SECURITY INVARIANT: no tool result ever contains a
// plaintext cot_… key.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OnboardingSession } from "../src/session.ts";
import { callTool, requestedConfigPath, TOOLS, type ToolContext, type ToolResult } from "../src/tools.ts";
import { tmpSettingsPath } from "./support/helpers.ts";

const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;

test("registry exposes the documented tools with JSON-schema inputs", () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "auth_status",
    "authenticate",
    "compare_sessions",
    "configure_github_pr_gate",
    "estimate_linear_issue",
    "estimate_plan",
    "estimate_task_size",
    "find_similar_session_errors",
    "get_cost_signal",
    "get_github_pr_gate",
    "get_ingest_key",
    "get_session_performance",
    "interpret_session",
    "onboard",
    "plan_next_session",
    "read_session_events",
    "search_sessions",
    "send_test_event",
    "status",
    "verify_telemetry",
    "write_local_config",
  ]);
  for (const t of TOOLS) {
    assert.equal((t.inputSchema as any).type, "object");
    assert.ok(t.description.length > 20);
  }
  // The onboarding inputs a model controls are bounded and say what they accept.
  const auth = TOOLS.find((tool) => tool.name === "authenticate")!.inputSchema as any;
  assert.equal(auth.properties.workspaceUrl.maxLength, 2048);
  assert.match(auth.properties.workspaceUrl.description, /codetelemetry\.com or its subdomains/);
  assert.equal(auth.properties.organizationId.maxLength, 256);
  for (const name of ["write_local_config", "onboard", "status"]) {
    const schema = TOOLS.find((tool) => tool.name === name)!.inputSchema as any;
    assert.equal(schema.properties.path.maxLength, 1024, `${name} bounds its path`);
    assert.match(schema.properties.path.description, /settings\.json or settings\.local\.json/);
    assert.equal(schema.properties.workspaceUrl, undefined, `${name} cannot redirect credentials`);
  }
  const writeSchema = TOOLS.find((tool) => tool.name === "write_local_config")!.inputSchema as any;
  assert.match(writeSchema.properties.enrich.description, /raw API request\/response bodies/);
  assert.match(writeSchema.properties.repositoryObservation.description, /absolute repository root/);
});

test("interpret_session over the MCP budget first drops a v2 record's activity citations, keeping the v1 categories", async () => {
  const session = new OnboardingSession();
  session.setKey("cot_" + "interpretsessiontestkey00002", "pasted");
  const pointer = (i: number) => ({ id: `e${i}`, position: i, turnIndex: 0, target: `/api/dashboards/session-timeline?eventOffset=${i}&pad=${"p".repeat(1_500)}` });
  const step = (i: number) => ({ summary: "Push command ran.", basis: "observed", confidence: 1, evidenceIds: [`e${i}`], step: "vcs_push" });
  const ctx: ToolContext = {
    session,
    endpointsOverride: { apiBase: "https://example.test" },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true, state: "warm", sessionId: "session-v2", message: "materialized interpretation is ready",
      interpretation: { version: "session-interpretation-v2", extractorVersion: "deterministic-evidence-v2", status: "ready",
        coverage: { source: "complete", content: "visible", outputTruncated: false, events: 33 },
        phases: [{ summary: "Tool execution observed.", basis: "observed", confidence: 1, evidenceIds: ["e0"] }],
        evidence: Array.from({ length: 33 }, (_, i) => pointer(i)),
        activity: { verification: { state: "not_observed", runs: [], runsTruncated: false },
          vcs: { state: "observed", pushes: 32, steps: Array.from({ length: 32 }, (_, i) => step(i + 1)), stepsTruncated: false } } },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };
  const result = await callTool("interpret_session", { sessionId: "session-v2" }, ctx);
  const interpretation = result.interpretation as any;
  assert.equal(result.responseTruncated, true);
  assert.deepEqual([interpretation.phases.length, interpretation.evidence.map((e: { id: string }) => e.id), interpretation.activity.vcs.pushes,
    interpretation.activity.vcs.steps.length, interpretation.activity.vcs.stepsTruncated], [1, ["e0"], 32, 0, true]);
});

test("read_session_events relays the tool input to its route, accepts only its states, and bounds the envelope", async () => {
  const key = "cot_" + "readsessioneventstestkey0001";
  const session = new OnboardingSession();
  session.setKey(key, "pasted");
  let request: { url: string; auth: string | null; body: any } | undefined;
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  const ctx: ToolContext = {
    session,
    endpointsOverride: { apiBase: "https://example.test" },
    fetchImpl: async (url, init) => {
      request = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    },
  };
  const event = (position: number) => ({ position, time: "2026-09-29T12:00:00.000Z", kind: "tool", name: "Bash", outcome: "succeeded",
    blocks: [{ role: "output", text: `${"x".repeat(900)}"\n` }] });
  reply = { status: 200, body: { ok: true, state: "ready", sessionId: "session-a", source: { snapshot: "p:1:00000000000040008000000000000001", events: 3 },
    window: { mode: "page", from: 0, to: 2, returned: 3 }, events: [0, 1, 2].map(event), nextCursor: "rse1.e30", dataNotice: "untrusted", message: "3 events shown" } };
  const input = { sessionId: "session-a", outcome: "failed", limit: 3 };
  const ready = await callTool("read_session_events", input, ctx);
  assert.equal(ready.ok, true);
  assert.equal(ready.state, "ready");
  assert.equal(request?.url, "https://example.test/api/agent/read-session-events");
  assert.equal(request?.auth, `Bearer ${key}`);
  assert.deepEqual(request?.body, input, "the input reaches the route's single validator unchanged");
  assert.equal((ready.events as unknown[]).length, 3);
  assert.ok(!JSON.stringify(ready).includes(key));

  // A server bug that answers too much loses its events, never its window or cursor.
  reply = { status: 200, body: { ...(reply.body as object), events: Array.from({ length: 80 }, (_, i) => event(i)) } };
  const reduced = await callTool("read_session_events", input, ctx);
  assert.equal(reduced.responseTruncated, true);
  assert.equal(reduced.events, undefined);
  assert.equal(reduced.nextCursor, undefined, "a cursor past dropped events would skip them");
  assert.deepEqual(reduced.window, { mode: "page", from: 0, to: 2, returned: 3 }, "the window says where to ask again");
  const envelope = { content: [{ type: "text", text: JSON.stringify(reduced, null, 2) }], structuredContent: reduced, isError: false };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 64 * 1024 - 512);

  reply = { status: 200, body: { ok: true, state: "summarized", sessionId: "session-a", message: "x" } };
  assert.equal((await callTool("read_session_events", input, ctx)).error, "read_session_events_malformed", "only the closed state vocabulary is relayed");
  reply = { status: 400, body: { error: "invalid_read_session_events_input", message: "use only one of cursor, around and expand" } };
  const invalid = await callTool("read_session_events", input, ctx);
  assert.deepEqual([invalid.ok, invalid.error, invalid.message], [false, "bad_input", "use only one of cursor, around and expand"]);
  assert.equal((await callTool("read_session_events", { sessionId: "s", text: "x".repeat(9_000) }, ctx)).error, "bad_input", "input is bounded before any request");
});

test("interpret_session uses the authenticated projection route, keeps snippets opt-in, and bounds model output", async () => {
  const key = "cot_" + "interpretsessiontestkey00001";
  // Compact JSON is small, but pretty-printing a deeply nested value expands
  // indentation quadratically. This pins the complete text+structured envelope
  // boundary rather than a misleading compact-JSON threshold.
  let nested: unknown = 0;
  for (let i = 0; i < 300; i++) nested = { a: nested };
  let request: { url: string; auth: string | null; body: any } | undefined;
  const session = new OnboardingSession();
  session.setKey(key, "pasted");
  // Canonical links built by the server from its configured origin.
  const sessionUrl = "https://codetelemetry.com/dashboards/session-timeline?session=session-a&service=claude-code";
  const evidenceLinks = [{ evidenceId: "e0", position: 0, url: `${sessionUrl}&focus=toolu_01`, deepLink: true }];
  const ctx: ToolContext = {
    session,
    endpointsOverride: { apiBase: "https://example.test" },
    fetchImpl: async (url, init) => {
      request = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({
        ok: true, state: "warm", sessionId: "session-a", sessionUrl, evidenceLinks, message: "materialized interpretation is ready",
        evidence: [{ id: "e0", position: 0, snippet: "filtered evidence", truncated: false }],
        interpretation: { version: "session-interpretation-v1", extractorVersion: "deterministic-evidence-v1",
          source: { tenantId: "tenant-a", privacyVersion: "privacy-1", sessionId: "session-a", service: "claude-code", snapshot: "p:1:00000000000040008000000000000001" },
          status: "ready", coverage: { source: "complete", content: "visible", outputTruncated: false, events: 1 }, nested },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const result = await callTool("interpret_session", { sessionId: "session-a", evidenceIds: ["e0"] }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.state, "warm");
  assert.equal(result.responseTruncated, true, "MCP-specific duplicate-response budget is enforced");
  assert.equal(request?.url, "https://example.test/api/agent/interpret-session");
  assert.equal(request?.auth, `Bearer ${key}`);
  assert.deepEqual(request?.body, { sessionId: "session-a", evidenceIds: ["e0"] });
  assert.ok(!JSON.stringify(result).includes(key), "interpret-session result leaked plaintext key");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.equal(result.sessionUrl, sessionUrl, "the reduced result keeps the canonical session link, as the server sends it");
  assert.deepEqual(result.evidenceLinks, evidenceLinks, "the reduced result keeps the bounded evidence links");
  assert.doesNotMatch(String(result.message), /fewer evidence pointers/, "a one-id request is never told to request fewer pointers");
  // The complete wire response duplicates the value as pretty text and
  // structuredContent (mcpServer.ts); links fit that budget too.
  const envelope = { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 64 * 1024 - 512, "complete text+structured response stays within the stdio budget");
});

test("interpret_session forwards the evidence snapshot and never advises narrowing a one-id request", async () => {
  const key = "cot_" + "interpretsessionsnapshot0001";
  const session = new OnboardingSession(); session.setKey(key, "pasted");
  let body: any;
  // Server results already fit the envelope; this pins the local last resort.
  const oversized = (ids: string[]) => ({ ok: true, state: "warm", sessionId: "session-a", responseMode: "evidence", message: "ready",
    interpretation: { version: "session-interpretation-v1", extractorVersion: "deterministic-evidence-v1", source: {}, status: "ready", coverage: {} },
    evidence: ids.map(id => ({ id, padding: "p".repeat(40_000) })),
    evidenceResolution: ids.map(evidenceId => ({ evidenceId, status: "resolved", retryMayHelp: false, narrowerRequestMayHelp: false, detail: "resolved" })) });
  let reply = oversized(["e1"]);
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: "https://example.test" }, fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  } };
  const snapshot = "p:1:00000000000040008000000000000001";
  const one = await callTool("interpret_session", { sessionId: "session-a", evidenceIds: ["e1"], snapshot }, ctx);
  assert.deepEqual(body, { sessionId: "session-a", evidenceIds: ["e1"], snapshot }, "the snapshot the ids came from reaches the server");
  assert.equal(one.responseMode, "evidence");
  assert.equal(one.responseTruncated, true);
  assert.deepEqual((one.evidenceResolution as Array<{ status: string; narrowerRequestMayHelp: boolean }>).map(entry => [entry.status, entry.narrowerRequestMayHelp]),
    [["omitted_response_budget", false]]);
  assert.doesNotMatch(String(one.message), /fewer|one at a time/, "a one-id request is never told to narrow");
  reply = oversized(["e1", "e2"]);
  const two = await callTool("interpret_session", { sessionId: "session-a", evidenceIds: ["e1", "e2"] }, ctx);
  assert.deepEqual((two.evidenceResolution as Array<{ narrowerRequestMayHelp: boolean }>).map(entry => entry.narrowerRequestMayHelp), [true, true]);
  assert.match(String(two.message), /one at a time/);
  assert.equal((await callTool("interpret_session", { sessionId: "session-a", snapshot: "" }, ctx)).error, "bad_input");
});

test("search_sessions and compare_sessions pass server-built canonical links through unchanged", async () => {
  const key = "cot_" + "sessionlinkspassthrough00001";
  const session = new OnboardingSession(); session.setKey(key, "pasted");
  const url = (sessionId: string) => `https://codetelemetry.com/dashboards/session-timeline?session=${encodeURIComponent(sessionId)}&service=codex`;
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: "https://example.test" }, fetchImpl: async (requestUrl) => {
    const body = String(requestUrl).endsWith("/session-search")
      ? { ok: true, scope: "personal", report: { results: [{ sessionId: "s 1", sessionUrl: url("s 1"), sourceService: "codex" }], total: 1, limit: 25, offset: 0,
        hasMore: false, nextOffset: null, query: {}, repos: [], promptSearchAvailable: false, contentRedacted: true } }
      : { ok: true, state: "complete", coverage: { requested: 2, compared: 2, ready: 2, partial: 0, unavailable: 0 }, patterns: [], limitations: [],
        sessionLinks: [{ sessionId: "a", service: "codex", sessionUrl: url("a") }, { sessionId: "b", service: "codex", sessionUrl: url("b") }],
        evidenceLinkLimitation: "Evidence ids in this result are not deep-linked.", message: "Comparison completed." };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  } };
  const search = await callTool("search_sessions", { q: "s" }, ctx);
  assert.equal((search.report as any).results[0].sessionUrl, url("s 1"));
  const compared = await callTool("compare_sessions", { sessions: [{ sessionId: "a" }, { sessionId: "b" }] }, ctx);
  assert.deepEqual((compared.sessionLinks as any[]).map(link => link.sessionUrl), [url("a"), url("b")]);
  assert.equal(compared.evidenceLinkLimitation, "Evidence ids in this result are not deep-linked.");
});

test("compare_sessions validates a bounded distinct cohort and uses the authenticated projection route", async () => {
  const key = "cot_" + "comparesessiontestkey00001";
  let request: { url: string; auth: string | null; body: any } | undefined;
  const session = new OnboardingSession(); session.setKey(key, "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: "https://example.test" }, fetchImpl: async (url, init) => {
    request = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ ok: true, state: "complete", coverage: { requested: 2, compared: 2, ready: 2, partial: 0, unavailable: 0 },
      patterns: [], limitations: ["descriptive only"], message: "Comparison completed." }), { status: 200, headers: { "content-type": "application/json" } });
  } };
  const result = await callTool("compare_sessions", { sessions: [{ sessionId: "session-a" }, { sessionId: "session-b", service: "codex" }] }, ctx);
  assert.equal(result.ok, true); assert.equal(result.state, "complete");
  assert.equal(request?.url, "https://example.test/api/agent/compare-sessions");
  assert.equal(request?.auth, `Bearer ${key}`);
  assert.deepEqual(request?.body, { sessions: [{ sessionId: "session-a" }, { sessionId: "session-b", service: "codex" }] });
  assert.equal((await callTool("compare_sessions", { sessions: [{ sessionId: "same" }, { sessionId: "same" }] }, ctx)).error, "bad_input");
  assert.ok(!JSON.stringify(result).includes(key));
});

test("plan_next_session forwards only explicit bounded input and keeps the key out of output", async () => {
  const key = "cot_" + "plannextsessiontestkey00001";
  let request: { url: string; auth: string | null; body: any } | undefined;
  const session = new OnboardingSession(); session.setKey(key, "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: "https://example.test" }, fetchImpl: async (url, init) => {
    request = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ ok: true, state: "insufficient_history", message: "no history", task: { text: "add a route" },
      budget: { retrievals: 1, interpretationReads: 0, sizingScans: 0, deadlineMs: 4000 }, coverage: { retrieved: 0, readable: 0, unavailable: 0, partial: 0 },
      confidence: "low", tokenEffort: { point: 0, low: 0, high: 0, basis: "none" }, sessionBoundaries: [], recommendations: [], calibrationTask: null, limitations: [] }), { status: 200, headers: { "content-type": "application/json" } });
  } };
  const result = await callTool("plan_next_session", { taskText: "add a route", repo: "api" }, ctx);
  assert.equal(result.ok, true); assert.equal(result.state, "insufficient_history");
  assert.equal(request?.url, "https://example.test/api/agent/plan-next-session");
  assert.equal(request?.auth, `Bearer ${key}`); assert.deepEqual(request?.body, { taskText: "add a route", repo: "api" });
  assert.equal((await callTool("plan_next_session", {}, ctx)).error, "bad_input");
  assert.ok(!JSON.stringify(result).includes(key));
});

test("tools that need a key fail cleanly before one is set", async () => {
  const ctx: ToolContext = { session: new OnboardingSession() };
  for (const name of [
    "write_local_config",
    "send_test_event",
    "verify_telemetry",
    "get_session_performance",
    "find_similar_session_errors",
    "search_sessions",
    "read_session_events",
    "compare_sessions",
  ]) {
    const r = await callTool(name, {}, ctx);
    assert.equal(r.ok, false);
  }
  // get_ingest_key with a bad key is rejected, not stored.
  const bad = await callTool("get_ingest_key", { key: "not-a-key" }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad_key");
  assert.equal(ctx.session.hasKey(), false);
});

test("content and repository opt-ins reject non-booleans before writing", async () => {
  const settingsPath = tmpSettingsPath();
  const ctx: ToolContext = {
    session: new OnboardingSession(),
    configPathsOverride: { claude: settingsPath },
  };
  ctx.session.setKey("cot_" + "booleanconsentboundary0001", "pasted");
  for (const [tool, args] of [
    ["write_local_config", { repositoryObservation: "false" }],
    ["write_local_config", { enrich: 1 }],
    ["onboard", { repositoryObservation: "true" }],
    ["onboard", { enrich: "false" }],
  ] as const) {
    const result = await callTool(tool, args, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.error, "bad_input");
  }
  assert.equal(fs.existsSync(settingsPath), false);
});

type Recorded = { url: string; body: Record<string, unknown> };
type Route = unknown | ((body: Record<string, unknown>) => [number, unknown]);

/** A scripted backend: `routes` maps a URL path to the JSON it answers (200), or
 *  to a function of the request body returning [status, json]. */
function scripted(routes: Record<string, Route>, seen: Recorded[] = []) {
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url, body });
    const route = routes[new URL(url).pathname];
    if (route === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const [status, payload] = typeof route === "function"
      ? (route as (b: Record<string, unknown>) => [number, unknown])(body)
      : [200, route];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, seen };
}

/** Run `fn` with CODETELEMETRY_API_BASE unset (or set), restoring it afterwards. */
async function withApiBaseEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.CODETELEMETRY_API_BASE;
  if (value === undefined) delete process.env.CODETELEMETRY_API_BASE;
  else process.env.CODETELEMETRY_API_BASE = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.CODETELEMETRY_API_BASE;
    else process.env.CODETELEMETRY_API_BASE = previous;
  }
}

const DEVICE_CODE = { device_code: "device-1", user_code: "ABCD-EFGH", verification_uri: "https://codetelemetry.com/activate", expires_in: 600, interval: 2 };
const ORG_KEY = "cot_" + "organizationscopedtestkey0001";
const INGEST = "https://ingest.codetelemetry.com";
const scopeOf = (teamId: string | null) => ({ tenantId: "tenant-a", teamId, billingAccountId: "billing-a" });

test("workspaceUrl accepts only https CodeTelemetry hosts, yields to the host's pin, and moves the session only once the server answers", async () => {
  await withApiBaseEnv(undefined, async () => {
    for (const workspaceUrl of [
      "http://codetelemetry.com",
      "https://codetelemetry.com.example.net",
      "https://example.net",
      "https://user:secret@codetelemetry.com",
      "https://codetelemetry.com@example.net",
      "not a url",
      "",
      42,
    ]) {
      const { fetchImpl, seen } = scripted({});
      const ctx: ToolContext = { session: new OnboardingSession(), fetchImpl };
      const r = await callTool("authenticate", { workspaceUrl }, ctx);
      assert.equal(r.error, "bad_input", `${JSON.stringify(workspaceUrl)} must be refused`);
      assert.equal(seen.length, 0, "a refused workspaceUrl makes no request");
      assert.equal(ctx.session.apiBase, null);
    }

    const { fetchImpl, seen } = scripted({ "/api/device/code": DEVICE_CODE });
    const ctx: ToolContext = { session: new OnboardingSession(), fetchImpl };
    const r = await callTool("authenticate", { workspaceUrl: "https://Acme.CodeTelemetry.com/app/sessions?x=1" }, ctx);
    assert.equal(r.ok, true);
    assert.equal(ctx.session.apiBase, "https://acme.codetelemetry.com");
    assert.equal(seen[0]!.url, "https://acme.codetelemetry.com/api/device/code");
    assert.equal(r.verificationUriComplete, "https://codetelemetry.com/activate?code=ABCD-EFGH");

    // A failed sign-in leaves the session where it was; a successful move to
    // another server drops the key that belongs to the old one.
    const moving: ToolContext = { session: new OnboardingSession(), fetchImpl: scripted({ "/api/device/code": () => [503, {}] }).fetchImpl };
    moving.session.setKey("cot_" + "heldkeyfromanotherserver0001", "pasted");
    assert.equal((await callTool("authenticate", { workspaceUrl: "https://acme.codetelemetry.com" }, moving)).ok, false);
    assert.equal(moving.session.apiBase, null);
    assert.equal(moving.session.hasKey(), true);
    const moved = await callTool("authenticate", { workspaceUrl: "https://acme.codetelemetry.com" }, { ...moving, fetchImpl: scripted({ "/api/device/code": DEVICE_CODE }).fetchImpl });
    assert.equal(moved.ok, true);
    assert.equal(moving.session.apiBase, "https://acme.codetelemetry.com");
    assert.equal(moving.session.hasKey(), false, "a key never follows the session to another server");
  });

  // The host's pin (its endpoint override or CODETELEMETRY_API_BASE) outranks the model.
  const pinned = scripted({ "/api/device/code": DEVICE_CODE });
  const pinnedCtx: ToolContext = { session: new OnboardingSession(), fetchImpl: pinned.fetchImpl, endpointsOverride: { apiBase: "https://codetelemetry.com" } };
  const refused = await callTool("authenticate", { workspaceUrl: "https://acme.codetelemetry.com" }, pinnedCtx);
  assert.equal(refused.error, "bad_input");
  assert.match(String(refused.message), /pins the CodeTelemetry server/);
  assert.equal(pinned.seen.length, 0);
  assert.equal((await callTool("authenticate", { workspaceUrl: "https://codetelemetry.com/app" }, pinnedCtx)).ok, true, "the pinned origin itself is fine");
  await withApiBaseEnv("https://codetelemetry.com", async () => {
    const r = await callTool("authenticate", { workspaceUrl: "https://acme.codetelemetry.com" }, { session: new OnboardingSession(), fetchImpl: scripted({}).fetchImpl });
    assert.equal(r.error, "bad_input");
  });
});

test("organizationId starts a scope-fenced sign-in and keeps only a key confirmed for that organization", async () => {
  for (const organizationId of ["", "   ", "x".repeat(257), 7]) {
    const r = await callTool("authenticate", { organizationId }, { session: new OnboardingSession(), fetchImpl: scripted({}).fetchImpl });
    assert.equal(r.error, "bad_input", `${JSON.stringify(organizationId)} must be refused`);
  }
  const start = async (token: Route, connectivity?: Route) => {
    const seen: Recorded[] = [];
    const { fetchImpl } = scripted({
      "/api/device/code/scope-v1": DEVICE_CODE,
      "/api/device/token/scope-v1": token,
      ...(connectivity === undefined ? {} : { "/api/connectivity/check": connectivity }),
    }, seen);
    const ctx: ToolContext = { session: new OnboardingSession(), fetchImpl, endpointsOverride: { ingestEndpoint: INGEST } };
    const started = await callTool("authenticate", { organizationId: " org-a " }, ctx);
    return { ctx, seen, started };
  };

  // Attested to the requested organization: kept, and later checks carry the scope.
  {
    const { ctx, seen, started } = await start(
      { api_key: ORG_KEY, ingest_endpoint: INGEST, scope: scopeOf("org-a") },
      { seen: false, state: "wrong_scope", mismatches: ["teamId"] },
    );
    assert.equal(started.organizationId, "org-a");
    assert.equal(started.verificationUriComplete, "https://codetelemetry.com/activate?code=ABCD-EFGH&teamId=org-a&scope=v1");
    assert.deepEqual(seen[0]!.body, { client: "codetelemetry-connect", expected: { teamId: "org-a" } });
    const authorized = await callTool("auth_status", {}, ctx);
    assert.equal(authorized.status, "authorized");
    assert.equal(authorized.organizationId, "org-a");
    assert.equal(seen[1]!.url, "https://codetelemetry.com/api/device/token/scope-v1");
    const status = await callTool("status", {}, { ...ctx, configPathsOverride: { claude: tmpSettingsPath() } });
    assert.deepEqual(status.organization, { requested: "org-a", key: "org-a" });
    ctx.session.lastProbeId = "probe-1";
    const verified = await callTool("verify_telemetry", { timeoutMs: 1_000 }, ctx);
    assert.equal(verified.state, "wrong_scope");
    assert.deepEqual(seen.at(-1)!.body.expected, { teamId: "org-a" });
    assert.ok(!PLAINTEXT_KEY_RE.test(JSON.stringify([started, authorized, status, verified])));

    // onboard repeats the check and refuses before writing anything.
    const settingsPath = tmpSettingsPath();
    const onboarded = await callTool("onboard", {}, { ...ctx, configPathsOverride: { claude: settingsPath } });
    assert.equal(onboarded.ok, false);
    assert.match(String(onboarded.message), /refusing to configure key: wrong_scope/);
    assert.equal(fs.existsSync(settingsPath), false);
  }

  // A mismatched attestation, or production's 409 refusal, ends the authorization.
  for (const token of [
    { api_key: ORG_KEY, ingest_endpoint: INGEST, scope: scopeOf("org-b") },
    () => [409, { error: "access_denied", state: "wrong_scope", mismatches: ["teamId"] }] as [number, unknown],
  ]) {
    const { ctx } = await start(token);
    const refused = await callTool("auth_status", {}, ctx);
    assert.equal(refused.status, "wrong_scope");
    assert.equal(ctx.session.hasKey(), false);
    assert.equal((await callTool("auth_status", {}, ctx)).status, "no_pending_auth", "the refused code is not polled again");
  }

  // No attestation in the token response: a live scope check decides.
  for (const [connectivity, status] of [
    [{ seen: false, state: "scope_verified" }, "authorized"],
    [{ seen: false, state: "budget_exhausted" }, "authorized"],
    [() => [409, { seen: false, state: "wrong_scope" }], "wrong_scope"],
    [() => [500, {}], "scope_unverified"],
  ] as const) {
    const { ctx, seen } = await start({ api_key: ORG_KEY, ingest_endpoint: INGEST }, connectivity);
    const r = await callTool("auth_status", {}, ctx);
    assert.equal(r.status, status);
    assert.equal(ctx.session.hasKey(), status === "authorized");
    assert.deepEqual(seen.at(-1)!.body, { scopeOnly: true, expected: { teamId: "org-a" } });
    assert.equal(ctx.session.deviceCode, null);
  }

  // A newer authorization replaces a poll in flight: nothing from the old one is kept.
  {
    let ctx!: ToolContext;
    ({ ctx } = await start(() => {
      ctx.session.deviceCode = "device-2";
      return [200, { api_key: ORG_KEY, ingest_endpoint: INGEST, scope: scopeOf("org-a") }];
    }));
    const r = await callTool("auth_status", {}, ctx);
    assert.equal(r.status, "superseded");
    assert.equal(ctx.session.hasKey(), false);
    assert.equal(ctx.session.deviceCode, "device-2");
  }
  // The same holds for a plain sign-in, which has no scope check to fall back on.
  {
    const plain: ToolContext = { session: new OnboardingSession(), endpointsOverride: { ingestEndpoint: INGEST } };
    plain.fetchImpl = scripted({
      "/api/device/code": DEVICE_CODE,
      "/api/device/token": () => {
        plain.session.deviceCode = "device-2";
        return [200, { api_key: ORG_KEY, ingest_endpoint: INGEST }];
      },
    }).fetchImpl;
    await callTool("authenticate", {}, plain);
    assert.equal((await callTool("auth_status", {}, plain)).status, "superseded");
    assert.equal(plain.session.hasKey(), false);
  }

  // A pasted key ends the pending authorization and its organization request.
  {
    const { ctx } = await start({ api_key: ORG_KEY, ingest_endpoint: INGEST, scope: scopeOf("org-a") });
    await callTool("get_ingest_key", { key: "cot_" + "pastedkeyendsauthorization01" }, ctx);
    assert.equal(ctx.session.pendingScope, null);
    assert.equal((await callTool("auth_status", {}, ctx)).status, "no_pending_auth");
  }
});

test("a key's ingest endpoint must come from CodeTelemetry once a model chose the server, and is never the string undefined", async () => {
  await withApiBaseEnv(undefined, async () => {
    const { fetchImpl } = scripted({
      "/api/device/code": DEVICE_CODE,
      "/api/device/token": { api_key: ORG_KEY, ingest_endpoint: "https://ingest.example.net" },
    });
    const ctx: ToolContext = { session: new OnboardingSession(), fetchImpl };
    await callTool("authenticate", { workspaceUrl: "https://acme.codetelemetry.com" }, ctx);
    const r = await callTool("auth_status", {}, ctx);
    assert.equal(r.error, "untrusted_ingest_endpoint");
    assert.equal(ctx.session.hasKey(), false);
  });
  const { fetchImpl } = scripted({ "/api/device/code": DEVICE_CODE, "/api/device/token": { api_key: ORG_KEY } });
  const ctx: ToolContext = { session: new OnboardingSession(), fetchImpl, endpointsOverride: { ingestEndpoint: INGEST } };
  await callTool("authenticate", {}, ctx);
  assert.equal((await callTool("auth_status", {}, ctx)).status, "authorized");
  assert.equal(ctx.session.ingestEndpoint, INGEST);
});

test("path names only a client config file in that client's own directory, and a host override outranks it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cot-path-"));
  const ctx: ToolContext = { session: new OnboardingSession() };
  ctx.session.setKey("cot_" + "configpathguardtestkey000001", "pasted");
  const refuse = async (client: string, target: string, message: RegExp) => {
    for (const tool of ["write_local_config", "onboard", "status"]) {
      const r = await callTool(tool, { client, path: target }, ctx);
      assert.equal(r.error, "bad_input", `${tool} must refuse ${client} path ${target.slice(0, 80)}`);
      assert.match(String(r.message), message, `${tool}: ${target.slice(0, 80)}`);
    }
  };
  const wrongPlace = /inside a \.(claude|codex) directory/;
  await refuse("claude", path.join(root, "notes.txt"), wrongPlace);
  await refuse("claude", path.join(root, ".vscode", "settings.json"), wrongPlace);
  await refuse("claude", "settings.json", wrongPlace);
  await refuse("claude", path.join(root, ".codex", "config.toml"), wrongPlace);
  await refuse("codex", path.join(root, ".claude", "settings.json"), wrongPlace);
  await refuse("codex", path.join(root, ".cargo", "config.toml"), wrongPlace);
  await refuse("claude", "   ", /non-empty string/);
  // Over the length cap even though it resolves to a valid file.
  await refuse("claude", root + "/" + "./".repeat(520) + ".claude/settings.json", /at most 1024 characters/);
  // Links, directories and oversized files in the right place are refused too.
  const linkDir = path.join(root, "linked", ".claude");
  fs.mkdirSync(linkDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.symlinkSync(path.join(root, "package.json"), path.join(linkDir, "settings.json"));
  await refuse("claude", path.join(linkDir, "settings.json"), /regular file/);
  fs.mkdirSync(path.join(root, "dir", ".claude", "settings.json"), { recursive: true });
  await refuse("claude", path.join(root, "dir", ".claude", "settings.json"), /regular file/);
  const big = path.join(root, "big", ".claude", "settings.json");
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(big, "{}" + " ".repeat(1024 * 1024));
  await refuse("claude", big, /at most 1048576 bytes/);
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), "{}\n", "the link target is untouched");

  // Windows network and device paths never pass, whatever their file name.
  for (const target of ["\\\\host\\share\\.claude\\settings.json", "//host/share/.claude/settings.json", "\\\\?\\C:\\x\\.claude\\settings.json"]) {
    const r = requestedConfigPath("claude", { path: target }, path.win32);
    assert.equal(r.ok, false, target);
    assert.match((r as { message: string }).message, /network or device path/);
  }
  assert.equal(requestedConfigPath("claude", { path: "C:\\Users\\me\\.claude\\settings.json" }, path.win32).ok, true);

  const local = path.join(root, "project", ".claude", "settings.local.json");
  assert.equal((await callTool("write_local_config", { path: local }, ctx)).path, local);
  assert.match(fs.readFileSync(local, "utf8"), /OTEL_EXPORTER_OTLP_ENDPOINT/);
  const codex = path.join(root, "codex", ".codex", "config.toml");
  assert.equal((await callTool("write_local_config", { client: "codex", path: codex }, ctx)).path, codex);
  assert.equal(((await callTool("status", { path: local }, ctx)).settings as { path: string }).path, local);
  assert.equal((await callTool("write_local_config", { path: "~/.claude/settings.json" }, ctx)).path, path.join(os.homedir(), ".claude", "settings.json"));
  // A relocated Claude config directory counts as the client's own.
  const custom = path.join(root, "custom-claude");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = custom;
  try {
    assert.equal((await callTool("write_local_config", { path: path.join(custom, "settings.json") }, ctx)).path, path.join(custom, "settings.json"));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }

  // The host's trusted override wins over the model's path, for writes and onboard alike.
  const pinned = path.join(root, "pinned", ".claude", "settings.json");
  const overridden = await callTool("write_local_config", { path: local }, { ...ctx, configPathsOverride: { claude: pinned } });
  assert.equal(overridden.path, pinned);
});

// ─── GitHub PR gate ───────────────────────────────────────────────────────────

function gateCtx(handler: (url: string, body: Record<string, unknown>, auth: string | null) => { status: number; body: unknown }) {
  const session = new OnboardingSession();
  session.setKey("cot_githubgatetoolkeykeykey0001", "pasted");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const ctx: ToolContext = {
    session,
    endpointsOverride: { apiBase: "https://example.test" },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      const answer = handler(url, body, headers.get("authorization"));
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    },
  };
  return { ctx, calls };
}

const GATE_VIEW = {
  config: { enabled: false, minScore: 70, missingScore: "pass", complexityAware: false },
  actions: { gateId: "G".repeat(22), workflow: { path: ".github/workflows/codetelemetry-pr-gate.yml", content: "name: CodeTelemetry PR gate" }, requiredCheck: { name: "codetelemetry/validation", appId: 15368, app: "GitHub Actions" } },
  nextSteps: ["Commit the workflow file"],
};

test("get_github_pr_gate returns the settings page's view, the settings link, and the GitHub how-to", async () => {
  const { ctx, calls } = gateCtx((_url, _body, auth) => {
    assert.equal(auth, "Bearer cot_githubgatetoolkeykeykey0001");
    return { status: 200, body: { ok: true, gate: GATE_VIEW } };
  });
  const result = await callTool("get_github_pr_gate", {}, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.gate, GATE_VIEW);
  assert.equal(result.settingsUrl, "https://example.test/app/integrations/github");
  assert.match(JSON.stringify(result.howTo), /Never ask the user for a GitHub token/);
  assert.deepEqual(calls.map((c) => c.url), ["https://example.test/api/agent/github-gate"]);
  assert.ok(!PLAINTEXT_KEY_RE.test(JSON.stringify(result)), "the key never reaches the model");
  const unauth = await callTool("get_github_pr_gate", {}, gateCtx(() => ({ status: 401, body: { error: "invalid or revoked key" } })).ctx);
  assert.deepEqual([unauth.ok, unauth.error], [false, "unauthenticated"]);
  const noKey = await callTool("get_github_pr_gate", {}, { session: new OnboardingSession() });
  assert.equal(noKey.error, "no_key");
});

test("configure_github_pr_gate sends only what was asked and passes the server's typed refusals through", async () => {
  const { ctx, calls } = gateCtx((_url, body) => body.minScore === 10
    ? { status: 403, body: { error: "requires_dashboard", message: "the gate is enforcing, so only a person can lower the minimum score — use the settings page" } }
    : body.enabled === true && !body.addRepositories
      ? { status: 409, body: { error: "not_ready", message: "add a repository first" } }
      : { status: 200, body: { ok: true, gate: { ...GATE_VIEW, config: { ...GATE_VIEW.config, enabled: true } } } });
  const ok = await callTool("configure_github_pr_gate", { addRepositories: [" octo/checkout-api "], enabled: true, minScore: 75 }, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], { url: "https://example.test/api/agent/github-gate/configure", body: { addRepositories: ["octo/checkout-api"], enabled: true, minScore: 75 } });
  assert.equal((ok.gate as typeof GATE_VIEW).config.enabled, true);
  const refused = await callTool("configure_github_pr_gate", { minScore: 10 }, ctx);
  assert.deepEqual([refused.ok, refused.error], [false, "requires_dashboard"]);
  assert.equal(refused.settingsUrl, "https://example.test/app/integrations/github", "a loosening refusal says where a person can make it");
  const early = await callTool("configure_github_pr_gate", { enabled: true }, ctx);
  assert.deepEqual([early.error, early.settingsUrl], ["not_ready", undefined]);
  const sent = calls.length;
  for (const bad of [{}, { minScore: 101 }, { minScore: 1.5 }, { missingScore: "maybe" }, { enabled: "yes" },
    { addRepositories: "octo/x" }, { addRepositories: Array.from({ length: 21 }, () => "octo/x") }, { removeRepositories: ["x"] }]) {
    const result = await callTool("configure_github_pr_gate", bad, ctx);
    assert.equal(result.error, "bad_input", JSON.stringify(bad));
  }
  assert.equal(calls.length, sent, "malformed input never reaches the server");
});
