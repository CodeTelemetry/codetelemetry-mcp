// Repository hook cases explicitly opt in; default opt-out is covered by clientEdgeCases.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildOtelSection, writeCodexConfig, readCodexKey, readCodexSummary, resolveCodexConfigPath } from "../../src/client/codexConfig.ts";
import {
  CODEX_HOOKS_FILE,
  REPOSITORY_HOOK_FILE,
  REPOSITORY_HOOK_MARKER,
  REPOSITORY_HOOK_STATE_FILE,
  REPOSITORY_HOOK_STATE_MAX_ENTRIES,
} from "../../src/client/repositoryHook.ts";

const KEY = "cot_abcdefghijklmnopqrstuvwxyz012345";
const ENDPOINT = "https://ingest.example.com";

function tmpCodexPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cot-codex-"));
  return path.join(dir, ".codex", "config.toml");
}

function runRepositoryHook(args: {
  hookPath: string;
  capturePath: string;
  preloadPath: string;
  input: Record<string, unknown>;
  endpoint?: string | null;
  envHeaders?: string;
  httpResult?: string;
  releasePath?: string;
  requestMetadataPath?: string;
  gitDelayMs?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const cwd = String(args.input.cwd || process.cwd());
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CODETELEMETRY_TEST_CAPTURE_PATH: args.capturePath,
      CODETELEMETRY_TEST_HTTP_RESULT: args.httpResult ?? "200",
      CODETELEMETRY_TEST_RELEASE_PATH: args.releasePath ?? "",
      CODETELEMETRY_TEST_REQUEST_METADATA_PATH: args.requestMetadataPath ?? "",
      CODETELEMETRY_TEST_GIT_DELAY_MS: String(args.gitDelayMs ?? 0),
      OTEL_EXPORTER_OTLP_HEADERS: args.envHeaders ?? "",
    };
    if (args.endpoint === null) delete childEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
    else childEnv.OTEL_EXPORTER_OTLP_ENDPOINT = args.endpoint ?? "http://capture.invalid";
    const child = spawn(process.execPath, ["--require", args.preloadPath, args.hookPath], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`repository hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(args.input));
  });
}

function writeHttpCapturePreload(preloadPath: string): void {
  // Keep hook tests hermetic in sandboxes that disallow loopback listeners. The
  // preload replaces only the child process's http.request and records the
  // exact bodies the installed hook tried to deliver.
  fs.writeFileSync(preloadPath, String.raw`"use strict";
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const https = require("node:https");
const childProcess = require("node:child_process");
const originalExecFileSync = childProcess.execFileSync;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
childProcess.execFileSync = function (file, args, options) {
  const delay = Number(process.env.CODETELEMETRY_TEST_GIT_DELAY_MS || 0);
  if (delay > 0 && file === "git") {
    const timeout = Math.max(1, Number(options && options.timeout) || delay);
    Atomics.wait(waitCell, 0, 0, Math.min(delay, timeout));
    if (delay >= timeout) {
      const error = new Error("synthetic git timeout");
      error.code = "ETIMEDOUT";
      throw error;
    }
  }
  return originalExecFileSync.call(childProcess, file, args, options);
};
function captureRequest(_url, _options, onResponse) {
  const request = new EventEmitter();
  request.destroy = function () {};
  request.end = function (body) {
    fs.appendFileSync(process.env.CODETELEMETRY_TEST_CAPTURE_PATH, String(body) + "\n");
    if (process.env.CODETELEMETRY_TEST_REQUEST_METADATA_PATH) {
      fs.appendFileSync(process.env.CODETELEMETRY_TEST_REQUEST_METADATA_PATH, JSON.stringify({
        url: String(_url),
        headers: _options && _options.headers || {},
        timeout: _options && _options.timeout,
      }) + "\n");
    }
    const result = process.env.CODETELEMETRY_TEST_HTTP_RESULT || "200";
    if (result === "hang") return;
    if (result === "timeout") {
      setImmediate(function () { request.emit("timeout"); });
      return;
    }
    if (result === "delayed-error") {
      const startedAt = Date.now();
      const timer = setInterval(function () {
        if (fs.existsSync(process.env.CODETELEMETRY_TEST_RELEASE_PATH) || Date.now() - startedAt > 2000) {
          clearInterval(timer);
          request.emit("error", new Error("synthetic delayed delivery failure"));
        }
      }, 10);
      return;
    }
    if (result === "error") {
      setImmediate(function () { request.emit("error", new Error("synthetic delivery failure")); });
      return;
    }
    const response = new EventEmitter();
    response.statusCode = Number(result);
    response.resume = function () {};
    setImmediate(function () {
      onResponse(response);
      setImmediate(function () { response.emit("end"); });
    });
  };
  return request;
}
http.request = captureRequest;
https.request = captureRequest;
`);
}

function capturedRequests(capturePath: string): any[] {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function capturedRequestMetadata(capturePath: string): any[] {
  return capturedRequests(capturePath);
}

async function waitForCapturedRequests(capturePath: string, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (capturedRequests(capturePath).length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(capturedRequests(capturePath).length >= count, `timed out waiting for captured request ${count}`);
}

test("resolveCodexConfigPath honours CODEX_HOME, then an explicit path", () => {
  const codexHome = path.join(os.tmpdir(), "cot-home");
  const userHome = path.join(os.tmpdir(), "cot-user");
  // Own the variable for the whole test: whoever runs this may have CODEX_HOME
  // set (anyone driving it from Codex does), and the fallback branch below would
  // then silently assert nothing.
  const prev = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    // Codex relocates its whole local state under CODEX_HOME; writing ~/.codex for
    // such a user would configure a file Codex never reads.
    assert.equal(resolveCodexConfigPath({ codexHome }), path.resolve(codexHome, "config.toml"));
    // With no CODEX_HOME anywhere, fall back to the user's home.
    assert.equal(resolveCodexConfigPath({ home: userHome }), path.join(userHome, ".codex", "config.toml"));
    // An explicit path still wins over both.
    assert.equal(resolveCodexConfigPath({ path: "/tmp/x.toml", codexHome }), path.resolve("/tmp/x.toml"));
    // And the env var is read when nothing overrides it.
    process.env.CODEX_HOME = codexHome;
    assert.equal(resolveCodexConfigPath({ home: userHome }), path.resolve(codexHome, "config.toml"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("buildOtelSection: three per-signal exporters, single-line inline tables", () => {
  const s = buildOtelSection(KEY, ENDPOINT, false);
  assert.ok(s.startsWith("[otel]"));
  for (const [kind, signal] of [
    ["exporter", "logs"],
    ["trace_exporter", "traces"],
    ["metrics_exporter", "metrics"],
  ]) {
    const line = s.split("\n").find((l) => l.startsWith(`${kind} = `));
    // Codex's TOML parser rejects newlines inside inline tables — each exporter
    // must be one physical line, with its full signal path.
    assert.ok(line, `${kind} present`);
    assert.ok(line!.includes(`${ENDPOINT}/v1/${signal}`), `${kind} → /v1/${signal}`);
    assert.ok(line!.includes(`Bearer ${KEY}`));
  }
  assert.ok(!s.includes("log_user_prompt"));
  assert.ok(buildOtelSection(KEY, ENDPOINT, true).includes("log_user_prompt = true"));
});

test("writeCodexConfig creates the file; wrote is key NAMES, never the secret", () => {
  const p = tmpCodexPath();
  const r = writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.equal(r.created, true);
  assert.equal(r.backupPath, null);
  assert.deepEqual(r.wrote, ["exporter", "trace_exporter", "metrics_exporter"]);
  assert.ok(!JSON.stringify(r.wrote).includes("cot_"));
  assert.ok(fs.readFileSync(p, "utf8").includes(`Bearer ${KEY}`));
});

test("default Codex connect installs privacy-safe start, prompt, and post-tool repository observations", () => {
  const p = tmpCodexPath();
  const directory = path.dirname(p);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, CODEX_HOOKS_FILE), JSON.stringify({
    description: "keep",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }],
    },
  }));

  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });

  const hooks = JSON.parse(fs.readFileSync(path.join(directory, CODEX_HOOKS_FILE), "utf8"));
  assert.equal(hooks.description, "keep");
  assert.ok(hooks.hooks.SessionStart.some((group: any) =>
    group.hooks?.some((hook: any) => hook.command === "echo keep")));
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
    const managed = hooks.hooks[event].filter((group: any) =>
      group.hooks?.some((hook: any) => String(hook.command).includes(REPOSITORY_HOOK_MARKER)));
    assert.equal(managed.length, 1);
    assert.equal(managed[0].hooks[0].timeout, 3);
    assert.equal(managed[0].hooks[0].timeoutSec, undefined,
      "Codex hooks.json uses timeout, not the app-server timeoutSec field");
  }
  const source = fs.readFileSync(path.join(directory, REPOSITORY_HOOK_FILE), "utf8");
  assert.match(source, /codetelemetry\.repository_observed/);
  assert.match(source, /const codexConfigPath = /);
  assert.ok(!source.includes(KEY), "the hook reads the live config instead of copying its bearer key");
  assert.ok(!fs.readFileSync(p, "utf8").includes("log_user_prompt"),
    "repository identity does not opt into prompt capture");
});

test("repository hook couples credentials to their endpoint source", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const requestMetadataPath = path.join(directory, "captured-repository-metadata.jsonl");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-credentials-"));
  writeHttpCapturePreload(preloadPath);

  const input = (session: string) => ({
    session_id: session,
    cwd: workspace,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    requestMetadataPath,
    endpoint: "http://127.0.0.1:4318",
    envHeaders: "x-ignored=one,Authorization=Bearer%20environment-only,x-tail=two",
    input: input("environment-auth"),
  });
  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    requestMetadataPath,
    endpoint: "http://localhost:4318",
    envHeaders: "",
    input: input("environment-no-auth"),
  });
  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    requestMetadataPath,
    endpoint: null,
    input: input("config-auth"),
  });

  const metadata = capturedRequestMetadata(requestMetadataPath);
  assert.equal(metadata.length, 3);
  assert.equal(metadata[0].url, "http://127.0.0.1:4318/v1/logs");
  assert.equal(metadata[0].headers.Authorization, "Bearer environment-only");
  assert.ok(!JSON.stringify(metadata[0]).includes(KEY),
    "a configured bearer key never follows an environment endpoint");
  assert.equal(metadata[1].url, "http://localhost:4318/v1/logs");
  assert.equal(metadata[1].headers.Authorization, undefined,
    "missing environment credentials do not fall through to config.toml");
  assert.equal(metadata[2].url, `${ENDPOINT}/v1/logs`);
  assert.equal(metadata[2].headers.Authorization, `Bearer ${KEY}`,
    "the configured endpoint keeps its configured authorization");
});

test("repository hook rejects bearer authorization over non-loopback HTTP before claiming", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: "http://remote.invalid", configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const statePath = path.join(directory, REPOSITORY_HOOK_STATE_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-insecure-"));
  writeHttpCapturePreload(preloadPath);
  const base = {
    hookPath,
    capturePath,
    preloadPath,
    input: {
      session_id: "insecure-session",
      cwd: workspace,
      hook_event_name: "SessionStart",
      source: "startup",
    },
  };

  await runRepositoryHook({ ...base, endpoint: "http://collector.example.invalid", envHeaders: "Authorization=Bearer%20env-key" });
  await runRepositoryHook({ ...base, endpoint: null });
  assert.deepEqual(capturedRequests(capturePath), []);
  assert.equal(fs.existsSync(statePath), false,
    "an insecure destination is rejected before dedupe state is claimed");

  await runRepositoryHook({
    ...base,
    endpoint: "http://[::1]:4318",
    envHeaders: "Authorization=Bearer loopback-key",
  });
  assert.equal(capturedRequests(capturePath).length, 1,
    "loopback HTTP remains available for local collectors");
});

test("repository hook deduplicates unchanged tool events but observes same-turn repository and cwd changes", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const statePath = path.join(directory, REPOSITORY_HOOK_STATE_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-repo-a-"));
  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-repo-b-"));
  for (const command of [
    ["init"],
    ["remote", "add", "origin", "https://github.com/example/repository-one.git"],
  ]) {
    const git = spawnSync("git", ["-C", workspaceA, ...command], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  writeHttpCapturePreload(preloadPath);
  const sessionId = "session-id-must-not-enter-hook-state";
  const run = (hookEvent: string, cwd: string, extra: Record<string, unknown> = {}) =>
    runRepositoryHook({
      hookPath,
      capturePath,
      preloadPath,
      input: {
        session_id: sessionId,
        turn_id: "same-turn",
        cwd,
        hook_event_name: hookEvent,
        ...extra,
      },
    });

  await run("SessionStart", workspaceA, { source: "startup" });
  await run("UserPromptSubmit", workspaceA);
  await run("PostToolUse", workspaceA, { tool_name: "Bash" });
  assert.equal(capturedRequests(capturePath).length, 1, "unchanged prompt and tool events do not redeliver");

  const remoteChange = spawnSync(
    "git",
    ["-C", workspaceA, "remote", "set-url", "origin", "https://github.com/example/repository-two.git"],
    { encoding: "utf8" },
  );
  assert.equal(remoteChange.status, 0, remoteChange.stderr);
  await run("PostToolUse", workspaceA, { tool_name: "Bash" });
  assert.equal(capturedRequests(capturePath).length, 2,
    "a repository transition is visible after the tool in the same turn");

  await run("PostToolUse", workspaceB, { tool_name: "Bash" });
  assert.equal(capturedRequests(capturePath).length, 3,
    "a workspace transition is visible after the tool in the same turn");

  await run("SessionStart", workspaceB, { source: "resume" });
  assert.equal(capturedRequests(capturePath).length, 4,
    "start/resume observations are preserved even when evidence is unchanged");

  const events = capturedRequests(capturePath).map((body) => {
    const attributes = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    return attributes.find((attribute: any) => attribute.key === "hook.event")?.value?.stringValue;
  });
  assert.deepEqual(events, ["SessionStart", "PostToolUse", "PostToolUse", "SessionStart"]);

  const stateText = fs.readFileSync(statePath, "utf8");
  const state = JSON.parse(stateText);
  assert.equal(state.version, 1);
  assert.equal(state.entries.length, 1);
  assert.deepEqual(Object.keys(state.entries[0]).sort(), ["observationHash", "sessionHash"]);
  assert.match(state.entries[0].sessionHash, /^[a-f0-9]{64}$/);
  assert.match(state.entries[0].observationHash, /^[a-f0-9]{64}$/);
  for (const sensitive of [sessionId, workspaceA, workspaceB, "repository-one", "repository-two"]) {
    assert.ok(!stateText.includes(sensitive), `state must not retain raw value: ${sensitive}`);
  }

  // Exercise bounded eviction without spawning dozens of hook processes. The
  // state format itself is deliberately tiny and versioned: fixed-size hashes
  // plus array order for LRU, with no path/session payloads or timestamps.
  const fullEntries = Array.from({ length: REPOSITORY_HOOK_STATE_MAX_ENTRIES }, (_, index) => ({
    sessionHash: index.toString(16).padStart(64, "0"),
    observationHash: (index + 1).toString(16).padStart(64, "0"),
  }));
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, entries: fullEntries }), { mode: 0o600 });
  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    input: {
      session_id: "overflow-session",
      turn_id: "same-turn",
      cwd: workspaceB,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    },
  });
  const boundedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(boundedState.entries.length, REPOSITORY_HOOK_STATE_MAX_ENTRIES);
  assert.ok(fs.statSync(statePath).size < 32768);
});

test("failed and non-2xx repository deliveries roll back dedupe state and retry unchanged evidence", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const statePath = path.join(directory, REPOSITORY_HOOK_STATE_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-retry-"));
  writeHttpCapturePreload(preloadPath);
  for (const command of [
    ["init"],
    ["remote", "add", "origin", "https://github.com/example/retry-one.git"],
  ]) {
    const git = spawnSync("git", ["-C", workspace, ...command], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const setRemote = (name: string) => {
    const git = spawnSync(
      "git",
      ["-C", workspace, "remote", "set-url", "origin", `https://github.com/example/${name}.git`],
      { encoding: "utf8" },
    );
    assert.equal(git.status, 0, git.stderr);
  };
  const run = (httpResult = "200", endpoint?: string) => runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    httpResult,
    endpoint,
    input: {
      session_id: "retry-session",
      turn_id: "retry-turn",
      cwd: workspace,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    },
  });

  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    input: {
      session_id: "retry-session",
      cwd: workspace,
      hook_event_name: "SessionStart",
      source: "startup",
    },
  });
  assert.equal(capturedRequests(capturePath).length, 1);
  const initialState = fs.readFileSync(statePath, "utf8");

  setRemote("retry-two");
  await run("timeout");
  assert.equal(capturedRequests(capturePath).length, 2);
  assert.equal(fs.readFileSync(statePath, "utf8"), initialState,
    "a timeout restores the previously delivered observation");
  await run();
  assert.equal(capturedRequests(capturePath).length, 3,
    "unchanged evidence retries after the timed-out attempt");

  const secondState = fs.readFileSync(statePath, "utf8");
  setRemote("retry-three");
  await run("503");
  assert.equal(capturedRequests(capturePath).length, 4);
  assert.equal(fs.readFileSync(statePath, "utf8"), secondState,
    "a non-2xx response restores the previously delivered observation");
  await run();
  assert.equal(capturedRequests(capturePath).length, 5,
    "unchanged evidence retries after a non-2xx response");

  const thirdState = fs.readFileSync(statePath, "utf8");
  setRemote("retry-four");
  await run("200", "not-a-valid-url");
  assert.equal(capturedRequests(capturePath).length, 5, "an invalid endpoint never attempts delivery");
  assert.equal(fs.readFileSync(statePath, "utf8"), thirdState,
    "the endpoint is parsed before dedupe state is claimed");
  await run();
  assert.equal(capturedRequests(capturePath).length, 6,
    "evidence remains eligible after an invalid endpoint is repaired");
});

