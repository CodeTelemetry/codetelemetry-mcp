// import_history: the MCP surface over the connect history importer. Dry run
// by default, bounded per call, model-safe results (no key, paths or content),
// and the same commit protocol as the CLI. Fixtures only; a fake fetch stands in
// for ingest and the import-status route.
import "./support/isolateHome.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OnboardingSession } from "../src/session.ts";
import { callTool, type ToolContext } from "../src/tools.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "client", "fixtures", "import");
const KEY = "cot_importhistorytoolkeykey00001";
const NOW = Date.parse("2026-10-10T12:00:00Z");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-mcp-import-"));
  fs.cpSync(FIX, root, { recursive: true });
  const mtime = Date.parse("2026-10-03T00:00:00Z") / 1000;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else fs.utimesSync(p, mtime, mtime);
    }
  };
  walk(root);
  return root;
}

function ctx(opts: { key?: boolean; ingest?: (url: string) => number } = {}) {
  const root = setup();
  const session = new OnboardingSession();
  if (opts.key !== false) session.setKey(KEY, "pasted");
  const calls: string[] = [];
  const c: ToolContext = {
    session,
    endpointsOverride: { apiBase: "https://api.example.test", ingestEndpoint: "https://ingest.example.test" },
    configPathsOverride: { claude: path.join(root, "none.json"), codex: path.join(root, "none.toml") },
    importOverrides: {
      claudeDir: path.join(root, "claude-projects"),
      codexDir: path.join(root, "codex-sessions"),
      ledgerPath: path.join(root, "ledger.json"),
      nowMs: NOW,
      sleep: async () => {},
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.endsWith("/api/agent/import-status")) {
        return Response.json({ ok: true, sessions: body.sessions.map((s: any) => ({ sessionId: s.sessionId, live: false, plans: [] })), settleMs: 300_000, nowMs: NOW });
      }
      const status = opts.ingest?.(url) ?? 200;
      return status === 402
        ? Response.json({ error: "credit exhausted; add credits or seats", topup: "https://codetelemetry.com/billing" }, { status })
        : new Response("{}", { status });
    },
  };
  return { ctx: c, calls, root };
}

test("import_history needs a key and validates its bounded inputs", async () => {
  assert.equal((await callTool("import_history", {}, ctx({ key: false }).ctx)).error, "no_key");
  const { ctx: c } = ctx();
  for (const bad of [{ sinceDays: 400 }, { maxSessions: 1000 }, { content: "bodies" }, { source: "cursor" }, { dryRun: "no" }]) {
    assert.equal((await callTool("import_history", bad, c)).error, "bad_input", JSON.stringify(bad));
  }
});

test("import_history is a dry run unless told otherwise, and its result is model-safe", async () => {
  const { ctx: c, calls } = ctx();
  const r = await callTool("import_history", { sinceDays: 30 }, c) as any;
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.totals.sessions, 3);
  assert.ok(calls.every((u) => u.endsWith("/api/agent/import-status")), "a dry run never reaches ingest");
  // Default content is live (owner decision 2026-10-18): no exporter flags are
  // configured here, so Claude sends no text; Codex live tool events always
  // carry their arguments.
  assert.deepEqual(r.content, { "claude-code": { prompts: false, toolDetails: false }, codex: { prompts: false, toolDetails: true } });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(KEY), "never the plaintext key");
  assert.ok(!text.includes("Fix the login bug"), "never content");
  assert.ok(!/\.jsonl/.test(text), "never local file paths");
  assert.match(r.note, /ask before importing/);
});

test("import_history pages with maxSessions and reports what remains", async () => {
  const { ctx: c, calls } = ctx();
  const first = await callTool("import_history", { dryRun: false, maxSessions: 2 }, c) as any;
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.totals.sessions, 2);
  assert.equal(first.remaining, 1);
  assert.ok(calls.some((u) => u.endsWith("/v1/logs")));
  const second = await callTool("import_history", { dryRun: false, maxSessions: 2 }, c) as any;
  assert.equal(second.totals.sessions, 1);
  assert.equal(second.remaining, 0);
});

test("import_history surfaces an exhausted billing pool and stops", async () => {
  const { ctx: c } = ctx({ ingest: () => 402 });
  const r = await callTool("import_history", { dryRun: false }, c) as any;
  assert.equal(r.ok, false);
  assert.equal(r.stoppedBy, "budget");
  assert.equal(r.topup, "https://codetelemetry.com/billing");
  assert.ok(r.errors.some((e: string) => /prepaid credit is exhausted/.test(e)));
});

test("import_history defaults to the live exporters' content flags; none opts out", async () => {
  const { ctx: c, root } = ctx();
  fs.writeFileSync(path.join(root, "none.json"), JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: "1" } }));
  const live = await callTool("import_history", {}, c) as any;
  assert.deepEqual(live.content["claude-code"], { prompts: true, toolDetails: false });
  const none = await callTool("import_history", { content: "none" }, c) as any;
  assert.deepEqual(none.content, { "claude-code": { prompts: false, toolDetails: false }, codex: { prompts: false, toolDetails: false } });
});

