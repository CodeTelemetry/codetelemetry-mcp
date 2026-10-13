// The estimate_linear_issue MCP tool — URL and identifier lookup, the
// wire body it sends, connection disambiguation, the typed refusal vocabulary it
// passes through, and the model-safe result it returns.
//
// The invariants under test: the tool never sends a Linear credential (only a
// reference plus hints), the plaintext ingest key never reaches a result, and a
// refusal keeps the code the caller must branch on instead of collapsing every
// failure into one opaque read error.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";

const KEY = "cot_" + "linearissuelinearissue000001";
const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;

const DESCRIPTION = "Size an existing Linear story without copying it into a prompt.";

/** Mirrors the route's `source`: the bounded snapshot only. The issue's
 *  `description` is deliberately absent — it is unbounded, it already rides on
 *  `estimate.issueSource`, and every tool result is serialized twice (text and
 *  structuredContent), so a second copy would cost the caller four. */
const SOURCE = {
  reference: "ELL-44",
  connectionId: "conn-acme",
  workspace: { id: "ws-acme", name: "Acme Inc", urlKey: "acme" },
  identifier: "ELL-44",
  url: "https://linear.app/acme/issue/ELL-44",
  title: "Add an MCP tool to estimate Linear issues",
  labels: ["mcp", "sizing"],
  project: { id: "proj-1", name: "Agent surface" },
  team: { id: "team-1", key: "ELL", name: "Engineering" },
  estimate: null,
  normalizedText: "add an mcp tool to estimate linear issues size an existing linear story",
};

const ISSUE_SOURCE = {
  connectionId: SOURCE.connectionId,
  workspace: SOURCE.workspace,
  identifier: SOURCE.identifier,
  url: SOURCE.url,
  title: SOURCE.title,
  // Capped by the route (MAX_AGENT_ISSUE_BODY) and flagged, so a caller never
  // mistakes a prefix for the whole issue.
  description: DESCRIPTION,
  descriptionChars: DESCRIPTION.length,
  descriptionTruncated: false,
  labels: SOURCE.labels,
  project: SOURCE.project,
  team: SOURCE.team,
  estimate: SOURCE.estimate,
};

const ESTIMATE = {
  issueSource: ISSUE_SOURCE,
  task: { text: SOURCE.normalizedText, source: "issue", issueKey: "ELL-44", terms: ["mcp", "estimat"] },
  sizingRequestId: "sr_ell44ell44ell44ell44ell4",
  size: "M",
  range: { minTokens: 40_000, maxTokens: 120_000 },
  tokens: { point: 70_000, low: 40_000, high: 120_000 },
  basis: "matched",
  sampleCount: 5,
  confidence: { band: "medium", ladder: "medium", similarity: 0.7, evidence: 0.6, corpus: 0.6, agreement: 0.6, reasons: [] },
  matches: [{ sessionId: "s1", kind: "session", title: "Add a sizing tool", useCase: "feature work", similarityPct: 71, totalTokens: 68_000, lastSeen: "2026-07-20T00:00:00Z" }],
  model: { rulesVersion: "2026-07-20.v1", cohortKey: "global", cohortSampleSize: 20, observationCount: 30 },
  evidence: { lookbackDays: 90, sessions: 30, describedSessions: 20 },
  linearEstimate: { scale: "fibonacci", extended: false, value: 3, label: "3", size: "M" },
  calibrationTask: null,
};

/** Low confidence: no size, and a calibration task instead of a bluffed number. */
const LOW_CONFIDENCE = {
  ...ESTIMATE,
  size: null,
  range: null,
  basis: "none",
  sampleCount: 0,
  tokens: { point: 0, low: 0, high: 0 },
  confidence: { ...ESTIMATE.confidence, band: "low", ladder: "low", reasons: ["Nothing in the window resembles this issue."] },
  matches: [],
  calibrationTask: {
    kind: "spike",
    size: "XS",
    title: "Describe two comparable sessions",
    question: "What does work like ELL-44 actually cost here?",
    targetSignal: "evidence",
    why: "Nothing in the window resembles this issue.",
    steps: ["Label two recent sessions"],
    expectedEvidence: "Two described sessions",
    exitCriteria: ["Two sessions carry a use case"],
    expectedImprovement: "Raises the evidence signal",
    expectedTokens: 20_000,
    sizingRequestId: "sr_ell44ell44ell44ell44ell4",
    markdown: "# Describe two comparable sessions",
    signature: "sig-abc",
  },
};

