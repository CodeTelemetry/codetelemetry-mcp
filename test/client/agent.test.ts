import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  estimateLinearIssue,
  findSimilarSessionErrors,
  getCostSignal,
  getHostHealth,
  getSessionPerformance,
  searchCodingSessions,
  type HostHealthReport,
  type LinearIssueSource,
  type TaskEffortEstimate,
} from "../../src/client/agent.ts";

const KEY = "cot_abcdefghijklmnopqrstuvwxyz012345";

function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

test("getCostSignal sends the key as a Bearer header and parses the cost", async () => {
  let gotAuth = "";
  const m = await startMock((req, res) => {
    gotAuth = String(req.headers.authorization || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, scope: "personal", cost: { observedCostUsd: 5, feeUsd: 0.5, byModel: [{ model: "claude-opus", observedCostUsd: 5 }], topRepo: "repo", asOf: "2026-06-13", note: "x" } }));
  });
  try {
    const r = await getCostSignal({ key: KEY, url: `${m.base}/api/agent/cost` });
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.cost?.observedCostUsd, 5);
    assert.equal(r.cost?.feeUsd, 0.5);
    assert.equal(gotAuth, `Bearer ${KEY}`);
  } finally {
    await m.close();
  }
});

test("non-2xx → ok:false, cost null", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid or revoked key" }));
  });
  try {
    const r = await getCostSignal({ key: KEY, url: `${m.base}/api/agent/cost` });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 401);
    assert.equal(r.cost, null);
  } finally {
    await m.close();
  }
});

test("a malformed key is rejected before any network call", async () => {
  await assert.rejects(() => getCostSignal({ key: "nope", url: "http://127.0.0.1:1/api/agent/cost" }), /valid CodeTelemetry ingest key/);
});

// ── The Linear issue types must mirror the wire, not wish for it ─────────────
// `estimateLinearIssue` is a pass-through: nothing validates the payload at
// runtime, so these types ARE the contract. A field declared here but never sent
// lets a consumer compile `result.source.description.length` and crash in
// production — which is exactly what happened when `source` stopped carrying the
// issue body. `npm run typecheck` compiles `test/`, so the @ts-expect-error below
// fails the build the moment the type drifts back.
function _linearIssueTypesMirrorTheWire(source: LinearIssueSource, estimate: TaskEffortEstimate) {
  // The bounded snapshot names WHICH issue was sized, never its body.
  const identity: [string, string, string] = [source.reference, source.identifier, source.normalizedText];
  // @ts-expect-error the route omits `source.description` outright — reading it
  // here must not compile, or the omission is invisible to a TypeScript caller.
  source.description;
  // The body rides here instead, capped, and says so — the docs point callers at
  // this field, so it has to exist with its truncation flags.
  const body: string | undefined = estimate.issueSource?.description;
  const chars: number | undefined = estimate.issueSource?.descriptionChars;
  const truncated: boolean | undefined = estimate.issueSource?.descriptionTruncated;
  return { identity, body, chars, truncated };
}

