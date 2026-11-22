// ELL-655: price past sessions before importing them. The estimate reads the
// same history the importer reads (same parsers, same window filters), needs
// no key and sends nothing but the optional public price-list GET. Synthetic
// history under temporary directories only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runEstimate, runImport } from "../../src/client/import/run.ts";
import { estimateFiles, type UploadFile } from "../../src/client/import/browser.ts";
import {
  ESTIMATE_DEFAULT_DAYS,
  claudeRetentionCutoffMs,
  fetchPricing,
  parsePricing,
  priceEstimate,
  type PublicPricing,
} from "../../src/client/import/estimate.ts";
import { run as cli } from "../../src/client/cli.ts";
import { claudeTranscript, codexPath, codexRollout, put } from "./historyFixtures.ts";
import { API, FakeServer, INGEST, KEY } from "./importFake.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const PRICING: PublicPricing = {
  seatPriceUsdPerMonth: 50, tokenPriceUsdPerMillion: 0.05, includedTokensPerSeat: 1_000_000_000,
  signupCreditUsd: 5, retentionDays: 365, importsBilled: true,
};

const A1 = Date.parse("2026-09-05T10:00:00Z");
const A2 = Date.parse("2026-10-01T10:00:00Z");
const C1 = Date.parse("2026-10-05T09:00:00Z");

/** A: Claude, two months; B: Claude, older than the retained year; C: Codex;
 *  D: Claude, written minutes ago (still active). */
function history(root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-estimate-"))) {
  const claudeDir = path.join(root, "claude-projects");
  const codexDir = path.join(root, "codex-sessions");
  put(path.join(claudeDir, "-work-est", "sess-a.jsonl"), claudeTranscript("sess-a", [
    { ts: A1, input: 1000, output: 10 },
    { ts: A2, input: 300, output: 100, cacheRead: 50, cacheCreation: 50 },
  ]), A2 + 60_000);
  const B = Date.parse("2025-08-01T10:00:00Z");
  put(path.join(claudeDir, "-work-est", "sess-b.jsonl"), claudeTranscript("sess-b", [{ ts: B, input: 999_999, output: 1 }]), B + 60_000);
  put(path.join(claudeDir, "-work-est", "sess-d.jsonl"), claudeTranscript("sess-d", [{ ts: NOW - 6 * 60_000, input: 5, output: 5 }]), NOW - 5 * 60_000);
  const cId = "0199bbbb-cccc-7ddd-8eee-ffff00000001";
  put(codexPath(codexDir, cId, C1), codexRollout(cId, [{ ts: C1, input: 2000, cached: 500, output: 100 }]), C1 + 60_000);
  return { root, claudeDir, codexDir };
}

