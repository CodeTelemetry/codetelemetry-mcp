// Session-history import, end to end against an in-memory fake of the two
// server surfaces it talks to (OTLP ingest + /api/agent/import-status). Nothing
// here touches a real endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runImport, type ImportRunOptions } from "../../src/client/import/run.ts";
import { ALL_CONTENT } from "../../src/client/import/model.ts";
import { resolveImportKey, parseContentFlag, resolveImportContent, parseWhen } from "../../src/client/import/options.ts";
import { run as cli } from "../../src/client/cli.ts";
import { API, CLAUDE_SID, FakeServer, INGEST, KEY, NOW } from "./importFake.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "import");

/** Copy the fixtures to a temp home with fixed mtimes (the importer filters on them). */
function setup(mtime = Date.parse("2026-10-03T00:00:00Z")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-import-"));
  fs.cpSync(FIX, root, { recursive: true });
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else fs.utimesSync(p, mtime / 1000, mtime / 1000);
    }
  };
  walk(root);
  return {
    claudeDir: path.join(root, "claude-projects"),
    codexDir: path.join(root, "codex-sessions"),
    ledgerPath: path.join(root, "ledger", "import-ledger.json"),
    root,
  };
}

const EXPECTED_CLAUDE_TOKENS = (100 + 20 + 1000 + 50) + (10 + 5) + (7 + 9 + 500) + (40 + 30);

function opts(server: FakeServer, dirs: ReturnType<typeof setup>, over: Partial<ImportRunOptions> = {}): ImportRunOptions {
  return {
    key: KEY,
    endpoints: { apiBase: API, ingestEndpoint: INGEST },
    sinceMs: Date.parse("2026-09-15T00:00:00Z"),
    nowMs: NOW,
    fetchImpl: server.fetch as typeof fetch,
    sleep: async () => {},
    claudeDir: dirs.claudeDir,
    codexDir: dirs.codexDir,
    ledgerPath: dirs.ledgerPath,
    ...over,
  };
}

test("a fresh import sends every session once, tagged, committed last; the library sends no content unless the caller passes a policy", async () => {
  const server = new FakeServer();
  const dirs = setup();
  const r = await runImport(opts(server, dirs));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.totals.sessions, 3);
  assert.equal(server.tokenTotal(), EXPECTED_CLAUDE_TOKENS, "Claude tokens land exactly once");
  // Commit marker is each session's last request.
  for (const sid of [CLAUDE_SID, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001", "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002"]) {
    const rows = server.logs.filter((l) => l.sid === sid);
    assert.equal(rows.filter((l) => l.marker).length, 1, `${sid} has one marker`);
  }
  const claudeCalls = server.ingestCalls.filter((c) => c.part === "C" || c.path === "/v1/metrics" || c.part.startsWith("L"));
  assert.ok(claudeCalls.length >= 3);
  for (const l of server.logs) {
    assert.equal(l.resource["ingest.source"], "history-import");
    assert.equal(l.resource["import.tool"], "connect-cli");
    assert.match(String(l.resource["import.plan"]), /^[a-f0-9]{32}$/);
    if (l.attrs.prompt !== undefined) assert.equal(l.attrs.prompt, "<REDACTED>");
    assert.equal(l.attrs.tool_input, undefined);
    assert.equal(l.attrs.arguments, undefined);
  }
  assert.equal(server.logs.find((l) => l.sid === CLAUDE_SID)!.resource["project.path"], "/work/app");
  const claude = r.sources.find((s) => s.source === "claude-code")!;
  assert.equal(claude.imported, 1);
  assert.equal(claude.tokens.input, 100 + 10 + 7 + 40);
});

test("a re-run is a no-op: unchanged finished sessions are skipped from the ledger without a request", async () => {
  const server = new FakeServer();
  const dirs = setup();
  await runImport(opts(server, dirs));
  const before = server.ingestCalls.length;
  const statusBefore = server.statusCalls.length;
  const r = await runImport(opts(server, dirs));
  assert.equal(r.ok, true);
  assert.equal(server.ingestCalls.length, before, "nothing is resent");
  assert.equal(server.statusCalls.length, statusBefore);
  assert.equal(r.sources.reduce((n, s) => n + (s.skipped.ledger ?? 0), 0), 3);
});