test("estimateLinearIssue relays the route's bounded issue snapshot", async () => {
  const wire = {
    ok: true,
    scope: "personal",
    estimate: {
      task: { text: "size an existing linear story", source: "issue", issueKey: "ELL-44", terms: ["linear"] },
      issueSource: {
        connectionId: "conn-acme",
        workspace: { id: "ws-acme", name: "Acme Inc", urlKey: "acme" },
        identifier: "ELL-44",
        url: "https://linear.app/acme/issue/ELL-44",
        title: "Add an MCP tool to estimate Linear issues",
        description: "a".repeat(4_000),
        descriptionChars: 12_000,
        descriptionTruncated: true,
        labels: ["mcp"],
        project: null,
        team: null,
        estimate: null,
      },
    },
    source: {
      reference: "ELL-44",
      connectionId: "conn-acme",
      workspace: { id: "ws-acme", name: "Acme Inc", urlKey: "acme" },
      identifier: "ELL-44",
      url: "https://linear.app/acme/issue/ELL-44",
      title: "Add an MCP tool to estimate Linear issues",
      labels: ["mcp"],
      project: null,
      team: null,
      estimate: null,
      normalizedText: "size an existing linear story",
    },
    performance: { totalMs: 10, queryMs: 5, readRows: 1, readBytes: 1 },
  };
  const m = await startMock((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(wire));
  });
  try {
    const r = await estimateLinearIssue({ key: KEY, url: `${m.base}/api/agent/linear-issue-size`, reference: "ELL-44" });
    assert.equal(r.ok, true);
    assert.equal(r.source?.identifier, "ELL-44");
    // One capped copy of the body reaches the caller, and the caller can tell it
    // was capped rather than treating a truncated body as the whole issue.
    assert.equal((r.source as unknown as Record<string, unknown>).description, undefined);
    assert.equal(r.estimate?.issueSource?.description.length, 4_000);
    assert.equal(r.estimate?.issueSource?.descriptionChars, 12_000);
    assert.equal(r.estimate?.issueSource?.descriptionTruncated, true);
  } finally {
    await m.close();
  }
});

test("session performance client sends bounded options and parses the report", async () => {
  let body = "";
  let auth = "";
  const m = await startMock((req, res) => {
    auth = String(req.headers.authorization || "");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, report: {
        sessionId: "session-a",
        present: true,
        eventCount: 8,
        samples: [{ cache: "hit", performance: { totalMs: 4.2 } }],
      } }));
    });
  });
  try {
    const result = await getSessionPerformance({
      key: KEY,
      url: `${m.base}/api/agent/session-performance`,
      sessionId: "session-a",
      includeFresh: true,
      cacheSamples: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.report?.eventCount, 8);
    assert.equal(auth, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(body), { sessionId: "session-a", includeFresh: true, cacheSamples: 3 });
  } finally {
    await m.close();
  }
});

test("similar errors client parses matches and query performance", async () => {
  let body = "";
  const m = await startMock((req, res) => {
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        report: { sessionId: "session-a", matches: [{ sessionId: "session-b", similarityPct: 90 }] },
        performance: { totalMs: 75, queryMs: 70, readRows: 1000 },
      }));
    });
  });
  try {
    const result = await findSimilarSessionErrors({
      key: KEY,
      url: `${m.base}/api/agent/similar-errors`,
      sessionId: "session-a",
      lookbackDays: 7,
      limit: 4,
    });
    assert.equal(result.ok, true);
    assert.equal(result.report?.matches[0].sessionId, "session-b");
    assert.equal(result.performance?.totalMs, 75);
    assert.deepEqual(JSON.parse(body), { sessionId: "session-a", lookbackDays: 7, limit: 4 });
  } finally {
    await m.close();
  }
});

test("similar errors client preserves model-safe read-limit guidance", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "read_limit_exceeded",
      message: "Similar-error scan exceeded its safety cap; retry with fewer lookbackDays.",
    }));
  });
  try {
    const result = await findSimilarSessionErrors({
      key: KEY,
      url: `${m.base}/api/agent/similar-errors`,
      sessionId: "session-a",
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 422);
    assert.equal(result.error, "read_limit_exceeded");
    assert.match(String(result.message), /fewer lookbackDays/);
  } finally {
    await m.close();
  }
});

test("session performance timeout returns a structured failure", async () => {
  const m = await startMock((_req, _res) => {
    // Intentionally leave the response pending until the client aborts.
  });
  try {
    const result = await getSessionPerformance({
      key: KEY,
      url: `${m.base}/api/agent/session-performance`,
      sessionId: "session-a",
      timeoutMs: 5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 0);
    assert.equal(result.error, "read_timeout");
    assert.match(String(result.message), /timed out/);
  } finally {
    await m.close();
  }
});

test("session search refuses a successful HTTP response without a decoded report", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not-json");
  });
  try {
    const result = await searchCodingSessions({
      key: KEY,
      url: `${m.base}/api/agent/session-search`,
      query: { q: "signadot" },
    });
    if (result.report) void result.report.results;
    assert.equal(result.ok, false);
    assert.equal(result.report, null);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.error, "read_unusable");
  } finally {
    await m.close();
  }
});