test("runEstimate: sessions and tokens per source, month and day, over the retained year, from local files only", async () => {
  const h = history();
  const settings = path.join(h.root, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 14 }));
  const e = await runEstimate({ nowMs: NOW, claudeDir: h.claudeDir, codexDir: h.codexDir, claudeSettingsPath: settings });

  // Default window: the whole retained year (the importer's 364-day clamp).
  assert.equal(ESTIMATE_DEFAULT_DAYS, 364);
  assert.equal(e.window.sinceIso, new Date(Math.floor((NOW - 364 * DAY) / DAY) * DAY).toISOString());
  assert.equal(e.window.untilIso, new Date(NOW).toISOString());

  const claude = e.sources.find((s) => s.source === "claude-code")!;
  const codex = e.sources.find((s) => s.source === "codex")!;
  assert.equal(claude.filesFound, 3);
  assert.equal(claude.sessions, 1);
  assert.deepEqual(claude.tokens, { input: 1300, output: 110, cacheRead: 50, cacheCreation: 50 });
  assert.deepEqual(claude.skipped, { older: 1, active: 1 });
  assert.equal(codex.sessions, 1);
  // Codex input includes cached: fresh 1500 + cached 500 + output 100.
  assert.deepEqual(codex.tokens, { input: 1500, output: 100, cacheRead: 500, cacheCreation: 0 });

  // Every token type counted once; months by each call's own timestamp,
  // sessions in the month they start.
  assert.deepEqual(e.totals, { sessions: 2, tokens: 1510 + 2100, events: claude.events + codex.events });
  assert.deepEqual(e.months, [
    { month: "2026-09", sessions: 1, tokens: 1010 },
    { month: "2026-10", sessions: 1, tokens: 500 + 2100 },
  ]);
  assert.deepEqual(e.days, [
    { day: "2026-09-05", tokens: 1010 },
    { day: "2026-10-01", tokens: 500 },
    { day: "2026-10-05", tokens: 2100 },
  ]);
  assert.equal(e.trailing30dTokens, 500 + 2100, "the September 5 call is outside the last 30 days");
  assert.equal(e.oldestEventMs, A1 - 1_000);
  assert.equal(e.newestEventMs, C1);
  assert.equal(e.claudeCleanupPeriodDays, 14);
  assert.ok(e.warnings.some((w) => /already captured live/.test(w)));

  const defaults = await runEstimate({ nowMs: NOW, claudeDir: h.claudeDir, codexDir: h.codexDir, claudeSettingsPath: path.join(h.root, "none.json") });
  assert.equal(defaults.claudeCleanupPeriodDays, 30, "Claude Code's default retention");
  const codexOnly = await runEstimate({ source: "codex", nowMs: NOW, claudeDir: h.claudeDir, codexDir: h.codexDir });
  assert.equal(codexOnly.claudeCleanupPeriodDays, null);
  assert.deepEqual(codexOnly.sources.map((s) => s.source), ["codex"]);
  assert.equal(codexOnly.totals.tokens, 2100);

  // A narrower window trims per event, like an import does.
  const recent = await runEstimate({ nowMs: NOW, sinceMs: Date.parse("2026-09-15T00:00:00Z"), claudeDir: h.claudeDir, codexDir: h.codexDir });
  assert.equal(recent.totals.tokens, 500 + 2100);
  assert.deepEqual(recent.months, [{ month: "2026-10", sessions: 2, tokens: 2600 }]);
  assert.ok(recent.warnings.some((w) => /covers only 25\.5 day\(s\).*last-30-day pace/.test(w)), "a window under 30 days says its pace is understated");
});

test("runEstimate matches an import dry run, a duplicated session counts its in-window copy, and a short window says its pace is understated", async () => {
  const h = history();
  // sess-a again, in a second file whose events are all before the window: it
  // must not hide the in-window copy (runImport dedupes only in-window plans).
  const old = Date.parse("2026-02-01T10:00:00Z");
  put(path.join(h.claudeDir, "-work-aaa", "sess-a-copy.jsonl"), claudeTranscript("sess-a", [{ ts: old, input: 1, output: 1 }]), Date.parse("2026-09-20T00:00:00Z"));
  const since = Date.parse("2026-09-01T00:00:00Z");
  const e = await runEstimate({ nowMs: NOW, sinceMs: since, claudeDir: h.claudeDir, codexDir: h.codexDir });
  const server = new FakeServer();
  const dry = await runImport({
    key: KEY, endpoints: { apiBase: API, ingestEndpoint: INGEST }, sinceMs: since, nowMs: NOW, dryRun: true,
    fetchImpl: server.fetch as typeof fetch, sleep: async () => {}, claudeDir: h.claudeDir, codexDir: h.codexDir, ledgerPath: path.join(h.root, "ledger.json"),
  });
  const tok = (t: { input: number; output: number; cacheRead: number; cacheCreation: number }) => t.input + t.output + t.cacheRead + t.cacheCreation;
  assert.equal(e.totals.sessions, dry.totals.sessions);
  assert.equal(e.totals.tokens, dry.sources.reduce((n, s) => n + tok(s.tokens), 0));
  assert.equal(e.totals.tokens, 1510 + 2100, "the in-window copy of sess-a is counted");
  const months = new Map<string, { sessions: number; tokens: number }>();
  for (const s of dry.sources) for (const m of s.months) {
    const b = months.get(m.month) ?? { sessions: 0, tokens: 0 };
    months.set(m.month, { sessions: b.sessions + m.sessions, tokens: b.tokens + m.tokens });
  }
  assert.deepEqual(e.months, [...months].sort().map(([month, b]) => ({ month, ...b })));

  const week = await runEstimate({ nowMs: NOW, sinceMs: NOW - 7 * DAY, claudeDir: h.claudeDir, codexDir: h.codexDir });
  assert.ok(week.warnings.some((w) => /covers only 7 day\(s\).*last-30-day pace/.test(w)), week.warnings.join("; "));
});