const CANDIDATES = [
  { connectionId: "conn-acme", workspace: { id: "ws-acme", name: "Acme Inc", urlKey: "acme" }, isDefault: true, status: "connected" },
  { connectionId: "conn-globex", workspace: { id: "ws-globex", name: "Globex", urlKey: "globex" }, isDefault: false, status: "connected" },
];

type Recorded = { path: string; auth: string; body: Record<string, unknown> };

/** A stand-in for POST /api/agent/linear-issue-size that answers by reference,
 *  mirroring the real route's status + typed-error pairs. */
function startMock(): Promise<{ base: string; close: () => Promise<void>; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const path = req.url || "";
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        requests.push({ path, auth: String(req.headers.authorization || ""), body });
        res.setHeader("content-type", "application/json");
        if (path !== "/api/agent/linear-issue-size") {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "not found" }));
        }
        const reference = String(body.reference ?? "");
        const reply = (status: number, payload: Record<string, unknown>) => {
          res.statusCode = status;
          return res.end(JSON.stringify(payload));
        };
        if (reference === "AMBIG-1" && !body.workspace && !body.connectionId) {
          return reply(409, {
            error: "ambiguous_connection",
            message: 'several Linear connections could resolve this issue — name one with connectionId or workspace: "acme", "globex"',
            connections: CANDIDATES,
          });
        }
        if (reference === "NOCONN-1") {
          return reply(404, {
            error: "no_connected_workspace",
            message: "no Linear workspace is connected to CodeTelemetry — connect one in Settings → Integrations",
            connections: [],
          });
        }
        if (reference === "GONE-1") {
          return reply(404, {
            error: "issue_not_found",
            message: "Linear issue GONE-1 was not found in the connected workspace — it may not exist,"
              + " or the connected credential may not be able to see it. Check the identifier, or"
              + " connect a workspace that can see it.",
          });
        }
        if (reference === "LOCKED-1") {
          return reply(403, {
            error: "issue_inaccessible",
            code: "insufficient_capabilities",
            message: "this Linear connection is missing required permissions: read",
            missing: ["read"],
          });
        }
        if (reference === "STALE-1") {
          return reply(409, {
            error: "connection_needs_reconnect",
            code: "needs_reconnect",
            message: "Linear rejected this connection — reconnect the workspace",
          });
        }
        if (reference === "EMPTY-1") {
          return reply(400, { error: "empty_issue", message: "That Linear issue has no title, description, or labels to size." });
        }
        if (reference === "SLOW-1") {
          return reply(422, { error: "read_limit_exceeded", message: "Sizing history scan exceeded its safety cap; retry with fewer lookbackDays." });
        }
        if (reference === "BOOM-1") {
          return reply(500, { error: "internal error" });
        }
        if (reference === "REVOKED-1") {
          return reply(401, { error: "invalid or revoked key" });
        }
        if (reference === "FAST-1") {
          return reply(429, { error: "rate limit exceeded" });
        }
        const estimate = reference === "LOW-1" ? LOW_CONFIDENCE : ESTIMATE;
        return reply(200, {
          ok: true,
          scope: "personal",
          estimate,
          source: { ...SOURCE, reference },
          performance: { totalMs: 120, queryMs: 100, readRows: 4_000, readBytes: 80_000 },
        });
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

function withKey(base: string): ToolContext {
  const session = new OnboardingSession();
  session.setKey(KEY, "pasted");
  return { session, endpointsOverride: { apiBase: base, ingestEndpoint: base } };
}

