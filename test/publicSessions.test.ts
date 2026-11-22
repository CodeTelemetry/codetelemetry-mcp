// Public sessions: the MCP tools and the connect CLI read sample and published
// sessions with no credentials (no Authorization header, even when a key is
// held), and the key-authenticated publish tools require an explicit
// acknowledgement. Drives a mock of the CodeTelemetry public routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";
import { runPublicSessionsCommand } from "../src/client/publicSessionsCommand.ts";

const KEY = "cot_" + "publicsessionspublicsession01";
const PUBLIC_ID = `pub_${"A".repeat(43)}`;

type Seen = { method: string; url: string; auth: string; body: string };

function startMock(): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const url = req.url || "";
        seen.push({ method: req.method || "", url, auth: String(req.headers.authorization || ""), body });
        const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
        if (req.method === "GET" && url === "/api/public/sessions") {
          return json(200, { sessions: [{ id: "s-4f9c", kind: "sample", title: "Refactor Artifact Cache", repo: "infra-control", eventCount: 8 }] });
        }
        if (req.method === "GET" && url === `/api/public/sessions/${PUBLIC_ID}`) {
          return json(200, { id: PUBLIC_ID, kind: "published", service: "claude-code", state: "ready", dataNotice: "published" });
        }
        if (req.method === "POST" && url === "/api/public/sessions/s-4f9c/events") {
          return json(200, { id: "s-4f9c", kind: "sample", events: [{ position: 0, ts: "2026-11-22T12:00:00Z", kind: "prompt", label: "User prompt", detail: "Refactor\u001b[31m the cache" }], nextPosition: 1, dataNotice: "sample" });
        }
        if (req.method === "GET" && url.startsWith("/api/public/sessions/")) return json(404, { error: "public_session_not_found", message: "No public session has this id." });
        if (req.method === "POST" && url.startsWith("/api/agent/")) {
          if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "invalid or revoked key" });
          if (url === "/api/agent/publish-session") return json(200, { ok: true, publicId: PUBLIC_ID, url: `https://codetelemetry.com/api/public/sessions/${PUBLIC_ID}` });
          if (url === "/api/agent/unpublish-session") return json(200, { ok: true, unpublished: true, publicId: PUBLIC_ID });
          if (url === "/api/agent/published-sessions") return json(200, { ok: true, publications: [{ publicId: PUBLIC_ID }] });
        }
        res.writeHead(404).end();
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

test("public session tools need no key and never send one", async () => {
  const m = await startMock();
  const ctx: ToolContext = { session: new OnboardingSession(), endpointsOverride: { apiBase: m.base } };
  ctx.session.setKey(KEY, "pasted");
  try {
    const list: any = await callTool("list_public_sessions", {}, ctx);
    assert.equal(list.ok, true);
    assert.equal(list.sessions[0].id, "s-4f9c");
    const detail: any = await callTool("get_public_session", { id: PUBLIC_ID }, ctx);
    assert.equal(detail.kind, "published");
    const events: any = await callTool("read_public_session_events", { id: "s-4f9c", limit: 1 }, ctx);
    assert.equal(events.events.length, 1);
    assert.deepEqual(JSON.parse(m.seen.at(-1)!.body), { limit: 1 }, "the id goes in the path, not the body");
    const missing: any = await callTool("get_public_session", { id: "nope" }, ctx);
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "not_found");
    const bad: any = await callTool("get_public_session", { id: "../../api/agent/cost" }, ctx);
    assert.equal(bad.error, "bad_input");
    assert.ok(m.seen.every((request) => request.auth === ""), "no Authorization header on a public read");
  } finally { await m.close(); }
});

test("publish_session needs a key and an explicit acknowledgement", async () => {
  const m = await startMock();
  const ctx: ToolContext = { session: new OnboardingSession(), endpointsOverride: { apiBase: m.base } };
  try {
    assert.equal((await callTool("publish_session", { sessionId: "s1", acknowledgePublic: true }, ctx) as any).error, "no_key");
    ctx.session.setKey(KEY, "pasted");
    const refused: any = await callTool("publish_session", { sessionId: "s1", acknowledgePublic: false }, ctx);
    assert.equal(refused.ok, false);
    assert.equal(m.seen.length, 0, "nothing is sent without the acknowledgement");
    const ok: any = await callTool("publish_session", { sessionId: "s1", acknowledgePublic: true }, ctx);
    assert.equal(ok.publicId, PUBLIC_ID);
    assert.deepEqual(JSON.parse(m.seen.at(-1)!.body), { sessionId: "s1", acknowledgePublic: true });
    assert.equal((await callTool("list_published_sessions", {}, ctx) as any).publications.length, 1);
    assert.equal((await callTool("unpublish_session", { publicId: PUBLIC_ID }, ctx) as any).unpublished, true);
    assert.ok(!JSON.stringify(ok).includes(KEY), "the key never enters a result");
  } finally { await m.close(); }
});

test("connect public-sessions reads without credentials and prints terminal-safe text", async () => {
  const m = await startMock();
  const lines: string[] = [];
  const out = (line: string) => { lines.push(line); };
  try {
    assert.equal(await runPublicSessionsCommand(["list"], { "api-base": m.base }, out), 0);
    assert.match(lines.join("\n"), /s-4f9c  Refactor Artifact Cache/);
    lines.length = 0;
    assert.equal(await runPublicSessionsCommand(["events", "s-4f9c"], { "api-base": m.base, limit: "1", kinds: "prompt" }, out), 0);
    assert.deepEqual(JSON.parse(m.seen.at(-1)!.body), { limit: 1, kinds: ["prompt"] });
    assert.ok(!lines.join("\n").includes("\u001b"), "control characters are stripped");
    assert.match(lines.join("\n"), /More: --position 1/);
    lines.length = 0;
    assert.equal(await runPublicSessionsCommand(["show", PUBLIC_ID], { "api-base": m.base, json: true }, out), 0);
    assert.equal(JSON.parse(lines.join("\n")).kind, "published");
    lines.length = 0;
    assert.equal(await runPublicSessionsCommand(["show", "nope"], { "api-base": m.base }, out), 1);
    assert.match(lines[0], /No public session/);
    await assert.rejects(runPublicSessionsCommand(["events", "s-4f9c"], { "api-base": m.base, key: KEY }, out), /Unknown public-sessions option --key/);
    await assert.rejects(runPublicSessionsCommand(["events", "s-4f9c"], { "api-base": m.base, limit: "-1" }, out), /non-negative integer/);
    await assert.rejects(runPublicSessionsCommand(["show"], { "api-base": m.base }, out), /show <id>/);
    assert.ok(m.seen.every((request) => request.auth === ""));
  } finally { await m.close(); }
});