test("estimateFiles: the browser estimate of the same files matches the CLI's, with no key and no network", async () => {
  const h = history();
  const files: UploadFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(new File([fs.readFileSync(p)], e.name, { lastModified: fs.statSync(p).mtimeMs }));
    }
  };
  walk(h.root);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("the estimate must not use the network"); }) as typeof fetch;
  try {
    const web = await estimateFiles(files, { nowMs: NOW });
    const local = await runEstimate({ nowMs: NOW, claudeDir: h.claudeDir, codexDir: h.codexDir });
    assert.deepEqual(web.totals, local.totals);
    assert.deepEqual(web.months, local.months);
    assert.deepEqual(web.days, local.days);
    assert.equal(web.trailing30dTokens, local.trailing30dTokens);
    assert.equal(web.claudeCleanupPeriodDays, null, "a page cannot read Claude settings");
    assert.deepEqual(web.sources.map((s) => [s.source, s.filesFound, s.sessions, s.skipped]),
      local.sources.map((s) => [s.source, s.filesFound, s.sessions, s.skipped]));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("pricing: defensive parse, a GET with no credentials, and the upload / monthly arithmetic", async () => {
  assert.deepEqual(parsePricing(PRICING), PRICING);
  assert.equal(parsePricing({ ...PRICING, tokenPriceUsdPerMillion: -1 }), null);
  assert.equal(parsePricing({ ...PRICING, importsBilled: "yes" }), null);
  assert.equal(parsePricing([]), null);
  const { importsBilled: _omit, ...partial } = PRICING;
  assert.equal(parsePricing(partial), null);

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ok = await fetchPricing("https://api.example.test/", async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(PRICING);
  });
  assert.deepEqual(ok, PRICING);
  assert.equal(calls[0].url, "https://api.example.test/api/pricing");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), null, "the price list is public");
  assert.equal(await fetchPricing("https://api.example.test", async () => new Response("nope", { status: 503 })), null);
  assert.equal(await fetchPricing("https://api.example.test", async () => { throw new TypeError("fetch failed"); }), null);

  const cost = priceEstimate({ totals: { sessions: 1, tokens: 2_000_000_000, events: 1 }, trailing30dTokens: 1_500_000_000 }, PRICING);
  assert.equal(cost.uploadCostUsd, 100, "2 B tokens at 5¢ per million");
  assert.equal(cost.monthlyUsdOneSeat, 75, "one $50 seat plus 0.5 B overage tokens");
  assert.equal(priceEstimate({ totals: { sessions: 1, tokens: 10, events: 1 }, trailing30dTokens: 10 }, PRICING).monthlyUsdOneSeat, 50);
  assert.equal(priceEstimate({ totals: { sessions: 1, tokens: 1e9, events: 1 }, trailing30dTokens: 0 }, { ...PRICING, importsBilled: false }).uploadCostUsd, 0);
  assert.equal(new Date(claudeRetentionCutoffMs(NOW, 30)).toISOString(), "2026-09-10T00:00:00.000Z");
});