test("session search preserves the discriminated precedent report", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, report: { precedents: {
      mode: "lexical", degraded: true, reason: "embedding_unavailable", total: 0,
      limit: 10, offset: 0, hasMore: false, candidates: 0, lookbackDays: 30, hits: [],
    } } }));
  });
  try {
    const result = await searchCodingSessions({
      key: KEY,
      url: `${m.base}/api/agent/session-search`,
      query: { precedent: true, task: "different wording" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.report?.precedents.mode, "lexical");
  } finally {
    await m.close();
  }
});

test("session search propagates a timeout after response headers", async () => {
  let sawAbort = false;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          controller.error(signal.reason);
        }, { once: true });
      },
    });
    // Resolve the response immediately so this test exercises a stalled body,
    // independent of whether a busy runner can complete a loopback HTTP round
    // trip inside the deliberately tiny timeout.
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await searchCodingSessions({
    key: KEY,
    url: "https://control-plane.test/api/agent/session-search",
    query: { q: "signadot" },
    fetchImpl,
    timeoutMs: 5,
  });
  assert.equal(sawAbort, true);
  assert.equal(result.ok, false);
  assert.equal(result.report, null);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error, "read_timeout");
});

// ── Host health (ELL-19 read; the ELL-24 gate's only input) ──────────────────

test("getHostHealth omits lookbackMinutes when the caller does not narrow it", async () => {
  let body = "";
  let gotAuth = "";
  const m = await startMock((req, res) => {
    gotAuth = String(req.headers.authorization || "");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, scope: "personal", report: { hosts: [], policyVersion: "v1" } }));
    });
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health` });
    assert.equal(r.ok, true);
    assert.equal(r.report?.policyVersion, "v1");
    assert.equal(gotAuth, `Bearer ${KEY}`);
    // Materialising a fallback here would read as an EXPLICIT narrowing on the
    // server and cap signal validity at that many minutes, so a slow-scraping
    // collector would fall out of admission between scrapes.
    assert.deepEqual(JSON.parse(body), {});
  } finally {
    await m.close();
  }
});

test("a threshold override and an explicit lookback are forwarded verbatim", async () => {
  let body = "";
  const m = await startMock((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, report: null }));
    });
  });
  try {
    await getHostHealth({
      key: KEY,
      url: `${m.base}/api/agent/host-health`,
      lookbackMinutes: 5,
      thresholds: { staleAfterSec: 1800, offlineAfterSec: 6000 },
    });
    assert.deepEqual(JSON.parse(body), {
      lookbackMinutes: 5,
      thresholds: { staleAfterSec: 1800, offlineAfterSec: 6000 },
    });
  } finally {
    await m.close();
  }
});

test("a non-2xx never yields a report, even when the error body carries one", async () => {
  // Reading a report off a 4xx/5xx would let a rejected request supply capacity
  // evidence — the gate would then admit on a payload the server refused.
  const m = await startMock((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid host health input", report: { hosts: [{ instance: "x" }] } }));
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health` });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 400);
    assert.equal(r.report, null);
    assert.equal(r.error, "invalid host health input");
  } finally {
    await m.close();
  }
});