test("estimate_linear_issue sizes an issue by identifier and by URL", async () => {
  const mock = await startMock();
  const ctx = withKey(mock.base);
  try {
    const byKey = await callTool("estimate_linear_issue", { reference: "ELL-44", repo: "acme-api", lookbackDays: 60 }, ctx);
    assert.equal(byKey.ok, true);
    assert.equal((byKey.estimate as typeof ESTIMATE).size, "M");
    assert.deepEqual((byKey.estimate as typeof ESTIMATE).linearEstimate, ESTIMATE.linearEstimate,
      "the scale the server resolved from the issue's team reaches the caller intact");

    const sent = mock.requests.at(-1)!;
    assert.equal(sent.path, "/api/agent/linear-issue-size");
    assert.equal(sent.auth, `Bearer ${KEY}`);
    // Only a reference and sizing knobs cross the wire — never a Linear token,
    // and never the issue's contents (the server reads those itself).
    assert.deepEqual(sent.body, { reference: "ELL-44", repo: "acme-api", lookbackDays: 60 });

    // A pasted URL is passed through verbatim; the server parses it, so the tool
    // has no second URL grammar that could drift from the page's.
    const url = "https://linear.app/acme/issue/ELL-44/add-an-mcp-tool";
    const byUrl = await callTool("estimate_linear_issue", { reference: url }, ctx);
    assert.equal(byUrl.ok, true);
    assert.deepEqual(mock.requests.at(-1)!.body, { reference: url });
    assert.equal((byUrl.source as typeof SOURCE).reference, url);

    // The source snapshot: what was sized, from which workspace, and the exact
    // normalized text the estimate was built from.
    const source = byKey.source as typeof SOURCE;
    assert.equal(source.identifier, "ELL-44");
    assert.equal(source.url, "https://linear.app/acme/issue/ELL-44");
    assert.deepEqual(source.workspace, { id: "ws-acme", name: "Acme Inc", urlKey: "acme" });
    assert.equal(source.title, SOURCE.title);
    assert.deepEqual(source.labels, ["mcp", "sizing"]);
    assert.equal(source.normalizedText, SOURCE.normalizedText);
    // The issue's unbounded body reaches the caller exactly ONCE — on the
    // estimate, not duplicated into `source` — so a long Linear description
    // can't be amplified fourfold by the text/structuredContent double encode.
    assert.equal((source as Record<string, unknown>).description, undefined);
    assert.equal((byKey.estimate as typeof ESTIMATE).issueSource.description, DESCRIPTION);
    const encoded = JSON.stringify(byKey);
    assert.equal(encoded.split(DESCRIPTION).length - 1, 1,
      "the description appears once in the tool result, not once per snapshot");
    assert.match(String(byKey.note), /token effort/i);
    assert.match(String(byKey.note), /Read-only/i);

    // Surrounding whitespace is trimmed rather than rejected.
    await callTool("estimate_linear_issue", { reference: "  ELL-44  " }, ctx);
    assert.deepEqual(mock.requests.at(-1)!.body, { reference: "ELL-44" });

    for (const result of [byKey, byUrl]) {
      assert.doesNotMatch(JSON.stringify(result), PLAINTEXT_KEY_RE);
    }
  } finally {
    await mock.close();
  }
});

test("estimate_linear_issue forwards workspace and connection hints", async () => {
  const mock = await startMock();
  const ctx = withKey(mock.base);
  try {
    const named = await callTool("estimate_linear_issue", {
      reference: "AMBIG-1",
      workspace: "globex",
      linearScale: "fibonacci",
      linearScaleExtended: false,
      limit: 500,
    }, ctx);
    assert.equal(named.ok, true, "naming a workspace resolves the ambiguity");
    assert.deepEqual(mock.requests.at(-1)!.body, {
      reference: "AMBIG-1",
      workspace: "globex",
      linearScale: "fibonacci",
      linearScaleExtended: false,
      limit: 500,
    });

    const byConnection = await callTool("estimate_linear_issue", {
      reference: "AMBIG-1",
      connectionId: "conn-globex",
    }, ctx);
    assert.equal(byConnection.ok, true);
    assert.deepEqual(mock.requests.at(-1)!.body, { reference: "AMBIG-1", connectionId: "conn-globex" });
  } finally {
    await mock.close();
  }
});

test("estimate_linear_issue returns an actionable ambiguity, not a generic failure", async () => {
  const mock = await startMock();
  const ctx = withKey(mock.base);
  try {
    const ambiguous = await callTool("estimate_linear_issue", { reference: "AMBIG-1" }, ctx);
    assert.equal(ambiguous.ok, false);
    // The code is what an agent branches on; the candidate list is what it needs
    // to retry without asking the human to go look up connection ids.
    assert.equal(ambiguous.error, "ambiguous_connection");
    assert.deepEqual(ambiguous.connections, CANDIDATES);
    assert.match(String(ambiguous.message), /"acme", "globex"/);
    // Each candidate is relayed with exactly the four fields of the server's
    // projection — nothing the tool adds, and nothing wider than what it was
    // given. (That the PROJECTION excludes account identity is the server's
    // invariant, asserted field-for-field in api/test/linearIssueSizing.test.ts;
    // asserting it again against this mock's own fixture would only restate the
    // fixture.)
    for (const candidate of ambiguous.connections as Record<string, unknown>[]) {
      assert.deepEqual(
        Object.keys(candidate).sort(),
        ["connectionId", "isDefault", "status", "workspace"],
      );
    }
    assert.doesNotMatch(JSON.stringify(ambiguous), PLAINTEXT_KEY_RE);

    const none = await callTool("estimate_linear_issue", { reference: "NOCONN-1" }, ctx);
    assert.equal(none.error, "no_connected_workspace");
    assert.match(String(none.message), /connect one/i);
  } finally {
    await mock.close();
  }
});