test("repository hook preserves retry eligibility within its end-to-end budget when git and transport stall", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const statePath = path.join(directory, REPOSITORY_HOOK_STATE_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const requestMetadataPath = path.join(directory, "captured-repository-metadata.jsonl");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-budget-"));
  writeHttpCapturePreload(preloadPath);
  for (const command of [
    ["init"],
    ["remote", "add", "origin", "https://github.com/example/budget-one.git"],
  ]) {
    const git = spawnSync("git", ["-C", workspace, ...command], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const input = {
    session_id: "budget-session",
    cwd: workspace,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  };
  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    input: { ...input, hook_event_name: "SessionStart", source: "startup" },
  });
  const deliveredState = fs.readFileSync(statePath, "utf8");
  const remoteChange = spawnSync(
    "git",
    ["-C", workspace, "remote", "set-url", "origin", "https://github.com/example/budget-two.git"],
    { encoding: "utf8" },
  );
  assert.equal(remoteChange.status, 0, remoteChange.stderr);

  const startedAt = Date.now();
  await runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    requestMetadataPath,
    input,
    gitDelayMs: 2_000,
    httpResult: "hang",
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 2_850,
    `hook must finish before the installed 3s kill timeout (elapsed ${elapsedMs}ms)`);
  assert.equal(fs.readFileSync(statePath, "utf8"), deliveredState,
    "the absolute transport deadline leaves enough time to restore the prior claim");
  const stalledRequest = capturedRequestMetadata(requestMetadataPath)[0];
  assert.ok(stalledRequest.timeout > 0 && stalledRequest.timeout <= 650,
    "the request timeout is bounded by the remaining end-to-end budget");

  await runRepositoryHook({ hookPath, capturePath, preloadPath, input });
  assert.equal(capturedRequests(capturePath).length, 3,
    "the unchanged transition retries after the stalled invocation instead of being suppressed");
});