// ELL-49. The 503 pipeline-fault body is the ONLY place the storage/query hop is
// visible, so the diagnosis has to survive a non-2xx — unlike `report`, which
// must not. Suppressing both would leave an operator staring at "no known hosts"
// while ClickHouse was unconfigured.
test("a pipeline-fault 503 surfaces its hop without yielding a report", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "telemetry_pipeline_unavailable",
      stage: "storage",
      message: "ClickHouse is not configured for this deployment",
      diagnosis: {
        stage: "storage",
        detail: "ClickHouse is not configured for this deployment",
        hostFeedLastSeen: null,
        hostFeedLastSeenAgeSec: null,
        otherFeedsLastSeen: null,
        otherFeedsLastSeenAgeSec: null,
        horizonDays: null,
      },
    }));
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health` });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 503);
    assert.equal(r.report, null);
    assert.equal(r.error, "telemetry_pipeline_unavailable");
    assert.equal(r.diagnosis?.stage, "storage");
    // A 5xx is not a shape fault: the gate must retry it, not exit 1.
    assert.equal(r.reportUnusable, null);
  } finally {
    await m.close();
  }
});

test("an empty fleet carries the server's own status and hop, not an inferred one", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      status: "no_hosts",
      report: null,
      diagnosis: {
        stage: "collector",
        detail: "no host collector is enrolled",
        hostFeedLastSeen: null,
        hostFeedLastSeenAgeSec: null,
        otherFeedsLastSeen: "2026-07-26 12:00:00",
        otherFeedsLastSeenAgeSec: 30,
        horizonDays: 30,
      },
    }));
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health` });
    assert.equal(r.ok, true);
    assert.equal(r.report, null);
    assert.equal(r.status, "no_hosts");
    assert.equal(r.diagnosis?.stage, "collector");
    assert.equal(r.diagnosis?.otherFeedsLastSeenAgeSec, 30);
    // Still the documented EMPTY result, so the gate keeps deferring retryably.
    assert.equal(r.reportUnusable, null);
  } finally {
    await m.close();
  }
});

// A pre-ELL-49 deployment sends neither field. They must read as absent rather
// than being inferred from `report === null` — that inference IS the conflation.
test("a server that sends no diagnosis leaves status and diagnosis null", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, scope: "personal", report: null }));
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health` });
    assert.equal(r.ok, true);
    assert.equal(r.status, null);
    assert.equal(r.diagnosis, null);
    assert.equal(r.reportUnusable, null);
  } finally {
    await m.close();
  }
});

test("a malformed diagnosis degrades to null instead of throwing", async () => {
  const m = await startMock((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      status: 7,                              // not a string
      report: null,
      diagnosis: { detail: "no stage member" }, // no usable stage
    }));
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health` });
    assert.equal(r.status, null);
    assert.equal(r.diagnosis, null);
    // The read a dispatcher depends on must not throw over operator-facing text.
    assert.equal(r.ok, true);
  } finally {
    await m.close();
  }
});

test("an unreachable control plane resolves as a failure instead of throwing", async () => {
  // A dispatcher must not crash because the control plane blinked: the gate can
  // only turn this into a defer if it is a value, not an exception.
  const r = await getHostHealth({ key: KEY, url: "http://127.0.0.1:1/api/agent/host-health" });
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 0);
  assert.equal(r.error, "read_unavailable");
  assert.equal(r.report, null);
});

test("a host-health timeout is reported as one", async () => {
  const m = await startMock((_req, _res) => {
    // Leave the response pending until the client aborts.
  });
  try {
    const r = await getHostHealth({ key: KEY, url: `${m.base}/api/agent/host-health`, timeoutMs: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "read_timeout");
    assert.equal(r.report, null);
  } finally {
    await m.close();
  }
});

// The host-health types must mirror the wire, not wish for it. `getHostHealth`
// is a pass-through, so these types ARE the contract — and the read deliberately
// WITHHOLDS the identifying dimensions it groups on. Declaring one here would
// let a consumer compile a read of something that is never sent, and would
// quietly invite it into the gate's decision records.
function _hostHealthTypesMirrorTheWire(report: HostHealthReport) {
  const h = report.hosts[0];
  const identity: [string, string | null, string | null] = [h.instance, h.host, h.environment];
  // @ts-expect-error the read never echoes a filesystem device or mount point —
  // it groups on them and emits only the worst-volume fraction.
  h.signals.fsDevice;
  // @ts-expect-error process identity is a presence LIST; a pid is never echoed.
  h.signals.agentd.pid;
  const present: string[] = h.signals.codingAgentsPresent;
  // Both policy versions the gate records come from here.
  const versions: [string, number] = [report.policyVersion, report.signalMaxAgeSec];
  return { identity, present, versions };
}
