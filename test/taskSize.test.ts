// The estimate_task_size MCP tool — argument validation, the wire body it
// sends for a Linear-shaped issue, and the model-safe result it returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";

const KEY = "cot_" + "tasksizetesttasksizetest000001";
const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;

const ESTIMATE = {
  task: { text: "Migrate the schema", source: "issue", issueKey: "ELL-8", terms: ["migrat", "schema"] },
  sizingRequestId: "sr_abc123def456abc123def456",
  size: "L",
  range: { minTokens: 150_000, maxTokens: 400_000 },
  tokens: { point: 210_000, low: 160_000, high: 320_000 },
  basis: "matched",
  sampleCount: 6,
  confidence: { band: "high", ladder: "high", similarity: 0.9, evidence: 1, corpus: 0.8, agreement: 0.6, reasons: [] },
  matches: [{ sessionId: "s1", kind: "session", title: "Migrate the ClickHouse schema", useCase: "database migration", similarityPct: 88, totalTokens: 210_000, lastSeen: "2026-07-01T00:00:00Z" }],
  model: { rulesVersion: "2026-07-20.v1", cohortKey: "category=database migration", cohortSampleSize: 31, observationCount: 42 },
  evidence: { lookbackDays: 90, sessions: 40, describedSessions: 31 },
  // The server's real projection shape: `value` alone is ambiguous across
  // scales, so scale/extended/size ride with it.
  linearEstimate: { scale: "fibonacci", extended: false, value: 5, label: "5", size: "L" },
  calibrationTask: null,
};

