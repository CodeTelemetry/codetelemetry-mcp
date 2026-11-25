// ELL-655: imported tokens are billed like live usage. The import-status
// route's optional billing block prices a run; a real import never starts a
// session the prepaid credit (after this month's included seat tokens) cannot
// cover, and a dry run reports affordability instead. Absent billing keeps the
// old behaviour. Also pins the commit marker's accounting attributes (C2) and
// the per-source months. In-memory fake server only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runImport, type ImportRunOptions } from "../../src/client/import/run.ts";
import { parseImportBilling, type ImportBilling } from "../../src/client/import/transport.ts";
import { importCostUsd } from "../../src/client/import/core.ts";
import { parseCandidate, scanClaudeSessions, scanCodexSessions } from "../../src/client/import/sources/files.ts";
import { callTokens, NO_CONTENT } from "../../src/client/import/model.ts";
import { API, CLAUDE_SID, FakeServer, INGEST, KEY, NOW } from "./importFake.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "import");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-import-billing-"));
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
  return { claudeDir: path.join(root, "claude-projects"), codexDir: path.join(root, "codex-sessions"), ledgerPath: path.join(root, "ledger.json") };
}

function opts(server: FakeServer, dirs: ReturnType<typeof setup>, over: Partial<ImportRunOptions> = {}): ImportRunOptions {
  return {
    key: KEY, endpoints: { apiBase: API, ingestEndpoint: INGEST }, sinceMs: Date.parse("2026-09-15T00:00:00Z"), nowMs: NOW,
    fetchImpl: server.fetch as typeof fetch, sleep: async () => {}, ...dirs, ...over,
  };
}