test("a host kill after claim leaves a retryable marker rather than a false delivery receipt", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const statePath = path.join(directory, REPOSITORY_HOOK_STATE_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-kill-"));
  writeHttpCapturePreload(preloadPath);
  const input = {
    session_id: "kill-after-claim-session",
    cwd: workspace,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  };
  const killed = spawn(process.execPath, ["--require", preloadPath, hookPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CODETELEMETRY_TEST_CAPTURE_PATH: capturePath,
      CODETELEMETRY_TEST_HTTP_RESULT: "hang",
      CODETELEMETRY_TEST_RELEASE_PATH: "",
      CODETELEMETRY_TEST_REQUEST_METADATA_PATH: "",
      CODETELEMETRY_TEST_GIT_DELAY_MS: "0",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://capture.invalid",
      OTEL_EXPORTER_OTLP_HEADERS: "",
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  killed.stdin.end(JSON.stringify(input));
  await waitForCapturedRequests(capturePath, 1);
  assert.equal(fs.existsSync(statePath), true, "the transport begins only after its claim is durable");
  const pendingState = fs.readFileSync(statePath, "utf8");
  killed.kill("SIGKILL");
  await new Promise<void>((resolve) => killed.once("close", () => resolve()));

  await runRepositoryHook({ hookPath, capturePath, preloadPath, input });
  assert.equal(capturedRequests(capturePath).length, 2,
    "the same observation is delivered again after a kill interrupted the first attempt");
  const deliveredState = fs.readFileSync(statePath, "utf8");
  assert.notEqual(deliveredState, pendingState, "successful delivery replaces the pending marker");
  await runRepositoryHook({ hookPath, capturePath, preloadPath, input });
  assert.equal(capturedRequests(capturePath).length, 2,
    "the completed observation resumes normal local deduplication");
});

test("a stale failed delivery cannot roll back a newer repository observation", async () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const directory = path.dirname(p);
  const hookPath = path.join(directory, REPOSITORY_HOOK_FILE);
  const statePath = path.join(directory, REPOSITORY_HOOK_STATE_FILE);
  const preloadPath = path.join(directory, "capture-repository-http.cjs");
  const capturePath = path.join(directory, "captured-repository-requests.jsonl");
  const releasePath = path.join(directory, "release-stale-delivery");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cot-hook-cas-"));
  writeHttpCapturePreload(preloadPath);
  for (const command of [
    ["init"],
    ["remote", "add", "origin", "https://github.com/example/cas-one.git"],
  ]) {
    const git = spawnSync("git", ["-C", workspace, ...command], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const setRemote = (name: string) => {
    const git = spawnSync(
      "git",
      ["-C", workspace, "remote", "set-url", "origin", `https://github.com/example/${name}.git`],
      { encoding: "utf8" },
    );
    assert.equal(git.status, 0, git.stderr);
  };
  const input = {
    session_id: "cas-session",
    turn_id: "cas-turn",
    cwd: workspace,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  };

  await runRepositoryHook({ hookPath, capturePath, preloadPath, input: {
    ...input,
    hook_event_name: "SessionStart",
    source: "startup",
  } });
  setRemote("cas-stale");
  const staleDelivery = runRepositoryHook({
    hookPath,
    capturePath,
    preloadPath,
    releasePath,
    httpResult: "delayed-error",
    input,
  });
  await waitForCapturedRequests(capturePath, 2);

  setRemote("cas-newer");
  await runRepositoryHook({ hookPath, capturePath, preloadPath, input });
  assert.equal(capturedRequests(capturePath).length, 3);
  const newerState = fs.readFileSync(statePath, "utf8");

  fs.writeFileSync(releasePath, "release");
  await staleDelivery;
  assert.equal(fs.readFileSync(statePath, "utf8"), newerState,
    "rollback compares its claim and leaves a newer hash untouched");

  await runRepositoryHook({ hookPath, capturePath, preloadPath, input });
  assert.equal(capturedRequests(capturePath).length, 3,
    "the newer successful observation remains deduplicated after stale rollback");
});

test("installed Codex accepts the generated config and lifecycle hook schema", () => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") return;
  assert.equal(probe.status, 0, probe.stderr);
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const parsed = spawnSync("codex", ["features", "list"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: path.dirname(p) },
  });
  assert.equal(parsed.status, 0, `${parsed.stdout}\n${parsed.stderr}`);
  assert.doesNotMatch(`${parsed.stdout}\n${parsed.stderr}`, /invalid hooks settings|unknown field/i);
});

test("writeCodexConfig refuses malformed hooks before changing config.toml", () => {
  const p = tmpCodexPath();
  const directory = path.dirname(p);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(p, 'model = "keep"\n');
  fs.writeFileSync(path.join(directory, CODEX_HOOKS_FILE), "{ bad json");
  assert.throws(() => writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p }),
    /refusing to overwrite/);
  assert.equal(fs.readFileSync(p, "utf8"), 'model = "keep"\n');
});

