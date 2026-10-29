// Protocol-level smoke: drives the tools through a REAL MCP client/server pair
// (in-memory transport), proving the SDK wiring in mcpServer.ts works. Requires
// `npm install` (the SDK), so it's separate from the dependency-free `test`
// script and run via `npm run test:protocol`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcpServer.ts";
import { OnboardingSession } from "../src/session.ts";
import type { ToolContext } from "../src/tools.ts";

test("MCP protocol: estimate_plan sizes a plan through a real client/server", async () => {
  // A minimal task-size backend so the tool's normalize → size → return path runs
  // over the real SDK transport, not just callTool.
  const bodies: Record<string, unknown>[] = [];
  const backend = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      bodies.push(raw ? JSON.parse(raw) : {});
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        scope: "personal",
        estimate: {
          task: { text: "plan", source: "text", issueKey: null, terms: ["plan"] },
          sizingRequestId: "sr_proto0000000000000000000000",
          size: "M", range: { minTokens: 40_000, maxTokens: 120_000 },
          tokens: { point: 70_000, low: 40_000, high: 120_000 },
          basis: "matched", sampleCount: 5,
          confidence: { band: "medium", ladder: "medium", similarity: 0.6, evidence: 0.5, corpus: 0.5, agreement: 0.5, reasons: [] },
          matches: [], model: null, evidence: { lookbackDays: 90, sessions: 20, describedSessions: 12 },
          linearEstimate: null, calibrationTask: null,
        },
        performance: { totalMs: 10, queryMs: 8, readRows: 100, readBytes: 1_000 },
      }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
  const { port } = backend.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const session = new OnboardingSession();
  session.setKey("cot_" + "protoplanprotoplanprotoplan01", "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: base, ingestEndpoint: base } };
  const server = buildServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    const res: any = await client.callTool({
      name: "estimate_plan",
      arguments: { title: "Add a tool", steps: ["normalize input", "return the estimate"], provider: "claude" },
    });
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.ok, true);
    assert.equal(res.structuredContent.estimate.size, "M");
    assert.equal(res.structuredContent.source.format, "steps");
    assert.equal(res.structuredContent.source.stepCount, 2);
    assert.match(res.structuredContent.note, /token effort/i);
    assert.match(String(bodies.at(-1)!.taskText), /Add a tool\n\nPlan steps:\n1\. normalize input\n2\. return the estimate/);
    // No plaintext key crossed the wire.
    assert.ok(!JSON.stringify(res).includes("cot_protoplan"), "estimate_plan leaked the plaintext key");
  } finally {
    await client.close();
    await new Promise<void>((r) => backend.close(() => r()));
  }
});

test("MCP protocol: interpret_session counts duplicated text and structuredContent against one budget", async () => {
  const session = new OnboardingSession();
  session.setKey("cot_" + "protobudgetprotobudgetproto01", "pasted");
  // Canonical links at their bound (128-byte multi-byte identities,
  // fully percent-encoded, eight evidence links) must survive in the budget.
  const wide = encodeURIComponent("é".repeat(64));
  const sessionUrl = `https://codetelemetry.com/dashboards/session-timeline?session=${wide}&service=${wide}`;
  const evidenceLinks = Array.from({ length: 8 }, (_, position) => ({ evidenceId: `e${position}`, position, url: `${sessionUrl}&focus=${wide}`, deepLink: true }));
  const ctx: ToolContext = {
    session,
    endpointsOverride: { apiBase: "https://example.test" },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true, state: "warm", sessionId: "session-a", sessionUrl, evidenceLinks, message: "ready",
      interpretation: { version: "session-interpretation-v1", extractorVersion: "deterministic-evidence-v1",
        source: { tenantId: "tenant-a", privacyVersion: "privacy-1", sessionId: "session-a", service: "claude-code", snapshot: "p:1:00000000000040008000000000000001" },
        status: "ready", coverage: { source: "complete", content: "visible", outputTruncated: false, events: 1 }, padding: "x".repeat(40_000) },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };
  const server = buildServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const response: any = await client.callTool({ name: "interpret_session", arguments: { sessionId: "session-a" } });
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent.responseTruncated, true);
    assert.equal(response.structuredContent.sessionUrl, sessionUrl, "the reduced result keeps its canonical link");
    assert.deepEqual(response.structuredContent.evidenceLinks, evidenceLinks);
    const framed = { jsonrpc: "2.0", id: "x".repeat(128), result: response };
    assert.ok(Buffer.byteLength(JSON.stringify(framed), "utf8") <= 64 * 1024, "complete stdio JSON-RPC response exceeded budget");
  } finally {
    await client.close();
  }
});

