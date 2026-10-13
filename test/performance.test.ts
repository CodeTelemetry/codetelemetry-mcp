import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";

const KEY = "cot_" + "performancetestperformancetest01";
const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;

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
        requests.push({
          path,
          auth: String(req.headers.authorization || ""),
          body,
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        if (path === "/api/agent/session-performance") {
          return res.end(JSON.stringify({
            ok: true,
            scope: "personal",
            report: {
              sessionId: "session-a",
              present: true,
              eventCount: 11,
              samples: [{
                mode: "dashboard-cache",
                cache: "hit",
                performance: { totalMs: 4.2, queryMs: 0, readRows: 0, readBytes: 0 },
              }],
            },
          }));
        }
        if (path === "/api/agent/similar-errors") {
          if (body.lookbackDays === 30) {
            res.writeHead(422, { "content-type": "application/json" });
            return res.end(JSON.stringify({
              error: "read_limit_exceeded",
              message: "Similar-error scan exceeded its safety cap; retry with fewer lookbackDays.",
            }));
          }
          return res.end(JSON.stringify({
            ok: true,
            scope: "personal",
            report: {
              sessionId: "session-a",
              targetSignatures: [{ signature: "abcdef123456", tool: "Bash", category: "shell failure", occurrences: 2 }],
              matches: [{ sessionId: "session-b", similarityPct: 100, categories: ["shell failure"] }],
            },
            performance: { totalMs: 82, queryMs: 77, readRows: 1200, readBytes: 4096 },
          }));
        }
        if (path === "/api/agent/session-search") {
          return res.end(JSON.stringify({
            ok: true,
            scope: "personal",
            report: {
              results: [{
                sessionId: "session-aurora",
                title: "session-aurora",
                titleIsId: true,
                repo: "data",
                sourceService: "codex",
                models: ["gpt-5.6-sol"],
                lastSeen: "2026-08-26T12:00:00.000Z",
                durationMs: 28800000,
                totalTokens: 1000,
                costUsd: 1,
                prompts: 28,
                invocations: 20,
                tools: 10,
                match: { fields: ["prompts"] },
              }],
              total: 1,
              limit: 25,
              offset: 0,
              hasMore: false,
              nextOffset: null,
              query: { text: "aurora" },
              repos: ["data"],
              promptSearchAvailable: true,
              contentRedacted: true,
            },
          }));
        }
        return res.end(JSON.stringify({ error: "not found" }));
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

test("performance tools return bounded model-safe reports", async () => {
  const mock = await startMock();
  const ctx: ToolContext = {
    session: new OnboardingSession(),
    endpointsOverride: { apiBase: mock.base },
  };
  ctx.session.setKey(KEY, "pasted");
  try {
    const session = await callTool("get_session_performance", {
      sessionId: "session-a",
      includeFresh: true,
      cacheSamples: 2,
    }, ctx);
    const similar = await callTool("find_similar_session_errors", {
      sessionId: "session-a",
      lookbackDays: 7,
      limit: 5,
    }, ctx);
    const search = await callTool("search_sessions", {
      q: "aurora",
      assistant: "codex",
      model: "sol",
      minDurationMs: 14_400_000,
    }, ctx);

    assert.equal(session.ok, true);
    assert.equal((session.report as any).samples[0].cache, "hit");
    assert.equal(similar.ok, true);
    assert.equal((similar.report as any).matches[0].sessionId, "session-b");
    assert.equal((similar.performance as any).readRows, 1200);
    assert.equal(search.ok, true);
    assert.equal((search.report as any).results[0].sessionId, "session-aurora");
    assert.deepEqual((search.report as any).results[0].match.fields, ["prompts"]);
    assert.equal(JSON.stringify(search).includes("Move Aurora"), false);
    assert.deepEqual(mock.requests.map((request) => request.path), [
      "/api/agent/session-performance",
      "/api/agent/similar-errors",
      "/api/agent/session-search",
    ]);
    assert.ok(mock.requests.every((request) => request.auth === `Bearer ${KEY}`));
    assert.equal(mock.requests[0].body.cacheSamples, 2);
    assert.equal(mock.requests[1].body.lookbackDays, 7);
    assert.equal(mock.requests[2].body.model, "sol");
    const capped = await callTool("find_similar_session_errors", {
      sessionId: "session-a",
      lookbackDays: 30,
    }, ctx);
    assert.equal(capped.ok, false);
    assert.match(String(capped.message), /fewer lookbackDays/);
    assert.ok(!PLAINTEXT_KEY_RE.test(JSON.stringify([session, similar])));
  } finally {
    await mock.close();
  }
});

test("performance tools require a session id", async () => {
  const ctx: ToolContext = { session: new OnboardingSession() };
  ctx.session.setKey(KEY, "pasted");
  assert.equal((await callTool("get_session_performance", {}, ctx)).error, "bad_input");
  assert.equal((await callTool("find_similar_session_errors", {}, ctx)).error, "bad_input");
  assert.match(String((await callTool("get_session_performance", {
    sessionId: "session-a",
    cacheSamples: 2.5,
  }, ctx)).message), /integer from 1 to 3/);
  assert.match(String((await callTool("find_similar_session_errors", {
    sessionId: "session-a",
    lookbackDays: 31,
  }, ctx)).message), /integer from 1 to 30/);
});