const PRICING = {
  seatPriceUsdPerMonth: 50, tokenPriceUsdPerMillion: 0.05, includedTokensPerSeat: 1_000_000_000,
  signupCreditUsd: 5, retentionDays: 365, importsBilled: true,
};

function estimateCtx(opts: { pricing?: "ok" | "down"; key?: boolean } = {}) {
  const { ctx: c, root } = ctx({ key: opts.key });
  const calls: Array<{ url: string; method?: string; auth: string | null }> = [];
  c.fetchImpl = async (input, init) => {
    calls.push({ url: String(input), method: init?.method, auth: new Headers(init?.headers).get("authorization") });
    if (String(input).endsWith("/api/pricing") && opts.pricing !== "down") return Response.json(PRICING);
    return new Response("unavailable", { status: 503 });
  };
  return { ctx: c, calls, root };
}

test("estimate_history needs no key, sends nothing but the price-list read, and is model-safe", async () => {
  const { ctx: c, calls, root } = estimateCtx({ key: false });
  fs.writeFileSync(path.join(root, "none.json"), JSON.stringify({ cleanupPeriodDays: 45 }));
  const r = await callTool("estimate_history", {}, c) as any;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, [{ url: "https://api.example.test/api/pricing", method: "GET", auth: null }]);
  assert.equal(r.estimate.totals.sessions, 3);
  assert.ok(r.estimate.totals.tokens > 0);
  assert.equal(r.estimate.window.sinceIso, new Date(Math.floor((NOW - 364 * 86_400_000) / 86_400_000) * 86_400_000).toISOString(), "default: the retained year");
  assert.ok(r.estimate.months.length >= 1 && r.estimate.days.length >= 1);
  assert.deepEqual(r.pricing, PRICING);
  assert.equal(r.cost.uploadCostUsd, Math.round(r.estimate.totals.tokens * 0.05 / 1e6 * 100) / 100);
  assert.equal(r.goneForGood.claudeCleanupPeriodDays, 45);
  assert.match(r.goneForGood.claudeCutoffIso, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.match(r.goneForGood.neverRecovered, /latency/);
  assert.match(r.note, /import_history with dryRun true first and sinceDays 364/, "the import is pointed at the estimated window");
  const text = JSON.stringify(r);
  assert.ok(!/\.jsonl/.test(text), "never local file paths");
  assert.ok(!text.includes("Fix the login bug"), "never content");
  for (const bad of [{ sinceDays: 0 }, { sinceDays: 365 }, { source: "cursor" }]) {
    assert.equal((await callTool("estimate_history", bad, c)).error, "bad_input", JSON.stringify(bad));
  }
});

test("estimate_history still answers when the price list is unreachable", async () => {
  const { ctx: c } = estimateCtx({ pricing: "down" });
  const r = await callTool("estimate_history", { source: "codex", sinceDays: 30 }, c) as any;
  assert.equal(r.ok, true);
  assert.equal(r.pricing, null);
  assert.equal(r.cost, null);
  assert.deepEqual(r.estimate.sources.map((s: any) => s.source), ["codex"]);
  assert.equal(r.estimate.claudeCleanupPeriodDays, null);
  assert.match(r.note, /api\.example\.test\/estimate/);
});

test("import_history reports billing, months and the masked identity", async () => {
  const { ctx: c, root } = ctx();
  const inner = c.fetchImpl!;
  c.fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/agent/import-status")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        ok: true, sessions: body.sessions.map((s: any) => ({ sessionId: s.sessionId, live: false, plans: [] })), settleMs: 300_000, nowMs: NOW,
        billing: { importsBilled: true, tokenPriceUsdPerMillion: 0.05, includedTokensRemaining: 0, creditUsd: 0, unlimited: false },
      });
    }
    return inner(input, init);
  };
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ userID: "b".repeat(64), oauthAccount: { emailAddress: "dev@example.org" } }));
  c.importOverrides = { ...c.importOverrides, identityPaths: { claudeConfigPath: path.join(root, ".claude.json"), codexAuthPath: path.join(root, "no-auth.json") } };
  const dry = await callTool("import_history", {}, c) as any;
  assert.equal(dry.ok, true);
  assert.equal(dry.billing.affordable, false);
  assert.ok(dry.billing.estimatedTokens > 0);
  assert.match(dry.note, /does not cover every session/);
  assert.equal(dry.identity["claude-code"]["user.email"], "d***@e***.org");
  assert.ok(!JSON.stringify(dry).includes("dev@example.org"));
  assert.ok(dry.sources.every((s: any) => Array.isArray(s.months)));
  assert.ok(dry.sources.some((s: any) => s.months.length > 0 && s.firstEventMs !== null));

  const real = await callTool("import_history", { dryRun: false }, c) as any;
  assert.equal(real.ok, false);
  assert.equal(real.stoppedBy, "budget");
  assert.equal(real.totals.sessions, 0, "no credit and no included tokens: nothing starts");
  assert.match(real.note, /Stopped for budget/);

  const anonymous = await callTool("import_history", { identity: false }, c) as any;
  assert.equal("identity" in anonymous, false);
  assert.equal((await callTool("import_history", { identity: "no" }, c)).error, "bad_input");
});