test("estimate_linear_issue keeps each failure's own code", async () => {
  const mock = await startMock();
  const ctx = withKey(mock.base);
  try {
    // Every one of these implies a DIFFERENT next action, so none may collapse
    // into a single opaque read failure.
    for (const [reference, error] of [
      ["GONE-1", "issue_not_found"],
      ["LOCKED-1", "issue_inaccessible"],
      ["STALE-1", "connection_needs_reconnect"],
      ["EMPTY-1", "empty_issue"],
      ["SLOW-1", "read_limit_exceeded"],
      ["REVOKED-1", "unauthenticated"],
      ["FAST-1", "rate_limited"],
      // An unmapped server failure stays honest rather than claiming a cause.
      ["BOOM-1", "sizing_failed"],
    ] as [string, string][]) {
      const result = await callTool("estimate_linear_issue", { reference }, ctx);
      assert.equal(result.ok, false, reference);
      assert.equal(result.error, error, reference);
      assert.ok(String(result.message).length > 0, `${reference} carries a message`);
      assert.doesNotMatch(JSON.stringify(result), PLAINTEXT_KEY_RE);
    }
    // `issue_not_found` covers "no such issue" AND "invisible to this
    // credential" — Linear reports them identically — so its message must offer
    // both remedies rather than pointing only at the identifier, which would
    // send an agent looping over references that were never the problem.
    const gone = await callTool("estimate_linear_issue", { reference: "GONE-1" }, ctx);
    assert.match(String(gone.message), /may not exist/);
    assert.match(String(gone.message), /may not be able to see it/);
    assert.match(String(gone.message), /connect a workspace/);

    // A permissions refusal keeps the server's explanation, not a bare status.
    const locked = await callTool("estimate_linear_issue", { reference: "LOCKED-1" }, ctx);
    assert.match(String(locked.message), /missing required permissions/);
    assert.doesNotMatch(String(locked.message), /HTTP 403/);
  } finally {
    await mock.close();
  }
});

test("estimate_linear_issue relays a low-confidence result with its calibration task", async () => {
  const mock = await startMock();
  const ctx = withKey(mock.base);
  try {
    const low = await callTool("estimate_linear_issue", { reference: "LOW-1" }, ctx);
    assert.equal(low.ok, true, "no comparable history is an honest answer, not an error");
    const estimate = low.estimate as typeof LOW_CONFIDENCE;
    assert.equal(estimate.size, null, "no size is bluffed");
    assert.equal(estimate.confidence.band, "low");
    assert.equal(estimate.basis, "none");
    assert.equal(estimate.calibrationTask!.size, "XS");
    assert.match(estimate.calibrationTask!.markdown, /Describe two comparable sessions/);
    // Even with nothing to compare against, the caller still learns WHAT was sized.
    assert.equal((low.source as typeof SOURCE).identifier, "ELL-44");
  } finally {
    await mock.close();
  }
});

test("estimate_linear_issue validates its arguments before spending a request", async () => {
  const mock = await startMock();
  const ctx = withKey(mock.base);
  try {
    for (const args of [
      {},
      { reference: "" },
      { reference: "   " },
      { reference: 7 },
      { reference: `ELL-44${"x".repeat(600)}` },
      { reference: "ELL-44", workspace: "" },
      { reference: "ELL-44", workspace: 7 },
      { reference: "ELL-44", workspace: "x".repeat(201) },
      { reference: "ELL-44", connectionId: "" },
      { reference: "ELL-44", connectionId: "x".repeat(129) },
      { reference: "ELL-44", repo: 7 },
      { reference: "ELL-44", lookbackDays: 0 },
      { reference: "ELL-44", lookbackDays: 366 },
      { reference: "ELL-44", limit: 99_999 },
      { reference: "ELL-44", linearScale: "story-points" },
      { reference: "ELL-44", linearScaleExtended: "yes" },
    ] as Record<string, unknown>[]) {
      const bad = await callTool("estimate_linear_issue", args, ctx);
      assert.equal(bad.ok, false, `rejects ${JSON.stringify(args)}`);
      assert.equal(bad.error, "bad_input", `rejects ${JSON.stringify(args)}`);
    }
    // Rejected calls never reach the backend.
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("estimate_linear_issue refuses before a key exists", async () => {
  const result = await callTool("estimate_linear_issue", { reference: "ELL-44" }, {
    session: new OnboardingSession(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_key");
});