/** The fixture sessions in send order (oldest first), with their tokens. */
async function fixtureSessions() {
  const out: Array<{ sid: string; startMs: number; endMs: number; tokens: number }> = [];
  for (const c of [...scanClaudeSessions(path.join(FIX, "claude-projects")), ...scanCodexSessions(path.join(FIX, "codex-sessions"))]) {
    const r = await parseCandidate(c, NO_CONTENT);
    assert.ok(r.ok && r.session);
    out.push({ sid: r.session.sessionId, startMs: r.session.startMs, endMs: r.session.endMs, tokens: r.session.modelCalls.reduce((n, m) => n + callTokens(m), 0) });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const BILLING: ImportBilling = { importsBilled: true, tokenPriceUsdPerMillion: 0.05, includedTokensRemaining: 0, creditUsd: 5, unlimited: false };

test("the billing block parses defensively; anything malformed is ignored", () => {
  assert.deepEqual(parseImportBilling(BILLING), BILLING);
  assert.equal(parseImportBilling(undefined), undefined);
  assert.equal(parseImportBilling({ ...BILLING, creditUsd: "5" }), undefined);
  assert.equal(parseImportBilling({ ...BILLING, includedTokensRemaining: -1 }), undefined);
  assert.equal(parseImportBilling({ ...BILLING, tokenPriceUsdPerMillion: Number.NaN }), undefined);
  assert.equal(parseImportBilling({ ...BILLING, importsBilled: 1 }), undefined);
  const { unlimited: _u, ...noFlag } = BILLING;
  assert.equal(parseImportBilling({ ...noFlag, includedTokensRemaining: 1e15 })?.unlimited, true, "a 1e15 allowance is unlimited");
  assert.equal(importCostUsd(3_000_000, { ...BILLING, includedTokensRemaining: 1_000_000 }), 0.1, "included tokens apply first");
  assert.equal(importCostUsd(3_000_000, { ...BILLING, unlimited: true }), 0);
  assert.equal(importCostUsd(3_000_000, { ...BILLING, importsBilled: false }), 0);
});

test("a dry run prices the window and reports affordability without skipping", async () => {
  const sessions = await fixtureSessions();
  const all = sessions.reduce((n, s) => n + s.tokens, 0);
  const server = new FakeServer();
  // $1 per million, nothing included, credit for everything but the last session.
  server.billing = { ...BILLING, tokenPriceUsdPerMillion: 1, creditUsd: (all - 1) / 1e6 };
  const r = await runImport(opts(server, setup(), { dryRun: true }));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.totals.sessions, 3, "a dry run skips nothing for budget");
  assert.equal(r.billing?.estimatedTokens, all);
  assert.equal(r.billing?.estimatedCostUsd, all / 1e6);
  assert.equal(r.billing?.affordable, false);
  assert.equal(r.partial?.requested.tokens, all);
  assert.equal(r.partial?.fits.sessions, 2, "what a real run would send");
  assert.equal(r.stoppedBy, null);
  assert.equal(server.ingestCalls.length, 0);

  server.billing = { ...BILLING, includedTokensRemaining: all };
  const covered = await runImport(opts(server, setup(), { dryRun: true }));
  assert.equal(covered.billing?.estimatedCostUsd, 0, "the included seat tokens cover it");
  assert.equal(covered.billing?.affordable, true);
});

test("an import larger than the credit is partial: it sends what fits, succeeds, and reports the whole volume", async () => {
  const sessions = await fixtureSessions();
  const server = new FakeServer();
  const all = sessions.reduce((n, s) => n + s.tokens, 0);
  const firstTwo = sessions[0].tokens + sessions[1].tokens;
  // Included allowance covers the first session; credit covers the second only.
  server.billing = { ...BILLING, tokenPriceUsdPerMillion: 1, includedTokensRemaining: sessions[0].tokens, creditUsd: sessions[1].tokens / 1e6 };
  const dirs = setup();
  const r = await runImport(opts(server, dirs));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.errors, []);
  assert.equal(r.stoppedBy, "budget");
  assert.equal(r.totals.sessions, 2, "the two oldest sessions fit");
  assert.equal(r.remaining, 1);
  assert.equal(r.sources.reduce((n, s) => n + (s.skipped.budget ?? 0), 0), 1);
  assert.equal(r.billing?.affordable, false);
  // A partial run's billing prices what it sent; `partial` has the whole window.
  assert.equal(r.billing?.estimatedTokens, firstTwo);
  assert.equal(r.billing?.estimatedCostUsd, Math.round(sessions[1].tokens) / 1e6);
  assert.deepEqual(r.partial, {
    requested: { sessions: 3, tokens: all, costUsd: Math.round(all - sessions[0].tokens) / 1e6 },
    fits: { sessions: 2, tokens: firstTwo, costUsd: sessions[1].tokens / 1e6 },
  });
  assert.ok(r.warnings.some((w) => /^Partial import: /.test(w) && /2 of 3 session\(s\) fit/.test(w)), r.warnings.join("; "));
  const last = sessions[2].sid;
  assert.equal(server.logs.filter((l) => l.sid === last).length, 0, "the unaffordable session sent nothing");
  assert.equal(server.logs.filter((l) => l.marker).length, 2);

  // The server was told the whole volume before anything was sent, and the sent volume after.
  assert.deepEqual(server.reports.map((x) => x.phase), ["plan", "sent"]);
  const [plan, done] = server.reports;
  assert.deepEqual(plan.requested, { sessions: 3, tokens: all });
  assert.deepEqual(plan.planned, { sessions: 2, tokens: firstTwo });
  const bySource = Object.values(plan.requestedBySource) as Array<{ sessions: number; tokens: number }>;
  assert.equal(bySource.reduce((n, v) => n + v.tokens, 0), all);
  assert.deepEqual(done.sent, { sessions: 2, tokens: firstTwo });
  assert.equal(done.done, true);
  assert.equal(done.stoppedBy, "budget");
  for (const s of sessions) assert.ok(!JSON.stringify(server.reports).includes(s.sid), "no session ids in a report");

  // Credit added: the same command finishes the window without resending.
  server.billing = { ...BILLING, creditUsd: 100 };
  const again = await runImport(opts(server, dirs));
  assert.equal(again.ok, true, again.errors.join("; "));
  assert.equal(again.totals.sessions, 1);
  assert.equal("partial" in again, false);
  assert.equal(server.logs.filter((l) => l.marker).length, 3);
  assert.equal(again.billing?.estimatedTokens, sessions[2].tokens, "only the sessions this run sends are priced");
});

test("a session that does not fit is passed over, not a stop; nothing that fits is an error", async () => {
  const sessions = await fixtureSessions();
  const biggest = [...sessions].sort((a, b) => b.tokens - a.tokens)[0];
  const others = sessions.filter((s) => s !== biggest);
  const otherTokens = others.reduce((n, s) => n + s.tokens, 0);
  assert.ok(otherTokens < biggest.tokens, "the fixture's biggest session outweighs the rest");
  const server = new FakeServer();
  server.billing = { ...BILLING, tokenPriceUsdPerMillion: 1, creditUsd: otherTokens / 1e6 };
  const r = await runImport(opts(server, setup()));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.totals.sessions, others.length);
  assert.equal(server.logs.filter((l) => l.sid === biggest.sid).length, 0);
  assert.deepEqual([...new Set(server.logs.filter((l) => l.marker).map((l) => l.sid))].sort(), others.map((s) => s.sid).sort());

  const none = new FakeServer();
  none.billing = { ...BILLING, tokenPriceUsdPerMillion: 1, creditUsd: 0 };
  const refused = await runImport(opts(none, setup()));
  assert.equal(refused.ok, false);
  assert.equal(refused.stoppedBy, "budget");
  assert.ok(refused.errors.some((e) => /^Nothing was sent: /.test(e)), refused.errors.join("; "));
  assert.equal(none.ingestCalls.length, 0);
  assert.equal(none.reports[0].planned.sessions, 0, "the volume it would have been is still reported");
  assert.equal(none.reports[0].requested.sessions, 3);
});

