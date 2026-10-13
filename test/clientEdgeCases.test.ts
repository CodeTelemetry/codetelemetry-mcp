import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEndpoints } from "../src/client/config.ts";
import { writeSettings } from "../src/client/settings.ts";
import { writeCodexConfig } from "../src/client/codexConfig.ts";
import { checkOnce, confirmLanded, verifyScope } from "../src/client/connectivity.ts";
import { pollForKey, pollOnce, requestDeviceCode } from "../src/client/deviceClient.ts";
import {
  quotedCommand,
  CODEX_HOOKS_FILE,
  REPOSITORY_HOOK_FILE,
  selectCodexOtelExporterLine,
} from "../src/client/repositoryHook.ts";
import type { FetchLike } from "../src/client/otlp.ts";

const KEY = "cot_" + "clientedgecaseclientedgecase01";

test("repository observation hooks require an explicit opt-in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-hook-consent-"));
  const claudeSettings = path.join(root, "claude", "settings.json");
  const codexConfig = path.join(root, "codex", "config.toml");

  writeSettings({ key: KEY, ingestEndpoint: "https://ingest.codetelemetry.com", settingsPath: claudeSettings });
  writeCodexConfig({ key: KEY, ingestEndpoint: "https://ingest.codetelemetry.com", configPath: codexConfig });
  assert.equal(fs.existsSync(path.join(path.dirname(claudeSettings), REPOSITORY_HOOK_FILE)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(codexConfig), REPOSITORY_HOOK_FILE)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(codexConfig), CODEX_HOOKS_FILE)), false);
  assert.equal(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks, undefined);

  writeSettings({
    key: KEY,
    ingestEndpoint: "https://ingest.codetelemetry.com",
    settingsPath: claudeSettings,
    repositoryObservation: true,
  });
  writeCodexConfig({
    key: KEY,
    ingestEndpoint: "https://ingest.codetelemetry.com",
    configPath: codexConfig,
    repositoryObservation: true,
  });
  assert.equal(fs.existsSync(path.join(path.dirname(claudeSettings), REPOSITORY_HOOK_FILE)), true);
  assert.equal(fs.existsSync(path.join(path.dirname(codexConfig), REPOSITORY_HOOK_FILE)), true);
  assert.equal(fs.existsSync(path.join(path.dirname(codexConfig), CODEX_HOOKS_FILE)), true);

  const codexHooksPath = path.join(path.dirname(codexConfig), CODEX_HOOKS_FILE);
  const codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
  codexHooks.hooks.AfterAgent = [{ hooks: [{ type: "command", command: "user-owned-hook" }] }];
  fs.writeFileSync(codexHooksPath, JSON.stringify(codexHooks));
  writeSettings({ key: KEY, ingestEndpoint: "https://ingest.codetelemetry.com", settingsPath: claudeSettings });
  writeCodexConfig({ key: KEY, ingestEndpoint: "https://ingest.codetelemetry.com", configPath: codexConfig });
  assert.equal(fs.existsSync(path.join(path.dirname(claudeSettings), REPOSITORY_HOOK_FILE)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(codexConfig), REPOSITORY_HOOK_FILE)), false);
  const afterOptOut = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
  assert.deepEqual(afterOptOut.hooks, {
    AfterAgent: [{ hooks: [{ type: "command", command: "user-owned-hook" }] }],
  });
  assert.equal(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks, undefined);
});