test("writeCodexConfig appends [otel] after existing sections, preserving them", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'model = "gpt-5.6-sol"\n\n[features]\njs_repl = false\n');
  const r = writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.ok(r.backupPath && fs.existsSync(r.backupPath));
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.includes('model = "gpt-5.6-sol"')); // preserved
  assert.ok(out.includes("[features]\njs_repl = false")); // preserved
  // [otel] appended as a NEW section, after (not inside) [features].
  assert.ok(out.indexOf("[otel]") > out.indexOf("[features]"));
});

test("writeCodexConfig rewrites the exporters in place, idempotently", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    'model = "gpt-5.6-sol"\n[otel]\nenvironment = "old"\nexporter = { otlp-http = { endpoint = "https://stale.example.com/v1/logs" } }\n[features]\njs_repl = false\n',
  );
  const r1 = writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const first = fs.readFileSync(p, "utf8");
  assert.ok(!first.includes("stale.example.com")); // stale exporter replaced
  assert.equal((first.match(/^exporter = /gm) ?? []).length, 1); // not defined twice
  assert.ok(first.includes("[features]")); // following section intact
  assert.ok(first.indexOf("[otel]") < first.indexOf("[features]")); // merged in place
  assert.ok(r1.backupPath);
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.equal(fs.readFileSync(p, "utf8"), first); // idempotent
});