test("MCP protocol: estimate_linear_issue sizes a connected issue, and disambiguates", async () => {
  // A minimal linear-issue-size backend, so the tool's validate → post → map
  // path runs over the real SDK transport rather than just callTool.
  const bodies: Record<string, unknown>[] = [];
  const CANDIDATES = [
    { connectionId: "conn-acme", workspace: { id: "ws-acme", name: "Acme Inc", urlKey: "acme" }, isDefault: true, status: "connected" },
    { connectionId: "conn-globex", workspace: { id: "ws-globex", name: "Globex", urlKey: "globex" }, isDefault: false, status: "connected" },
  ];
  const backend = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      if (!body.workspace && !body.connectionId) {
        res.statusCode = 409;
        return res.end(JSON.stringify({
          error: "ambiguous_connection",
          message: 'name one with connectionId or workspace: "acme", "globex"',
          connections: CANDIDATES,
        }));
      }
      res.end(JSON.stringify({
        ok: true,
        scope: "personal",
        estimate: {
          task: { text: "add an mcp tool", source: "issue", issueKey: "ELL-44", terms: ["mcp"] },
          sizingRequestId: "sr_proto44000000000000000000",
          size: "M", range: { minTokens: 40_000, maxTokens: 120_000 },
          tokens: { point: 70_000, low: 40_000, high: 120_000 },
          basis: "matched", sampleCount: 5,
          confidence: { band: "medium", ladder: "medium", similarity: 0.7, evidence: 0.6, corpus: 0.6, agreement: 0.6, reasons: [] },
          matches: [], model: null, evidence: { lookbackDays: 90, sessions: 30, describedSessions: 20 },
          linearEstimate: null, calibrationTask: null,
        },
        source: {
          reference: body.reference,
          connectionId: "conn-globex",
          workspace: { id: "ws-globex", name: "Globex", urlKey: "globex" },
          identifier: "ELL-44",
          url: "https://linear.app/globex/issue/ELL-44",
          title: "Add an MCP tool to estimate Linear issues",
          description: "Size an existing Linear story.",
          labels: ["mcp"], project: null, team: null, estimate: null,
          normalizedText: "add an mcp tool",
        },
        performance: { totalMs: 12, queryMs: 9, readRows: 200, readBytes: 2_000 },
      }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
  const { port } = backend.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const session = new OnboardingSession();
  session.setKey("cot_" + "protoissueprotoissueproto01", "pasted");
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: base, ingestEndpoint: base } };
  const server = buildServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    // A bare identifier under two connected workspaces refuses ACTIONABLY: the
    // candidate list survives the protocol round trip, so the agent can retry.
    const ambiguous: any = await client.callTool({
      name: "estimate_linear_issue",
      arguments: { reference: "ELL-44" },
    });
    assert.equal(ambiguous.structuredContent.ok, false);
    assert.equal(ambiguous.structuredContent.error, "ambiguous_connection");
    assert.deepEqual(ambiguous.structuredContent.connections, CANDIDATES);

    const sized: any = await client.callTool({
      name: "estimate_linear_issue",
      arguments: { reference: "https://linear.app/globex/issue/ELL-44", workspace: "globex", repo: "acme-api" },
    });
    assert.equal(sized.isError, false);
    assert.equal(sized.structuredContent.ok, true);
    assert.equal(sized.structuredContent.estimate.size, "M");
    assert.equal(sized.structuredContent.source.identifier, "ELL-44");
    assert.equal(sized.structuredContent.source.url, "https://linear.app/globex/issue/ELL-44");
    assert.equal(sized.structuredContent.source.normalizedText, "add an mcp tool");
    assert.match(sized.structuredContent.note, /token effort/i);
    // The tool sends only the reference + hints — never a Linear credential.
    assert.deepEqual(bodies.at(-1), {
      reference: "https://linear.app/globex/issue/ELL-44",
      workspace: "globex",
      repo: "acme-api",
    });
    for (const res of [ambiguous, sized]) {
      assert.ok(!JSON.stringify(res).includes("cot_protoissue"), "estimate_linear_issue leaked the plaintext key");
    }
  } finally {
    await client.close();
    await new Promise<void>((r) => backend.close(() => r()));
  }
});

test("MCP protocol: a wide Grader seed remains useful inside the complete response budget", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-grader-protocol-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), '\\"漢字\n'.repeat(2000));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`test:${i}`, "node --test"])) }));
  const server = buildServer({ session: new OnboardingSession() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "grader-budget", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const response: any = await client.callTool({ name: "seed_grader_config", arguments: { repositoryPath: root, features: "漢".repeat(4000) } });
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent.seed.truncated, true);
    assert.ok(response.structuredContent.seed.candidates.length > 0);
    assert.ok(response.structuredContent.seed.sources.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 64 * 1024 - 512);
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