test("without the ledger, the server's commit markers still prevent a second import", async () => {
  const server = new FakeServer();
  const dirs = setup();
  await runImport(opts(server, dirs));
  fs.rmSync(path.dirname(dirs.ledgerPath), { recursive: true, force: true });
  const before = server.ingestCalls.length;
  const r = await runImport(opts(server, dirs));
  assert.equal(server.ingestCalls.length, before);
  assert.equal(r.sources.reduce((n, s) => n + (s.skipped.already_imported ?? 0), 0), 3);
  assert.equal(server.tokenTotal(), EXPECTED_CLAUDE_TOKENS);
});

test("sessions already captured live are never imported", async () => {
  const server = new FakeServer();
  server.live.add(CLAUDE_SID);
  const r = await runImport(opts(server, setup()));
  assert.equal(r.sources.find((s) => s.source === "claude-code")!.skipped.live, 1);
  assert.equal(server.logs.filter((l) => l.sid === CLAUDE_SID).length, 0);
  assert.equal(r.totals.sessions, 2);
});

test("402 stops the run with a clear billing message, and the next run resumes without duplicating tokens", async () => {
  const server = new FakeServer();
  const dirs = setup();
  let budget = false;
  server.fault = (p) => (p === "/v1/metrics" && !budget ? "402" : "ok");
  const first = await runImport(opts(server, dirs, { source: "claude-code" }));
  assert.equal(first.ok, false);
  assert.equal(first.stoppedBy, "budget");
  assert.equal(first.topup, "https://codetelemetry.com/billing");
  assert.ok(first.errors.some((e) => /prepaid credit is exhausted/.test(e) && /re-run/.test(e)));
  assert.equal(first.remaining, 1);
  const metricAttempts = server.ingestCalls.filter((c) => c.path === "/v1/metrics").length;
  assert.equal(metricAttempts, 1, "a 402 is never retried");
  const logPartsSent = server.ingestCalls.filter((c) => c.part.startsWith("L")).length;

  budget = true; // credit added
  const second = await runImport(opts(server, dirs, { source: "claude-code", nowMs: NOW + 3_600_000 }));
  assert.equal(second.ok, true, second.errors.join("; "));
  assert.equal(second.sources[0].resumed, 1);
  assert.equal(server.ingestCalls.filter((c) => c.part.startsWith("L")).length, logPartsSent, "accepted log parts are not resent");
  assert.equal(server.tokenTotal(), EXPECTED_CLAUDE_TOKENS);
});

test("a token part with an unknown outcome is verified with the server, never blindly resent", async () => {
  const server = new FakeServer();
  const dirs = setup();
  server.fault = (p, _part, attempt) => (p === "/v1/metrics" && attempt === 1 ? "store-then-timeout" : "ok");
  const first = await runImport(opts(server, dirs, { source: "claude-code" }));
  assert.equal(first.ok, false);
  assert.ok(first.errors.some((e) => /never blindly resent/.test(e)));
  assert.equal(server.tokenTotal(), EXPECTED_CLAUDE_TOKENS, "the part landed despite the timeout");

  const soon = await runImport(opts(server, dirs, { source: "claude-code", nowMs: NOW + 30_000 }));
  assert.equal(soon.sources[0].skipped.settling, 1, "too soon to trust an absence");

  const later = await runImport(opts(server, dirs, { source: "claude-code", nowMs: NOW + 3_600_000 }));
  assert.equal(later.ok, true, later.errors.join("; "));
  assert.ok(server.statusCalls.some((c) => c.sessions.some((s: any) => s.probePlan)), "the plan's metric parts were probed");
  assert.equal(server.tokenTotal(), EXPECTED_CLAUDE_TOKENS, "the landed part was not sent again");
  assert.equal(server.logs.filter((l) => l.sid === CLAUDE_SID && l.marker).length, 1);
});

test("an ambiguous 502 on a token part is treated like a timeout, not retried", async () => {
  const server = new FakeServer();
  server.fault = (p) => (p === "/v1/metrics" ? "502" : "ok");
  const r = await runImport(opts(server, setup(), { source: "claude-code" }));
  assert.equal(server.ingestCalls.filter((c) => c.path === "/v1/metrics").length, 1);
  assert.equal(r.ok, false);
});

test("log parts retry through transient failures (they collapse on read)", async () => {
  const server = new FakeServer();
  server.fault = (p, _part, attempt) => (p === "/v1/logs" && attempt < 3 ? (attempt === 1 ? "network" : "502") : "ok");
  const r = await runImport(opts(server, setup(), { source: "codex" }));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.totals.sessions, 2);
});