const BIN = fileURLToPath(new URL("../../src/client/bin.ts", import.meta.url));

/** The CLI in a child process (asynchronously, so this process's local price
 *  server can answer). Capturing this process's stdout would corrupt the test
 *  runner's own reporting channel. The child inherits the isolated home. */
function runCli(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { text += c; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, text });
    });
  });
}

test("cli estimate: prices the local history, says what is gone for good, and ends with the dry-run step", async (t) => {
  // History in this test process's isolated home (test/support/isolateHome.ts).
  const home = os.homedir();
  assert.match(home, /cot-test-home-/, "never the real home");
  const now = Date.now();
  const claudeDir = path.join(home, ".claude", "projects");
  const recent = now - 3 * DAY;
  put(path.join(claudeDir, "-work-est", "cli-a.jsonl"), claudeTranscript("cli-a", [{ ts: recent, input: 1_500_000, output: 500_000 }]), recent + 60_000);
  const codexId = "0199bbbb-cccc-7ddd-8eee-ffff00000002";
  put(codexPath(path.join(process.env.CODEX_HOME!, "sessions"), codexId, recent), codexRollout(codexId, [{ ts: recent, input: 1_000_000, cached: 0, output: 0 }]), recent + 60_000);
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 21 }));
  t.after(() => fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true }));

  const requests: Array<{ method?: string; url?: string; auth?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(PRICING));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const human = await runCli(["estimate", "--api-base", base]);
  assert.equal(human.code, 0);
  assert.deepEqual(requests, [{ method: "GET", url: "/api/pricing", auth: undefined }], "one unauthenticated price-list read, nothing else");
  assert.match(human.text, /Claude Code/);
  const text = human.text;
  assert.match(text, /nothing was sent and no key was used/);
  assert.match(text, /Claude Code: 1 session\(s\), 2,000,000 tokens/);
  assert.match(text, /Codex: 1 session\(s\), 1,000,000 tokens/);
  assert.match(text, /Tokens by month \(UTC\):/);
  assert.match(text, /Oldest session: \d{4}-\d{2}-\d{2} · newest session: \d{4}-\d{2}-\d{2}/);
  assert.match(text, /Uploading these sessions: about \$0\.15 at 5¢ per million tokens \(included seat tokens apply first\)\./);
  assert.match(text, /At this pace: about \$50\.00\/month for one seat/);
  const cutoff = new Date(claudeRetentionCutoffMs(now, 21)).toISOString().slice(0, 10);
  assert.ok(text.includes(`Claude Code deletes transcripts 21 day(s) after their last activity`), text);
  assert.ok(text.includes(`session from before ${cutoff} survives only if CodeTelemetry captured it live or its transcript is still on disk`), text);
  assert.match(text, /never recovers per-request latency/);
  assert.match(text.trimEnd(), /Next: codetelemetry-connect import --dry-run --since 364d$/);

  const json = await runCli(["estimate", "--json", "--since", "30d", "--source", "claude-code", "--api-base", base]);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.totals.tokens, 2_000_000);
  assert.equal(parsed.claudeCleanupPeriodDays, 21);
  assert.deepEqual(parsed.pricing, PRICING);
  assert.equal(parsed.cost.uploadCostUsd, 0.1);

  // Price list unreachable: tokens plus the estimate page, still exit 0.
  const offline = await runCli(["estimate", "--api-base", "http://127.0.0.1:9"]);
  assert.equal(offline.code, 0);
  assert.match(offline.text, /3,000,000 tokens in total/);
  assert.match(offline.text, /See http:\/\/127\.0\.0\.1:9\/estimate/i);

  assert.equal(await cli(["estimate", "--source", "cursor"]), 1);
  assert.equal(await cli(["estimate", "--since", "last week"]), 1);
  assert.equal(await cli(["estimate", "--key", "cot_x"]), 1, "estimate takes no key");
});
