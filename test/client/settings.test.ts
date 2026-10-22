// Repository hook cases explicitly opt in; default opt-out is covered by clientEdgeCases.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeSettings, writeSettings, buildEnvBlock, readSettingsSummary, LEGACY_BROKEN_RESOURCE_ATTRS } from "../../src/client/settings.ts";
import {
  normalizeRepositoryRemote,
  REPOSITORY_HOOK_FILE,
  REPOSITORY_HOOK_MARKER,
} from "../../src/client/repositoryHook.ts";
import { tmpSettingsPath } from "../support/helpers.ts";

const KEY = "cot_abcdefghijklmnopqrstuvwxyz012345";
const ENDPOINT = "https://ingest.example.com";

test("mergeSettings preserves unrelated keys and existing env", () => {
  const existing = { permissions: { allow: ["Bash"] }, env: { FOO: "1", OTEL_LOGS_EXPORTER: "stale" } };
  const merged = mergeSettings(existing, { OTEL_LOGS_EXPORTER: "otlp", CLAUDE_CODE_ENABLE_TELEMETRY: "1" }) as any;
  assert.deepEqual(merged.permissions, { allow: ["Bash"] }); // untouched
  assert.equal(merged.env.FOO, "1"); // untouched env var
  assert.equal(merged.env.OTEL_LOGS_EXPORTER, "otlp"); // overwritten
  assert.equal(merged.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1"); // added
});

test("buildEnvBlock: base is 6 vars, enrich adds the opt-in flags", () => {
  const base = buildEnvBlock(KEY, ENDPOINT, false);
  assert.equal(Object.keys(base).length, 6);
  assert.equal(base.OTEL_EXPORTER_OTLP_ENDPOINT, ENDPOINT);
  assert.equal(base.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${KEY}`);
  const enriched = buildEnvBlock(KEY, ENDPOINT, true);
  assert.ok(Object.keys(enriched).length > 6);
  assert.equal(enriched.OTEL_LOG_USER_PROMPTS, "1");
});

test("enrich never writes OTEL_RESOURCE_ATTRIBUTES (settings env is verbatim — $PWD would not expand)", () => {
  const enriched = buildEnvBlock(KEY, ENDPOINT, true);
  assert.ok(!("OTEL_RESOURCE_ATTRIBUTES" in enriched));
});

test("mergeSettings scrubs the legacy literal-$PWD value but preserves a user's own", () => {
  const poisoned = { env: { OTEL_RESOURCE_ATTRIBUTES: LEGACY_BROKEN_RESOURCE_ATTRS, KEEP: "yes" } };
  const repaired = mergeSettings(poisoned, { CLAUDE_CODE_ENABLE_TELEMETRY: "1" }) as any;
  assert.ok(!("OTEL_RESOURCE_ATTRIBUTES" in repaired.env)); // exact broken value removed
  assert.equal(repaired.env.KEEP, "yes");
  const custom = { env: { OTEL_RESOURCE_ATTRIBUTES: "project.path=/Users/a/repo" } };
  const kept = mergeSettings(custom, { CLAUDE_CODE_ENABLE_TELEMETRY: "1" }) as any;
  assert.equal(kept.env.OTEL_RESOURCE_ATTRIBUTES, "project.path=/Users/a/repo"); // user value untouched
});

test("writeSettings creates the file, returns key NAMES not values", () => {
  const p = tmpSettingsPath();
  const r = writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p });
  assert.equal(r.created, true);
  assert.equal(r.backupPath, null);
  // wrote is env KEYS only — the secret must never be in there.
  assert.ok(r.wrote.includes("OTEL_EXPORTER_OTLP_HEADERS"));
  assert.ok(!JSON.stringify(r.wrote).includes("cot_"));
  // but the file on disk DOES carry the key (that's its job).
  const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(onDisk.env.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${KEY}`);
});

test("writeSettings is idempotent and backs up an existing file", () => {
  const p = tmpSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ env: { KEEP: "yes" }, model: "opus" }, null, 2));
  const r1 = writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p });
  assert.ok(r1.backupPath && fs.existsSync(r1.backupPath)); // backup made
  const first = fs.readFileSync(p, "utf8");
  const r2 = writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p });
  const second = fs.readFileSync(p, "utf8");
  assert.equal(first, second); // idempotent content
  const obj = JSON.parse(second);
  assert.equal(obj.model, "opus"); // preserved
  assert.equal(obj.env.KEEP, "yes"); // preserved
  assert.ok(r2.backupPath);
});

test("default connect installs idempotent repository observations without prompt enrichment or key copying", () => {
  const p = tmpSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }],
    },
  }));
  writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p });
  writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p });
  const settings = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(settings.env.OTEL_LOG_USER_PROMPTS, undefined,
    "repository identity must not opt the user into raw prompt capture");
  assert.equal(settings.hooks.SessionStart.filter((g: any) =>
    g.hooks?.some((h: any) => String(h.command).includes(REPOSITORY_HOOK_MARKER))).length, 1);
  assert.equal(settings.hooks.CwdChanged.filter((g: any) =>
    g.hooks?.some((h: any) => String(h.command).includes(REPOSITORY_HOOK_MARKER))).length, 1);
  assert.ok(settings.hooks.SessionStart.some((g: any) => g.hooks?.some((h: any) => h.command === "echo keep")));
  const hook = fs.readFileSync(path.join(path.dirname(p), REPOSITORY_HOOK_FILE), "utf8");
  assert.match(hook, /codetelemetry\.repository_observed/);
  assert.match(hook, /code\.repository\.id/);
  assert.match(hook, /remoteName\(remote\)/, "display name comes from the clone-stable remote, not a worktree basename");
  assert.match(hook, /--max-parents=0/, "no-remote repositories fall back to a clone-stable root commit");
  assert.match(hook, /--git-common-dir/, "linked worktrees resolve the common repository root");
  assert.match(hook, /const idempotencyKey = crypto\.randomUUID\(\)/,
    "each direct hook delivery mints a fresh retry identity");
  assert.match(hook, /"x-code-telemetry-idempotency-key": idempotencyKey/);
  assert.doesNotMatch(hook, /"x-code-telemetry-idempotency-key":\s*"[^"]+"/,
    "the installed hook must not reuse one static delivery key");
  assert.ok(!hook.includes(KEY));
});

test("repository identity ignores clone transport, username, and credentials", () => {
  const expected = "github.com/example/project";
  for (const remote of [
    "https://github.com/example/project.git",
    "https://user:password@github.com/example/project.git",
    "git@github.com:example/project.git",
    "alice@github.com:example/project.git",
    "ssh://git@github.com/example/project.git",
  ]) {
    assert.equal(normalizeRepositoryRemote(remote), expected);
  }
});

test("writeSettings refuses to clobber invalid JSON", () => {
  const p = tmpSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{ not: valid json, // comment\n}");
  assert.throws(() => writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p }), /isn't valid JSON/);
});

test("readSettingsSummary reports OTEL keys + key presence without leaking it", () => {
  const p = tmpSettingsPath();
  writeSettings({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, settingsPath: p });
  const s = readSettingsSummary(p);
  assert.equal(s.exists, true);
  assert.equal(s.hasKey, true);
  assert.ok(s.otelKeys.includes("OTEL_EXPORTER_OTLP_ENDPOINT"));
  assert.ok(!JSON.stringify(s).includes(KEY));
});
