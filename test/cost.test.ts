// get_cost_signal MCP tool: drives the registry handler against a mock
// /api/agent/cost backend, and asserts the model-safe contract (cost returned,
// plaintext key never in the result).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";

const KEY = "cot_" + "costsignalcostsignalcostsig01";
const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;

function startMock(): Promise<{ base: string; close: () => Promise<void>; lastAuth: () => string }> {
  let lastAuth = "";
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === "POST" && (req.url || "").startsWith("/api/agent/cost")) {
        lastAuth = String(req.headers.authorization || "");
        // reject anything but our key, mirroring resolveKeyScope
        if (lastAuth !== `Bearer ${KEY}`) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid or revoked key" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, scope: "personal", cost: { observedCostUsd: 8.4, feeUsd: 0.84, byModel: [{ model: "claude-opus", observedCostUsd: 8.4 }], topRepo: "example-repo", asOf: "2026-06-13", note: "n" } }));
      }
      res.writeHead(404).end();
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())), lastAuth: () => lastAuth });
    });
  });
}

test("get_cost_signal: returns the cost (observed + fee), no plaintext key in the result", async () => {
  const m = await startMock();
  const ctx: ToolContext = { session: new OnboardingSession(), endpointsOverride: { apiBase: m.base } };
  ctx.session.setKey(KEY, "pasted");
  try {
    const r: any = await callTool("get_cost_signal", {}, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.cost.observedCostUsd, 8.4);
    assert.equal(r.cost.feeUsd, 0.84); // CodeTelemetry's charge = 10% of observed, labeled separately
    assert.equal(m.lastAuth(), `Bearer ${KEY}`); // key sent as bearer, server-side only
    assert.ok(!PLAINTEXT_KEY_RE.test(JSON.stringify(r)), "tool result leaked a plaintext key");
  } finally {
    await m.close();
  }
});

test("get_cost_signal without a key fails cleanly (no_key)", async () => {
  const ctx: ToolContext = { session: new OnboardingSession() };
  const r = await callTool("get_cost_signal", {}, ctx);
  assert.equal(r.ok, false);
  assert.equal((r as any).error, "no_key");
});

test("get_cost_signal surfaces a 401 from the backend as read_failed", async () => {
  const m = await startMock();
  const ctx: ToolContext = { session: new OnboardingSession(), endpointsOverride: { apiBase: m.base } };
  ctx.session.setKey("cot_" + "wrongkeywrongkeywrongkey00009", "pasted");
  try {
    const r: any = await callTool("get_cost_signal", {}, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, "read_failed");
  } finally {
    await m.close();
  }
});