test("writeCodexConfig preserves the user's other [otel] settings", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // The shape a real Codex user already has: their own environment tag and an
  // explicit prompt-capture choice, alongside exporters we're about to rotate.
  fs.writeFileSync(
    p,
    '[otel]\n# my tag\nenvironment = "windows-codex"\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "https://stale.example.com/v1/logs" } }\n',
  );
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.includes('environment = "windows-codex"')); // not dropped
  assert.ok(out.includes("# my tag")); // comments survive
  assert.ok(out.includes("log_user_prompt = true")); // their capture choice survives
  assert.equal((out.match(/log_user_prompt/g) ?? []).length, 1); // and isn't duplicated
  assert.ok(out.includes(`Bearer ${KEY}`)); // key still rotated
  assert.ok(!out.includes("stale.example.com"));
});

test("writeCodexConfig --enrich sets log_user_prompt exactly once", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[otel]\nlog_user_prompt = false\nenvironment = "keep"\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p, enrich: true });
  const out = fs.readFileSync(p, "utf8");
  assert.equal((out.match(/log_user_prompt/g) ?? []).length, 1);
  assert.ok(out.includes("log_user_prompt = true")); // opt-in wins over the old false
  assert.ok(out.includes('environment = "keep"'));
});

test("writeCodexConfig without --enrich never enables prompt capture on its own", () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.ok(!fs.readFileSync(p, "utf8").includes("log_user_prompt"));
});

