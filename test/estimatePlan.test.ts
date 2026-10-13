// The estimate_plan MCP tool — how it normalizes plain text and
// structured steps into the sizing contract, the wire body it sends, the shared
// result schema plus source metadata it returns, low-confidence pass-through,
// input validation, unauthenticated refusal, upstream failures, and the
// no-plaintext-key invariant.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";

const KEY = "cot_" + "planestimatetestplanestimate01";
const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;

const HIGH = {
  task: { text: "Migrate the schema", source: "text", issueKey: null, terms: ["migrat", "schema"] },
  sizingRequestId: "sr_plan000000000000000000000000",
  size: "L",
  range: { minTokens: 150_000, maxTokens: 400_000 },
  tokens: { point: 210_000, low: 160_000, high: 320_000 },
  basis: "matched",
  sampleCount: 6,
  confidence: { band: "high", ladder: "high", similarity: 0.9, evidence: 1, corpus: 0.8, agreement: 0.6, reasons: [] },
  matches: [{ sessionId: "s1", kind: "session", title: "Migrate the ClickHouse schema", useCase: "database migration", similarityPct: 88, totalTokens: 210_000, lastSeen: "2026-07-01T00:00:00Z" }],
  model: { rulesVersion: "2026-07-20.v1", cohortKey: "category=database migration", cohortSampleSize: 31, observationCount: 42 },
  evidence: { lookbackDays: 90, sessions: 40, describedSessions: 31 },
  linearEstimate: null,
  calibrationTask: null,
};

const LOW = {
  ...HIGH,
  sizingRequestId: "sr_planlowlowlowlowlowlowlowlow",
  size: "M",
  confidence: { band: "low", ladder: "low", similarity: 0.2, evidence: 0.1, corpus: 0.2, agreement: 0.3, reasons: ["no close match"] },
  matches: [],
  basis: "corpus-median",
  calibrationTask: {
    kind: "spike", size: "S", title: "Timebox a spike", question: "How big is the migration?",
    targetSignal: "similarity", why: "no close match", steps: ["ship the smallest slice"],
    expectedEvidence: "one comparable session", exitCriteria: ["a datapoint exists"],
    expectedImprovement: "raises similarity", expectedTokens: 40_000,
    sizingRequestId: "sr_planlowlowlowlowlowlowlowlow", markdown: "# spike", signature: "sig",
  },
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
        if (body.lookbackDays === 365) {
          res.statusCode = 422;
          return res.end(JSON.stringify({
            error: "read_limit_exceeded",
            message: "Sizing history scan exceeded its safety cap; retry with fewer lookbackDays.",
          }));
        }
        const estimate = String(body.taskText || "").includes("LOWCONF") ? LOW : HIGH;
        res.statusCode = 200;
        return res.end(JSON.stringify({
          ok: true,
          scope: "personal",
          estimate,
          performance: { totalMs: 90, queryMs: 84, readRows: 5_000, readBytes: 90_000 },
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

test("estimate_plan sizes text and structured steps and never leaks the key", async () => {
  const mock = await startMock();
  const session = new OnboardingSession();
  session.setKey(KEY, "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: mock.base, ingestEndpoint: mock.base } };
  try {
    // Plain text.
    const text = await callTool("estimate_plan", { planText: "Migrate the schema" }, ctx);
    assert.equal(text.ok, true);
    assert.deepEqual((text.estimate as typeof HIGH).tokens, HIGH.tokens);
    assert.equal((text.source as { format: string }).format, "text");
    assert.match(String(text.note), /token effort/i);
    assert.match(String(text.note), /not elapsed time or human engineering hours/i);
    assert.deepEqual(mock.requests.at(-1)!.body, { taskText: "Migrate the schema" });

    // Structured steps + repo/project/model context. Only repo reaches the wire;
    // project/model are echoed in source metadata as provenance.
    const steps = await callTool("estimate_plan", {
      title: "Schema work",
      steps: [{ title: "Migrate", detail: "move tables" }, "backfill rows"],
      repo: "acme-api",
      project: "CodeTelemetry",
      provider: "claude",
      model: "claude-opus-4-8",
    }, ctx);
    assert.equal(steps.ok, true);
    const src = steps.source as { format: string; stepCount: number; repo: string; project: string; provider: string; model: string; steps: { index: number }[] };
    assert.equal(src.format, "steps");
    assert.equal(src.stepCount, 2);
    assert.equal(src.repo, "acme-api");
    assert.equal(src.project, "CodeTelemetry");
    assert.equal(src.provider, "claude");
    assert.equal(src.model, "claude-opus-4-8");
    assert.deepEqual(src.steps.map((s) => s.index), [1, 2]);
    const sent = mock.requests.at(-1)!;
    assert.equal(sent.path, "/api/agent/task-size");
    assert.equal(sent.auth, `Bearer ${KEY}`);
    assert.equal(Object.prototype.hasOwnProperty.call(sent.body, "project"), false, "project is provenance, not a sizing field");
    assert.equal(Object.prototype.hasOwnProperty.call(sent.body, "model"), false, "model is provenance, not a sizing field");
    assert.equal(sent.body.repo, "acme-api");
    assert.match(String(sent.body.taskText), /Schema work\n\nPlan steps:\n1\. Migrate: move tables\n2\. backfill rows/);

    // Low-confidence result passes through intact, calibration task included.
    const low = await callTool("estimate_plan", { planText: "LOWCONF novel work" }, ctx);
    assert.equal(low.ok, true);
    assert.equal((low.estimate as typeof LOW).confidence.band, "low");
    assert.equal((low.estimate as typeof LOW).calibrationTask?.size, "S");

    // Upstream sizing failure surfaces as an actionable read_failed.
    const capped = await callTool("estimate_plan", { planText: "Big migration", lookbackDays: 365 }, ctx);
    assert.equal(capped.ok, false);
    assert.equal(capped.error, "read_failed");
    assert.match(String(capped.message), /safety cap/);

    const beforeInvalid = mock.requests.length;
    for (const args of [
      {},
      { title: "only a title" },
      { steps: [] },
      { planText: "" },
      { planText: 7 },
      { steps: "not an array" },
      { steps: [{}] },
      { steps: [{ title: "", detail: "" }] },
      { planText: "x", provider: "cursor" },
      { planText: "x", repo: 7 },
      { planText: "x", lookbackDays: 0 },
      { planText: "x", limit: 99_999 },
      { planText: "a".repeat(2_500), steps: ["a".repeat(2_500)] },
    ] as Record<string, unknown>[]) {
      const bad = await callTool("estimate_plan", args, ctx);
      assert.equal(bad.ok, false, `rejects ${JSON.stringify(args).slice(0, 50)}`);
      assert.equal(bad.error, "bad_input");
    }
    // Rejected calls never reach the backend.
    assert.equal(mock.requests.length, beforeInvalid);

    for (const result of [text, steps, low, capped]) {
      assert.doesNotMatch(JSON.stringify(result), PLAINTEXT_KEY_RE);
    }
  } finally {
    await mock.close();
  }
});

test("estimate_plan refuses before a key exists", async () => {
  const result = await callTool("estimate_plan", { planText: "Anything" }, {
    session: new OnboardingSession(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_key");
});
