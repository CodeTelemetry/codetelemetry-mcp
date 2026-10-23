// In-browser history import (the web upload path), driven with Node's own File
// and Web Crypto: same parsers, same core, an in-memory ledger — and the review
// findings of #165 pinned: the commit marker is posted, a re-upload is skipped
// as already imported, and the window trims per event.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { importFiles, sha256HexWeb, type UploadFile } from "../../src/client/import/browser.ts";
import { ALL_CONTENT } from "../../src/client/import/model.ts";
import { API, CLAUDE_SID, FakeServer, INGEST, KEY, NOW } from "./importFake.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "import");
const MTIME = Date.parse("2026-10-03T00:00:00Z");

function file(rel: string, lastModified = MTIME): UploadFile {
  const full = path.join(FIX, rel);
  return new File([fs.readFileSync(full)], path.basename(full), { lastModified });
}

const allFiles = () => [
  file("claude-projects/-work-app/cs-test-1.jsonl"),
  file("claude-projects/-work-app/cs-test-1/subagents/agent-a1.jsonl"),
  file("codex-sessions/2026/10/01/rollout-2026-10-01T09-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl"),
  file("codex-sessions/2026/10/02/rollout-2026-10-02T14-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002.jsonl"),
];

const base = (server: FakeServer) => ({
  key: KEY,
  apiBase: API,
  ingestEndpoint: INGEST,
  sinceMs: Date.parse("2026-09-15T00:00:00Z"),
  nowMs: NOW,
  fetchImpl: server.fetch as typeof fetch,
  sleep: async () => {},
});

test("web crypto hashing matches node's", async () => {
  assert.equal(await sha256HexWeb("plan ✓"), createHash("sha256").update("plan ✓").digest("hex"));
});

test("an upload commits every session with its marker, and a re-upload sends nothing", async () => {
  const server = new FakeServer();
  const first = await importFiles(allFiles(), { ...base(server), dryRun: false });
  assert.equal(first.ok, true, first.errors.join("; "));
  assert.equal(first.totals.sessions, 3, "the subagent transcript folds into its parent session");
  for (const sid of [CLAUDE_SID, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001", "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002"]) {
    assert.equal(server.logs.filter((l) => l.sid === sid && l.marker).length, 1, `${sid} committed`);
  }
  assert.ok(server.logs.every((l) => l.resource["import.tool"] === "web-upload"));
  assert.equal(server.tokenTotal(), (100 + 20 + 1000 + 50) + (10 + 5) + (7 + 9 + 500) + (40 + 30));

  const calls = server.ingestCalls.length;
  const again = await importFiles(allFiles(), { ...base(server), dryRun: false });
  assert.equal(again.ok, true);
  assert.equal(server.ingestCalls.length, calls, "a re-upload is skipped on the server's commit markers");
  assert.equal(again.sources.reduce((n, s) => n + (s.skipped.already_imported ?? 0), 0), 3);
});

test("the plan matches the CLI's for the same files, so either path dedups the other", async () => {
  const server = new FakeServer();
  await importFiles(allFiles(), { ...base(server), dryRun: false });
  const browserPlans = new Set(server.logs.map((l) => l.resource["import.plan"]));
  const { runImport } = await import("../../src/client/import/run.ts");
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-parity-"));
  fs.cpSync(FIX, root, { recursive: true });
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else fs.utimesSync(p, MTIME / 1000, MTIME / 1000);
    }
  };
  walk(root);
  const cli = await runImport({
    ...base(server),
    endpoints: { apiBase: API, ingestEndpoint: INGEST },
    claudeDir: path.join(root, "claude-projects"),
    codexDir: path.join(root, "codex-sessions"),
    ledgerPath: path.join(root, "ledger.json"),
  });
  assert.equal(cli.sources.reduce((n, s) => n + (s.skipped.already_imported ?? 0), 0), 3,
    "the CLI sees the browser's committed plans as its own");
  assert.equal(new Set(server.logs.map((l) => l.resource["import.plan"])).size, browserPlans.size);
});

test("uploads trim to the window and default to no content", async () => {
  const server = new FakeServer();
  await importFiles(allFiles(), { ...base(server), dryRun: false, sinceMs: Date.parse("2026-10-01T11:00:00Z") });
  const prompts = server.logs.filter((l) => l.attrs["event.name"] === "user_prompt");
  assert.deepEqual(prompts.map((p) => p.attrs["prompt.id"]), ["p-2"]);
  assert.ok(prompts.every((p) => p.attrs.prompt === "<REDACTED>"));
  assert.equal(server.tokenTotal(), (7 + 9 + 500) + (40 + 30));
});

test("an uncertain token part is not resent by a later upload until the server confirms", async () => {
  const server = new FakeServer();
  server.fault = (p, _part, attempt) => (p === "/v1/metrics" && attempt === 1 ? "store-then-timeout" : "ok");
  const first = await importFiles([allFiles()[0], allFiles()[1]], { ...base(server), dryRun: false });
  assert.equal(first.ok, false);
  // A later upload (fresh page, no ledger): the server's partial plan forces a probe.
  const later = await importFiles([allFiles()[0], allFiles()[1]], { ...base(server), dryRun: false, nowMs: NOW + 3_600_000 });
  assert.equal(later.ok, true, later.errors.join("; "));
  assert.ok(server.statusCalls.some((c) => c.sessions.some((s: any) => s.probePlan)));
  assert.equal(server.tokenTotal(), (100 + 20 + 1000 + 50) + (10 + 5) + (7 + 9 + 500) + (40 + 30), "no double count");
});

test("uploads refuse non-session files, oversize files, and bad keys", async () => {
  const server = new FakeServer();
  const junk = new File(["hello"], "notes.txt", { lastModified: MTIME });
  const notSession = new File(['{"hello":1}\n'], "x.jsonl", { lastModified: MTIME });
  const r = await importFiles([junk, notSession], { ...base(server), dryRun: true });
  assert.equal(r.totals.sessions, 0);
  assert.ok(r.warnings.some((w) => /notes\.txt/.test(w)));
  assert.ok(r.warnings.some((w) => /x\.jsonl: not a Claude Code transcript/.test(w)));
  const huge = { name: "big.jsonl", size: 600 * 1024 * 1024, lastModified: MTIME, text: async () => "" };
  const big = await importFiles([huge], { ...base(server), dryRun: true });
  assert.ok(big.warnings.some((w) => /too large/.test(w) && /connect import/.test(w)));
  await assert.rejects(importFiles(allFiles(), { ...base(server), key: "nope", dryRun: true }), /ingest key/);
});

test("content opt-in in the browser carries prompt text", async () => {
  const server = new FakeServer();
  await importFiles(allFiles(), { ...base(server), dryRun: false, content: { "claude-code": ALL_CONTENT, codex: ALL_CONTENT } });
  assert.ok(server.logs.some((l) => l.attrs.prompt === "review the retry loop"));
});