function hangsUntilAborted(): FetchLike {
  return async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

test("Codex repository hooks read only the active top-level otel exporter", () => {
  const raw = [
    "[unrelated]",
    'exporter = { otlp-http = { endpoint = "https://wrong.example/v1/logs", headers = { authorization = "Bearer wrong" } } }',
    "values = [",
    '  "[otel]",',
    "]",
    "[otel]",
    'exporter = { otlp-http = { endpoint = "https://ingest.codetelemetry.com/v1/logs", headers = { authorization = "Bearer right" } } }',
    "[after]",
    'exporter = "also-wrong"',
  ].join("\n");
  const selected = selectCodexOtelExporterLine(raw);
  assert.match(selected, /ingest\.codetelemetry\.com/);
  assert.doesNotMatch(selected, /wrong\.example|also-wrong/);
});

test("Codex repository hooks fail closed around multiline TOML strings", () => {
  const raw = [
    'instructions = """',
    "[otel]",
    'exporter = { endpoint = "https://wrong.example/v1/logs" }',
    '"""',
    "[otel]",
    'exporter = { endpoint = "https://ingest.codetelemetry.com/v1/logs" }',
  ].join("\n");
  assert.equal(selectCodexOtelExporterLine(raw), "");
});

test("Codex repository opt-out disables the helper even when hooks JSON is malformed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-hook-malformed-optout-"));
  const configPath = path.join(root, "config.toml");
  writeCodexConfig({
    key: KEY,
    ingestEndpoint: "https://ingest.codetelemetry.com",
    configPath,
    repositoryObservation: true,
  });
  const hooksPath = path.join(root, CODEX_HOOKS_FILE);
  const installedHooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  fs.writeFileSync(hooksPath, "{not-json");
  writeCodexConfig({ key: KEY, ingestEndpoint: "https://ingest.codetelemetry.com", configPath });
  assert.equal(fs.existsSync(path.join(root, REPOSITORY_HOOK_FILE)), false);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), "{not-json",
    "malformed user-owned JSON is not rewritten while its managed command is made inert");

  installedHooks.hooks.AfterAgent = [{ hooks: [{ type: "command", command: "user-owned-hook" }] }];
  fs.writeFileSync(hooksPath, JSON.stringify(installedHooks));
  writeCodexConfig({ key: KEY, ingestEndpoint: "https://ingest.codetelemetry.com", configPath });
  const afterRepair = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.deepEqual(afterRepair.hooks, {
    AfterAgent: [{ hooks: [{ type: "command", command: "user-owned-hook" }] }],
  }, "a later opt-out removes stale managed commands after the user repairs hooks JSON");
});

test("hook commands use platform-correct argument quoting", () => {
  const file = "C:\\Users\\Example User\\hook.cjs";
  const windows = quotedCommand(file, "win32");
  assert.match(windows, /^"[^"]+" "C:\\Users\\Example User\\hook\.cjs" "codetelemetry-repository-observation"$/);
  assert.ok(!windows.includes("'"));

  const posix = quotedCommand("/tmp/example user's/hook.cjs", "linux");
  assert.match(posix, /'\/tmp\/example user'\\''s\/hook\.cjs'/);
});

test("a single device-token poll is bounded", async () => {
  const endpoints = resolveEndpoints({ apiBase: "https://example.invalid" });
  const started = Date.now();
  const result = await pollOnce(endpoints, "device", hangsUntilAborted(), 25);
  assert.deepEqual(result, { status: "pending" });
  assert.ok(Date.now() - started < 500);
});

test("requesting a device code is bounded", async () => {
  const endpoints = resolveEndpoints({ apiBase: "https://example.invalid" });
  const started = Date.now();
  await assert.rejects(
    requestDeviceCode(endpoints, hangsUntilAborted(), 25),
    /timed out/,
  );
  assert.ok(Date.now() - started < 500);
});

test("a stalled device-code response body reports the bounded timeout", async () => {
  const endpoints = resolveEndpoints({ apiBase: "https://example.invalid" });
  const fetchImpl: FetchLike = async (_input, init) => ({
    ok: true,
    status: 200,
    json: async () => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("raw body abort")), { once: true });
    }),
  }) as Response;
  await assert.rejects(
    requestDeviceCode(endpoints, fetchImpl, 25),
    /device authorization request timed out/,
  );
});

test("the device authorization deadline bounds an in-flight poll", async () => {
  const endpoints = resolveEndpoints({ apiBase: "https://example.invalid" });
  const started = Date.now();
  await assert.rejects(
    pollForKey(endpoints, "device", { timeoutMs: 25, fetchImpl: hangsUntilAborted() }),
    /timed out/,
  );
  assert.ok(Date.now() - started < 500);
});

test("the telemetry verification deadline bounds its final request", async () => {
  const started = Date.now();
  await assert.rejects(
    confirmLanded({
      key: KEY,
      connectivityUrl: "https://example.invalid/check",
      probeId: "probe",
      timeoutMs: 25,
      fetchImpl: hangsUntilAborted(),
    }),
    /aborted/,
  );
  assert.ok(Date.now() - started < 500);
});

const CHECK_URL = "https://example.invalid/check";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("telemetry verification polls through transient states and stops at terminal ones", async () => {
  // A probe accepted on the account's last credit, or during a dashboard read
  // blip, can become visible a moment later, so those states keep polling.
  const transient = ["budget_exhausted", "dashboard_read_failure"];
  let calls = 0;
  const landed = await confirmLanded({
    key: KEY,
    connectivityUrl: CHECK_URL,
    probeId: "probe",
    intervalMs: 1,
    timeoutMs: 5_000,
    fetchImpl: async () => {
      const state = transient[calls++];
      return jsonResponse(state ? { seen: false, state } : { seen: true, state: "connected" });
    },
  });
  assert.equal(landed.landed, true);
  assert.equal(landed.polls, 3);
  assert.equal(landed.state, "connected");

  // A rejected key will not fix itself: one poll, and the reason comes back.
  let terminalCalls = 0;
  const refused = await confirmLanded({
    key: KEY,
    connectivityUrl: CHECK_URL,
    probeId: "probe",
    intervalMs: 1,
    timeoutMs: 5_000,
    fetchImpl: async () => {
      terminalCalls += 1;
      return new Response("unauthorized", { status: 401 });
    },
  });
  assert.equal(terminalCalls, 1);
  assert.equal(refused.landed, false);
  assert.equal(refused.state, "invalid_key");
  assert.equal(refused.httpStatus, 401);
});