test("persistent rate limiting stops the run after a bounded number of attempts", async () => {
  const server = new FakeServer();
  const sleeps: number[] = [];
  server.fault = () => "429";
  const r = await runImport(opts(server, setup(), { sleep: async (ms) => { sleeps.push(ms); } }));
  assert.equal(r.stoppedBy, "busy");
  assert.ok(server.ingestCalls.length <= 6, `bounded attempts (${server.ingestCalls.length})`);
  assert.ok(sleeps.some((ms) => ms >= 2_000), "backs off between attempts");
  assert.equal(server.logs.length, 0);
});

test("pre-forward 503 'capacity busy' is retried; nothing is lost or duplicated", async () => {
  const server = new FakeServer();
  server.fault = (_p, _part, attempt) => (attempt === 1 ? "503busy" : "ok");
  const r = await runImport(opts(server, setup(), { source: "claude-code" }));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(server.tokenTotal(), EXPECTED_CLAUDE_TOKENS);
});

test("if the import-status check is unavailable nothing is sent", async () => {
  const server = new FakeServer();
  server.statusFault = 404;
  const r = await runImport(opts(server, setup()));
  assert.equal(r.ok, false);
  assert.equal(r.stoppedBy, "status_unavailable");
  assert.equal(server.ingestCalls.length, 0);
  assert.ok(r.errors.some((e) => /Nothing was sent/.test(e)));
});

test("a dry run still summarizes the files when the status check is unavailable, and says so", async () => {
  const server = new FakeServer();
  server.statusFault = 404;
  const r = await runImport(opts(server, setup(), { dryRun: true }));
  assert.equal(r.ok, true);
  assert.equal(r.totals.sessions, 3);
  assert.ok(r.warnings.some((w) => /checks were skipped for this dry run/.test(w)));
  assert.equal(server.ingestCalls.length, 0);
});

test("a dry run checks status and counts, but sends nothing and writes no ledger", async () => {
  const server = new FakeServer();
  const dirs = setup();
  const r = await runImport(opts(server, dirs, { dryRun: true }));
  assert.equal(r.ok, true);
  assert.equal(r.totals.sessions, 3);
  assert.equal(server.ingestCalls.length, 0);
  assert.ok(server.statusCalls.length >= 1);
  assert.equal(fs.existsSync(dirs.ledgerPath), false);
});

test("--since trims a straddling session to the window; the token total matches what was sent", async () => {
  const server = new FakeServer();
  const r = await runImport(opts(server, setup(), { source: "claude-code", sinceMs: Date.parse("2026-10-01T11:00:00Z") }));
  assert.equal(r.ok, true, r.errors.join("; "));
  const prompts = server.logs.filter((l) => l.attrs["event.name"] === "user_prompt");
  assert.deepEqual(prompts.map((p) => p.attrs["prompt.id"]), ["p-2"]);
  assert.equal(server.tokenTotal(), (7 + 9 + 500) + (40 + 30), "only in-window calls are billed");
  assert.ok(r.warnings.some((w) => /in-window/.test(w)));
});

test("content opt-in sends prompt text and tool input", async () => {
  const server = new FakeServer();
  await runImport(opts(server, setup(), { content: { "claude-code": ALL_CONTENT, codex: ALL_CONTENT } }));
  assert.ok(server.logs.some((l) => l.attrs.prompt === "Fix the login bug in /work/app/src/login.ts"));
  assert.ok(server.logs.some((l) => l.attrs.arguments === "{\"cmd\":\"npm test\"}"));
});

test("the window is clamped to raw retention, and active or out-of-window files are not read", async () => {
  const server = new FakeServer();
  const old = await runImport(opts(server, setup(), { sinceMs: Date.parse("2024-01-01T00:00:00Z"), dryRun: true }));
  assert.equal(old.window.clamped, true);
  assert.ok(Date.parse(old.window.sinceIso) >= NOW - 365 * 86_400_000);
  const active = await runImport(opts(server, setup(NOW - 60_000), { dryRun: true }));
  assert.equal(active.sources.reduce((n, s) => n + (s.skipped.active ?? 0), 0), 3);
  const stale = await runImport(opts(server, setup(Date.parse("2026-09-01T00:00:00Z")), { dryRun: true }));
  assert.equal(stale.sources.reduce((n, s) => n + (s.skipped.older ?? 0), 0), 3);
});

test("--max-sessions pages through the history", async () => {
  const server = new FakeServer();
  const dirs = setup();
  const first = await runImport(opts(server, dirs, { maxSessions: 2 }));
  assert.equal(first.totals.sessions, 2);
  assert.equal(first.remaining, 1);
  const second = await runImport(opts(server, dirs, { maxSessions: 2 }));
  assert.equal(second.totals.sessions, 1);
  assert.equal(second.remaining, 0);
});

