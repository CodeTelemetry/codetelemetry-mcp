// count_reply_phrases MCP tool (ELL-392): drives the registry handler against a
// mock /api/agent/reply-phrases backend. The phrases are forwarded unchanged,
// counts come back, server refusals keep their slug, and the key never leaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, TOOLS, type ToolContext } from "../src/tools.ts";

const KEY = "cot_replyphrasesreplyphrases0001";
const PLAINTEXT_KEY_RE = /cot_[A-Za-z0-9_-]{16,}/;
const TRENDS = { window: { start: 1, end: 2, bucket: "week" }, phrases: ["one note"], rows: [], byModel: [], examples: [], coverage: { responses: 0, cappedResponses: 0 } };

function startMock(reply: (body: any) => [number, unknown]): Promise<{ base: string; close: () => Promise<void>; bodies: any[] }> {
  const bodies: any[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/api/agent/reply-phrases") { res.writeHead(404).end(); return; }
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        bodies.push(body);
        const [status, payload] = req.headers.authorization === `Bearer ${KEY}` ? reply(body) : [401, { error: "invalid or revoked key" }];
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())), bodies });
    });
  });
}

test("count_reply_phrases schema bounds the phrases and the window", () => {
  const schema = TOOLS.find((t) => t.name === "count_reply_phrases")!.inputSchema as any;
  assert.deepEqual(schema.required, ["phrases"]);
  assert.equal(schema.properties.phrases.maxItems, 20);
  assert.equal(schema.properties.phrases.items.maxLength, 200);
  assert.equal(schema.properties.days.maximum, 365);
  assert.deepEqual(schema.properties.bucket.enum, ["day", "week"]);
  assert.equal(schema.additionalProperties, false);
});

test("count_reply_phrases forwards the phrases and returns the counts", async () => {
  const m = await startMock(() => [200, { ok: true, scope: "personal", trends: TRENDS }]);
  const ctx: ToolContext = { session: new OnboardingSession(), endpointsOverride: { apiBase: m.base } };
  ctx.session.setKey(KEY, "pasted");
  try {
    const r: any = await callTool("count_reply_phrases", { phrases: ["one note"], days: 90, bucket: "week" }, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.trends, TRENDS);
    assert.deepEqual(m.bodies, [{ phrases: ["one note"], days: 90, bucket: "week" }]);
    assert.ok(!PLAINTEXT_KEY_RE.test(JSON.stringify(r)), "tool result leaked a plaintext key");
  } finally { await m.close(); }
});

test("count_reply_phrases keeps the server's refusal slug; unknown failures are read_failed", async () => {
  for (const [status, payload, expected] of [
    [503, { error: "reply_phrases_disabled", message: "off" }, "reply_phrases_disabled"],
    [403, { error: "content_redacted", message: "hidden" }, "content_redacted"],
    [400, { error: "invalid_reply_phrase_input", message: "unclosed {" }, "invalid_reply_phrase_input"],
    [500, { error: "internal error" }, "read_failed"],
  ] as const) {
    const m = await startMock(() => [status, payload]);
    const ctx: ToolContext = { session: new OnboardingSession(), endpointsOverride: { apiBase: m.base } };
    ctx.session.setKey(KEY, "pasted");
    try {
      const r: any = await callTool("count_reply_phrases", { phrases: ["one note"] }, ctx);
      assert.equal(r.ok, false);
      assert.equal(r.error, expected);
    } finally { await m.close(); }
  }
});

test("count_reply_phrases without a key fails cleanly (no_key)", async () => {
  const r: any = await callTool("count_reply_phrases", { phrases: ["one note"] }, { session: new OnboardingSession() });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_key");
});