test("telemetry verification out of time reports the last diagnostic, or not-yet-seen", async () => {
  let calls = 0;
  const none = await confirmLanded({
    key: KEY,
    connectivityUrl: CHECK_URL,
    probeId: "probe",
    timeoutMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ seen: true });
    },
  });
  assert.equal(calls, 0, "no time left means no request");
  assert.equal(none.landed, false);
  assert.equal(none.state, "ingestion_delay");
  assert.equal(none.polls, 0);

  // The clock jumps past the deadline while waiting between polls: the result
  // keeps what the last check said instead of inventing a state.
  const clock = [0, 0, 10, 200, 200];
  let tick = 0;
  const late = await confirmLanded({
    key: KEY,
    connectivityUrl: CHECK_URL,
    probeId: "probe",
    intervalMs: 1,
    timeoutMs: 100,
    now: () => clock[Math.min(tick++, clock.length - 1)]!,
    fetchImpl: async () => jsonResponse({ seen: false, state: "budget_exhausted" }),
  });
  assert.equal(late.landed, false);
  assert.equal(late.state, "budget_exhausted");
  assert.equal(late.polls, 1);
  assert.equal(late.elapsedMs, 200);
});

test("a null connectivity body means not seen, never a crash", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse(null);
  const checked = await checkOnce({ key: KEY, connectivityUrl: CHECK_URL, probeId: "probe", fetchImpl });
  assert.deepEqual(checked, { seen: false, httpStatus: 200, state: "ingestion_delay" });
  const scoped = await verifyScope({ key: KEY, connectivityUrl: CHECK_URL, expected: { tenantId: "tenant-a" }, fetchImpl });
  assert.deepEqual(scoped, { seen: false, httpStatus: 200, state: "unknown_failure" });
});

test("a scope-fenced device flow uses the versioned routes and returns only a well-formed scope", async () => {
  const endpoints = resolveEndpoints({ apiBase: "https://example.invalid" });
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let scope: unknown = { tenantId: "tenant-a", teamId: null, billingAccountId: "billing-a" };
  const fetchImpl: FetchLike = async (input, init) => {
    urls.push(String(input));
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    if (String(input).includes("/api/device/code")) {
      return jsonResponse({ device_code: "device", user_code: "ABCD-EFGH", expires_in: 600, interval: 2 });
    }
    return jsonResponse({ api_key: KEY, ingest_endpoint: "https://ingest.example.invalid", scope });
  };

  const code = await requestDeviceCode(endpoints, fetchImpl, 1_000, { tenantId: "tenant-a" });
  assert.equal(code.scopeFenced, true);
  const authorized = await pollOnce(endpoints, code.deviceCode, fetchImpl, 1_000, { scopeFenced: code.scopeFenced });
  assert.deepEqual(urls, [endpoints.deviceScopedCodeUrl, endpoints.deviceScopedTokenUrl]);
  assert.deepEqual(bodies[0], { client: "codetelemetry-connect", expected: { tenantId: "tenant-a" } });
  assert.deepEqual(authorized, {
    status: "authorized",
    apiKey: KEY,
    ingestEndpoint: "https://ingest.example.invalid",
    scope: { tenantId: "tenant-a", teamId: null, billingAccountId: "billing-a" },
  });

  // No expected scope: the unversioned routes, exactly as before. A malformed
  // scope from the server is dropped rather than passed on.
  urls.length = 0;
  scope = { tenantId: "", teamId: null, billingAccountId: "billing-a" };
  const plain = await requestDeviceCode(endpoints, fetchImpl);
  assert.equal(plain.scopeFenced, false);
  const key = await pollForKey(endpoints, plain.deviceCode, { fetchImpl, scopeFenced: plain.scopeFenced });
  assert.deepEqual(urls, [endpoints.deviceCodeUrl, endpoints.deviceTokenUrl]);
  assert.deepEqual(key, { apiKey: KEY, ingestEndpoint: "https://ingest.example.invalid" });
});