test("--project scopes by working directory, case-sensitively on Linux", async () => {
  const server = new FakeServer();
  const r = await runImport(opts(server, setup(), { project: "/work/App", dryRun: true }));
  assert.equal(r.totals.sessions, process.platform === "linux" ? 0 : 1);
  const s = await runImport(opts(server, setup(), { project: "/work/svc", dryRun: true }));
  assert.equal(s.totals.sessions, 2);
});

// ── Option resolution ──────────────────────────────────────────────────────

test("key: a Codex-only user imports with the key from ~/.codex/config.toml", () => {
  const paths = { claudeSettings: "/nope/settings.json", codexConfig: "/x/config.toml" };
  const r = resolveImportKey({ source: "codex", paths, readClaude: () => null, readCodex: () => KEY });
  assert.deepEqual(r, { key: KEY, from: "/x/config.toml" });
  const all = resolveImportKey({ source: "all", paths, readClaude: () => null, readCodex: () => KEY });
  assert.deepEqual(all, { key: KEY, from: "/x/config.toml" }, "--source all falls back to the Codex config");
  const both = resolveImportKey({ source: "all", paths, readClaude: () => KEY, readCodex: () => "cot_otherotherotherother0002" });
  assert.ok("error" in both && /different ingest keys/.test(both.error));
  const env = resolveImportKey({ source: "all", paths, env: KEY, readClaude: () => null, readCodex: () => null });
  assert.deepEqual(env, { key: KEY, from: "$CODETELEMETRY_INGEST_KEY" });
  const none = resolveImportKey({ source: "claude-code", paths, readClaude: () => null, readCodex: () => null });
  assert.ok("error" in none && /login --codex/.test(none.error));
});

test("key: the real Codex config reader finds the exporter key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-codex-"));
  const cfg = path.join(dir, "config.toml");
  fs.writeFileSync(cfg, [
    "[otel]",
    `exporter = { otlp-http = { endpoint = "https://ingest.codetelemetry.com/v1/logs", protocol = "binary", headers = { "Authorization" = "Bearer ${KEY}" } } }`,
    "log_user_prompt = true",
  ].join("\n"));
  const r = resolveImportKey({ source: "codex", paths: { claudeSettings: path.join(dir, "none.json"), codexConfig: cfg } });
  assert.deepEqual(r, { key: KEY, from: cfg });
  const live = resolveImportContent("live", { claudeSettings: path.join(dir, "none.json"), codexConfig: cfg });
  assert.deepEqual(live, { "claude-code": { prompts: false, toolDetails: false }, codex: { prompts: true, toolDetails: true } });
});

test("content flag: live by default (owner decision 2026-10-18), explicit lists, live mirrors Claude's env flags", () => {
  assert.equal(parseContentFlag(undefined), "live");
  assert.equal(parseContentFlag("none"), "none");
  assert.deepEqual(parseContentFlag("prompts"), { prompts: true, toolDetails: false });
  assert.deepEqual(parseContentFlag("tools,prompts"), { prompts: true, toolDetails: true });
  assert.equal(parseContentFlag("bodies"), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-claude-"));
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: "1", OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${KEY}` } }));
  const live = resolveImportContent("live", { claudeSettings: settings, codexConfig: path.join(dir, "none.toml") });
  assert.deepEqual(live["claude-code"], { prompts: true, toolDetails: false });
  assert.deepEqual(live.codex, { prompts: false, toolDetails: true });
});

test("window flags: days snap to UTC midnight, ISO dates parse, junk is refused", () => {
  assert.equal(parseWhen("30d", NOW), Date.parse("2026-09-10T00:00:00Z"));
  assert.equal(parseWhen("12h", NOW), NOW - 12 * 3_600_000);
  assert.equal(parseWhen("2026-09-01", NOW), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(parseWhen("yesterday", NOW), null);
});

test("cli: import refuses unknown flags and bad values before touching anything", async () => {
  assert.equal(await cli(["import", "--sinse", "30d"]), 1);
  assert.equal(await cli(["import", KEY, "--content", "bodies"]), 1);
  assert.equal(await cli(["import", KEY, "--since", "last week"]), 1);
  assert.equal(await cli(["import", KEY, "--source", "cursor"]), 1);
  // pi keeps no local transcripts the importer reads: refused, never a silent no-op.
  assert.equal(await cli(["import", KEY, "--client", "pi"]), 1);
  assert.equal(await cli(["import", KEY, "--source", "pi"]), 1);
  assert.equal(await cli(["import", KEY, "--client", "codex", "--source", "claude-code"]), 1);
});