test("a session cap defers sessions that fit before it calls the run out of credit", async () => {
  const sessions = await fixtureSessions();
  const server = new FakeServer();
  server.billing = { ...BILLING, tokenPriceUsdPerMillion: 1, creditUsd: (sessions[0].tokens + sessions[1].tokens) / 1e6 };
  const r = await runImport(opts(server, setup(), { maxSessions: 1 }));
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.stoppedBy, null, "the next run needs no credit");
  assert.equal(r.remaining, 2);
  assert.equal(server.reports[0].planned.sessions, 1);
  assert.equal(server.reports[0].requested.sessions, 3);
});

test("a report that fails, or a server without the route, never changes the import; a dry run reports nothing", async () => {
  for (const status of [404, 429, 500]) {
    const server = new FakeServer();
    server.reportStatus = status;
    const r = await runImport(opts(server, setup()));
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.totals.sessions, 3);
    assert.equal(server.reports.length, 1, "no report id, no further reports");
  }
  const thrown = new FakeServer();
  const inner = thrown.fetch;
  thrown.fetch = async (url, init) => {
    if (String(url).endsWith("/import-report")) throw new TypeError("fetch failed");
    return inner(url, init);
  };
  assert.equal((await runImport(opts(thrown, setup()))).ok, true);
  const dry = new FakeServer();
  await runImport(opts(dry, setup(), { dryRun: true }));
  assert.equal(dry.reports.length, 0);
});

test("an unlimited allowance or an absent billing block runs no budget check", async () => {
  const server = new FakeServer();
  server.billing = { ...BILLING, creditUsd: 0, unlimited: true, includedTokensRemaining: 1e15 };
  const unlimited = await runImport(opts(server, setup()));
  assert.equal(unlimited.ok, true, unlimited.errors.join("; "));
  assert.equal(unlimited.totals.sessions, 3);
  assert.equal(unlimited.billing?.estimatedCostUsd, 0);
  assert.equal(unlimited.billing?.affordable, true);

  const plain = new FakeServer();
  const old = await runImport(opts(plain, setup()));
  assert.equal(old.ok, true);
  assert.equal("billing" in old, false, "no billing state, no billing block");
  assert.equal(old.totals.sessions, 3);

  const garbled = new FakeServer();
  garbled.billing = { importsBilled: "maybe" };
  const ignored = await runImport(opts(garbled, setup()));
  assert.equal(ignored.ok, true);
  assert.equal("billing" in ignored, false);
});

test("commit markers carry the session start and token count as decimal strings (C2)", async () => {
  const sessions = await fixtureSessions();
  const server = new FakeServer();
  const r = await runImport(opts(server, setup()));
  assert.equal(r.ok, true, r.errors.join("; "));
  for (const s of sessions) {
    const marker = server.logs.find((l) => l.sid === s.sid && l.marker)!;
    assert.equal(marker.attrs["import.session_start_ms"], String(s.startMs));
    assert.equal(marker.attrs["import.tokens"], String(s.tokens));
  }
  // The trimmed start, when the window cuts a session.
  const trimmedServer = new FakeServer();
  const since = Date.parse("2026-10-01T11:00:00Z");
  await runImport(opts(trimmedServer, setup(), { sinceMs: since, source: "claude-code" }));
  const marker = trimmedServer.logs.find((l) => l.sid === CLAUDE_SID && l.marker)!;
  assert.ok(Number(marker.attrs["import.session_start_ms"]) >= since);
  assert.equal(marker.attrs["import.tokens"], String((7 + 9 + 500) + (40 + 30)));
});

test("per-source months and first/last event cover what was imported (or would be)", async () => {
  const sessions = await fixtureSessions();
  const server = new FakeServer();
  const r = await runImport(opts(server, setup(), { dryRun: true }));
  const claude = r.sources.find((s) => s.source === "claude-code")!;
  const codex = r.sources.find((s) => s.source === "codex")!;
  const claudeTokens = sessions.find((s) => s.sid === CLAUDE_SID)!.tokens;
  assert.deepEqual(claude.months, [{ month: "2026-10", sessions: 1, tokens: claudeTokens }]);
  assert.equal(codex.months.reduce((n, m) => n + m.sessions, 0), 2);
  assert.equal(claude.firstEventMs, sessions.find((s) => s.sid === CLAUDE_SID)!.startMs);
  assert.equal(claude.lastEventMs, sessions.find((s) => s.sid === CLAUDE_SID)!.endMs);
  server.live.add(CLAUDE_SID);
  const live = await runImport(opts(server, setup(), { dryRun: true }));
  assert.deepEqual(live.sources.find((s) => s.source === "claude-code")!.months, [], "a live-skipped session is not in the months");
  assert.equal(live.sources.find((s) => s.source === "claude-code")!.firstEventMs, null);
});