test("writeCodexConfig refuses [otel.*] sub-tables it can't merge", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[otel]\nenvironment = "x"\n[otel.exporter.otlp-http]\nendpoint = "https://y"\n');
  assert.throws(() => writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p }), /refusing to edit/);
  assert.ok(fs.readFileSync(p, "utf8").includes('environment = "x"')); // untouched
});

test("writeCodexConfig preserves CRLF endings instead of leaving the file mixed", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'model = "gpt-5.6-sol"\r\n[features]\r\njs_repl = false\r\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.equal(out.split("\n").length - 1, (out.match(/\r\n/g) ?? []).length); // every LF is part of a CRLF
  assert.ok(out.includes("[otel]"));
  assert.ok(out.endsWith("\r\n"));
});

test("writeCodexConfig doesn't mistake a multi-line array row for the next section", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // `[1,2],` looks like a table header to a naive /^\s*\[/ test — ending the
  // [otel] body there would strand the rest of the array below our exporters,
  // outside the section it belongs to.
  fs.writeFileSync(p, '[otel]\nenvironment = "old"\nmatrix = [\n[1,2],\n[3,4]\n]\n[features]\njs_repl = false\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.includes("matrix = [\n[1,2],\n[3,4]\n]")); // array kept whole, in order
  assert.ok(out.includes('environment = "old"')); // user's key preserved
  assert.ok(out.includes("[features]\njs_repl = false")); // real next section intact
  assert.equal((out.match(/\[otel\]/g) ?? []).length, 1);
  // Everything we added stays inside [otel], i.e. above the next real header.
  assert.ok(out.indexOf("metrics_exporter = ") < out.indexOf("[features]"));
});