function startMock(): Promise<{
  base: string;
  close: () => Promise<void>;
  requests: { path: string; auth: string; body: Record<string, unknown> }[];
}> {
  const requests: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const path = req.url || "";
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        requests.push({ path, auth: String(req.headers.authorization || ""), body });
        res.setHeader("content-type", "application/json");
        if (path !== "/api/agent/task-size") {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "not found" }));
        }
        if (body.issueKey === "NOCONN-1") {
          // How the API reports a Linear-connection failure: the actionable text
          // is in `error` (with a `code`), and there is no `message`.
          res.statusCode = 409;
          return res.end(JSON.stringify({
            error: "Linear rejected this connection — reconnect the workspace",
            code: "needs_reconnect",
          }));
        }
        if (body.taskText === "SLOW") {
          // The server's own read budget ran out. Typed, and carrying
          // advice the fixed client-side string does not have.
          res.statusCode = 504;
          return res.end(JSON.stringify({
            error: "read_timeout",
            message: "Sizing history read took too long and was stopped. Retry — a concurrent"
              + " read may have already warmed the history — and if it keeps timing out, retry"
              + " with fewer lookbackDays.",
          }));
        }
        if (body.lookbackDays === 365) {
          res.statusCode = 422;
          return res.end(JSON.stringify({
            error: "read_limit_exceeded",
            message: "Sizing history scan exceeded its safety cap; retry with fewer lookbackDays.",
          }));
        }
        res.statusCode = 200;
        return res.end(JSON.stringify({
          ok: true,
          scope: "personal",
          estimate: ESTIMATE,
          performance: {
            totalMs: 90,
            queryMs: 0,
            queryCount: 0,
            readRows: 0,
            readBytes: 0,
            resultBytes: 0,
            targetMs: 2_000,
            meetsTarget: true,
            phases: [],
            // The cache decision and the cold-path budget ride along.
            cache: "hit",
            coldTargetMs: 5_000,
            meetsColdTarget: true,
          },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("estimate_task_size sizes an issue and never leaks the key", async () => {
  const mock = await startMock();
  const session = new OnboardingSession();
  session.setKey(KEY, "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: mock.base, ingestEndpoint: mock.base } };
  try {
    const ok = await callTool("estimate_task_size", {
      issue: { identifier: "ELL-8", title: "T-shirt size", description: "Estimate effort", labels: ["sizing"] },
      lookbackDays: 60,
    }, ctx);
    assert.equal(ok.ok, true);
    assert.deepEqual((ok.estimate as typeof ESTIMATE).tokens, ESTIMATE.tokens);
    assert.equal((ok.estimate as typeof ESTIMATE).confidence.band, "high");
    // Codex P2: the client type exposed only value+label, so a consumer could not
    // tell WHICH scale produced the number — worst in the issueKey flow, where
    // the server picks the scale from the issue's team.
    assert.deepEqual((ok.estimate as typeof ESTIMATE).linearEstimate, ESTIMATE.linearEstimate,
      "the resolved scale reaches the caller intact");

    const sent = mock.requests.at(-1)!;
    assert.equal(sent.path, "/api/agent/task-size");
    assert.equal(sent.auth, `Bearer ${KEY}`);
    assert.deepEqual(sent.body, {
      issue: { identifier: "ELL-8", title: "T-shirt size", description: "Estimate effort", labels: ["sizing"] },
      lookbackDays: 60,
    });

    // The server's safety cap surfaces as an actionable failure, not a crash.
    // issueKey alone is sizeable: the server resolves it through the tenant's
    // Linear connection, so the tool need not relay the issue's fields.
    const byKey = await callTool("estimate_task_size", { issueKey: "ELL-8", repo: "acme-api" }, ctx);
    assert.equal(byKey.ok, true);
    assert.deepEqual(mock.requests.at(-1)!.body, { issueKey: "ELL-8", repo: "acme-api" });

    // Codex P2: a label-only issue carries usable matching terms and the API
    // accepts it, so the tool's emptiness preflight must not reject it.
    const labelsOnly = await callTool("estimate_task_size", { issue: { labels: ["database", "migration"] } }, ctx);
    assert.equal(labelsOnly.ok, true, "a label-only issue is sizeable");
    assert.deepEqual(mock.requests.at(-1)!.body, { issue: { labels: ["database", "migration"] } });

    const capped = await callTool("estimate_task_size", { taskText: "Big migration", lookbackDays: 365 }, ctx);
    assert.equal(capped.ok, false);
    assert.equal(capped.error, "read_failed");

    // Codex P2: a Linear-connection failure puts its explanation in `error` and
    // sends no `message`. Falling straight through to the HTTP status would strip
    // the one thing telling the caller whether to connect, reconnect, or retry.
    const noConn = await callTool("estimate_task_size", { issueKey: "NOCONN-1" }, ctx);
    assert.equal(noConn.ok, false);
    assert.match(String(noConn.message), /reconnect the workspace/,
      "the backend explanation survives into the tool result");
    assert.doesNotMatch(String(noConn.message), /HTTP 409/,
      "…instead of a bare status the caller cannot act on");

    for (const args of [
      {},
      { issue: { identifier: "ELL-8" } },
      { taskText: 7 },
      { taskText: "x", lookbackDays: 0 },
      { taskText: "x", limit: 99_999 },
      { taskText: "x", issue: { labels: ["ok", 7] } },
      { taskText: "x", linearScale: "story-points" },
      { taskText: "x", repo: 7 },
      { issueKey: "" },
    ] as Record<string, unknown>[]) {
      const bad = await callTool("estimate_task_size", args, ctx);
      assert.equal(bad.ok, false, `rejects ${JSON.stringify(args)}`);
      assert.equal(bad.error, "bad_input");
    }
    // Rejected calls never reach the backend.
    assert.equal(mock.requests.length, 5);

    for (const result of [ok, byKey, labelsOnly, capped, noConn]) {
      assert.doesNotMatch(JSON.stringify(result), PLAINTEXT_KEY_RE);
    }
  } finally {
    await mock.close();
  }
});

test("estimate_task_size relays a server-side read timeout, and the cache status", async () => {
  const mock = await startMock();
  const session = new OnboardingSession();
  session.setKey(KEY, "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: mock.base, ingestEndpoint: mock.base } };
  try {
    // A 504 is a TIMEOUT, not a generic read failure, and the model has
    // to be able to tell them apart — a timeout is worth retrying (the failed
    // attempt may well have warmed the shared corpus), a read_failed usually is
    // not. Relaying the fixed client-side string instead would have told the
    // caller to shrink a window that was never the problem.
    const slow = await callTool("estimate_task_size", { taskText: "SLOW" }, ctx);
    assert.equal(slow.ok, false);
    assert.equal(slow.error, "read_timeout");
    assert.match(String(slow.message), /Retry/,
      "the server's own advice reaches the model, not a fixed fallback");

    // A successful read reports which path served it, so a caller (and a probe)
    // can tell a warm request from a cold one.
    const ok = await callTool("estimate_task_size", { taskText: "Add CSV export" }, ctx);
    assert.equal(ok.ok, true);
    const perf = ok.performance as { cache?: string; meetsTarget?: boolean; meetsColdTarget?: boolean; queryCount?: number };
    assert.equal(perf.cache, "hit");
    assert.equal(perf.queryCount, 0, "a warm read did no ClickHouse work");
    assert.equal(perf.meetsTarget, true);
    assert.equal(perf.meetsColdTarget, true);

    for (const result of [slow, ok]) {
      assert.doesNotMatch(JSON.stringify(result), PLAINTEXT_KEY_RE);
    }
  } finally {
    await mock.close();
  }
});

test("estimate_task_size refuses before a key exists", async () => {
  const result = await callTool("estimate_task_size", { taskText: "Anything" }, {
    session: new OnboardingSession(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_key");
});