test("writeCodexConfig replaces an EXPANDED exporter, not just the inline form", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // TOML lets the same exporter be written dotted. Preserving these while
  // appending `exporter = { … }` would define exporter twice — a parse error.
  fs.writeFileSync(
    p,
    '[otel]\nenvironment = "keep"\nexporter.otlp-http.endpoint = "https://stale.example.com/v1/logs"\nexporter.otlp-http.protocol = "binary"\ntrace_exporter.otlp-http.endpoint = "https://stale.example.com/v1/traces"\n',
  );
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(!out.includes("stale.example.com")); // every dotted form dropped
  assert.ok(!/^exporter\./m.test(out) && !/^trace_exporter\./m.test(out));
  assert.equal((out.match(/^exporter = /gm) ?? []).length, 1); // defined exactly once
  assert.equal((out.match(/^trace_exporter = /gm) ?? []).length, 1);
  assert.ok(out.includes('environment = "keep"')); // unrelated key still preserved
});

test("writeCodexConfig tolerates TOML whitespace in headers and dotted keys", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // All spec-legal spellings: a spaced table header and spaced dotted keys. Miss
  // either and we append a duplicate [otel] / duplicate exporter, and the config
  // stops parsing.
  fs.writeFileSync(
    p,
    '[ otel ]\nenvironment = "keep"\nexporter . otlp-http . endpoint = "https://stale.example.com/v1/logs"\n',
  );
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.equal((out.match(/\[\s*otel\s*\]/g) ?? []).length, 1); // merged, not duplicated
  assert.ok(!out.includes("stale.example.com")); // spaced dotted form still owned
  assert.equal((out.match(/^exporter = /gm) ?? []).length, 1);
  assert.ok(out.includes('environment = "keep"'));
});

test("writeCodexConfig ends the section at a quoted header containing a comma", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // `["ui,settings"]` is a real table. Missing it would append our exporters
  // AFTER it, handing them to that table and leaving Codex with none.
  fs.writeFileSync(p, '[otel]\nenvironment = "keep"\n["ui,settings"]\ntheme = "dark"\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.indexOf("metrics_exporter = ") < out.indexOf('["ui,settings"]')); // inside [otel]
  assert.ok(out.includes('theme = "dark"'));
  assert.equal((out.match(/^\["ui,settings"\]$/gm) ?? []).length, 1);
  assert.equal(readCodexKey(p), KEY); // and the reader agrees on the same range
});

test("writeCodexConfig keeps a quoted key whose NAME contains a dot", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // In TOML the dot inside quotes is part of the name: "exporter.metadata" is its
  // own key, not a child of exporter, so rotating the key must not delete it.
  fs.writeFileSync(p, '[otel]\n"exporter.metadata" = "keep"\nexporter = { otlp-http = { endpoint = "https://stale.example.com/v1/logs" } }\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.includes('"exporter.metadata" = "keep"')); // not ours — preserved
  assert.ok(!out.includes("stale.example.com")); // genuinely ours — replaced
  assert.equal((out.match(/^exporter = /gm) ?? []).length, 1);
});

test("readCodexKey ignores a Bearer token outside an exporter assignment", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // No live exporter: the token survives only in a trailing comment and in an
  // unrelated value. doctor must not probe those and call the setup working.
  fs.writeFileSync(
    p,
    `[otel]\nenvironment = "prod" # old Bearer ${KEY}\nnote = "Bearer ${KEY}"\n`,
  );
  assert.equal(readCodexKey(p), null);
  assert.equal(readCodexSummary(p).hasKey, false);
  // With a real exporter present it IS found, comment on the same line or not.
  fs.appendFileSync(p, `exporter = { otlp-http = { headers = { authorization = "Bearer ${KEY}" } } } # live\n`);
  assert.equal(readCodexKey(p), KEY);
  assert.equal(readCodexSummary(p).hasKey, true);
});

test("writeCodexConfig refuses a file using multi-line TOML strings", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // The `[otel]` here is string CONTENT, not a header — a line-at-a-time scanner
  // can't tell, so the writer must decline instead of guessing.
  fs.writeFileSync(p, 'banner = """\n[otel]\n"""\n[otel]\nenvironment = "real"\n');
  assert.throws(
    () => writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p }),
    /refusing to edit[\s\S]*multi-line TOML string/,
  );
  assert.ok(fs.readFileSync(p, "utf8").includes('environment = "real"')); // untouched
  // And the readers stay quiet rather than reporting a key they can't place.
  assert.equal(readCodexKey(p), null);
  assert.equal(readCodexSummary(p).hasKey, false);
});

test("writeCodexConfig doesn't end the section on a header-shaped line inside a value", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // `[1]` is a single-element array row, not a table header — a comma-based
  // heuristic misses it. Splicing our exporters there would cut the array in half
  // and leave the rest of the body outside [otel].
  fs.writeFileSync(p, '[otel]\narr = [\n[1]\n]\nenvironment = "keep"\n[features]\njs_repl = false\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.includes("arr = [\n[1]\n]")); // array intact and unsplit
  assert.ok(out.includes('environment = "keep"')); // body after the array still merged
  assert.ok(out.indexOf("metrics_exporter = ") < out.indexOf("[features]")); // we stayed inside
  assert.ok(out.includes("[features]\njs_repl = false"));
});

test("a header-shaped line inside another section's value isn't taken for [otel]", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // The `[otel]` here is array data belonging to `names`, not a section.
  fs.writeFileSync(p, '[features]\nnames = [\n[otel]\n]\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.ok(out.includes("names = [\n[otel]\n]")); // data untouched
  // A real section was appended at the end rather than merged into the array.
  assert.ok(out.trimEnd().endsWith("}"));
  assert.ok(out.indexOf("[otel]", out.indexOf("names")) > out.indexOf("]"));
  assert.equal((out.match(/^exporter = /gm) ?? []).length, 1);
});

test("writeCodexConfig recognises a QUOTED otel header instead of duplicating it", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[ "otel" ]\nenvironment = "keep"\nexporter = { otlp-http = { endpoint = "https://stale.example.com/v1/logs" } }\n');
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  const out = fs.readFileSync(p, "utf8");
  assert.equal((out.match(/^\s*\[/gm) ?? []).length, 1); // still ONE table, not two
  assert.ok(out.includes('[ "otel" ]')); // their header spelling left alone
  assert.ok(!out.includes("stale.example.com"));
  assert.equal((out.match(/^exporter = /gm) ?? []).length, 1);
  assert.ok(out.includes('environment = "keep"'));
});

test("writeCodexConfig refuses a quoted [\"otel\".*] sub-table", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '["otel".exporter]\nendpoint = "https://y"\n');
  assert.throws(() => writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p }), /refusing to edit/);
  assert.ok(fs.readFileSync(p, "utf8").includes('endpoint = "https://y"')); // untouched
});

test("writeCodexConfig refuses a spaced [ otel.* ] sub-table too", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[ otel ]\nenvironment = "x"\n[ otel.exporter.otlp-http ]\nendpoint = "https://y"\n');
  assert.throws(() => writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p }), /refusing to edit/);
  assert.ok(fs.readFileSync(p, "utf8").includes('endpoint = "https://y"')); // untouched
});

test("readCodexKey ignores a key that is only present in a comment", () => {
  const p = tmpCodexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Telemetry disabled by commenting the exporters out: doctor must not report a
  // working setup off a key Codex isn't using.
  fs.writeFileSync(
    p,
    `[otel]\nenvironment = "keep"\n# exporter = { otlp-http = { endpoint = "${ENDPOINT}/v1/logs", headers = { authorization = "Bearer ${KEY}" } } }\n`,
  );
  assert.equal(readCodexKey(p), null);
  const s = readCodexSummary(p);
  assert.equal(s.hasKey, false);
  assert.deepEqual(s.otelKeys, ["environment"]); // the commented line isn't a key
});

test("readCodexKey ignores a Bearer token outside the [otel] section", () => {
  const p = tmpCodexPath();
  const other = "cot_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `[mcp_servers.other.env]\nAUTH = "Bearer ${other}"\n`);
  assert.equal(readCodexKey(p), null); // no [otel] yet → nothing to re-test
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.equal(readCodexKey(p), KEY); // ours, not the unrelated service's
  assert.ok(fs.readFileSync(p, "utf8").includes(other)); // and the other one is preserved
});

test("readCodexKey + readCodexSummary round-trip without leaking the key", () => {
  const p = tmpCodexPath();
  writeCodexConfig({ repositoryObservation: true, key: KEY, ingestEndpoint: ENDPOINT, configPath: p, enrich: true });
  assert.equal(readCodexKey(p), KEY);
  const s = readCodexSummary(p);
  assert.equal(s.exists, true);
  assert.equal(s.hasKey, true);
  assert.deepEqual(s.otelKeys, ["log_user_prompt", "exporter", "trace_exporter", "metrics_exporter"]);
  assert.ok(!JSON.stringify(s).includes(KEY));
  assert.equal(readCodexKey(tmpCodexPath()), null);
});
