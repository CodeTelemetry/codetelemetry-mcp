// The pi writer (the analogue of codexConfig.test.ts). The block's shape is a
// wire contract with pi-otel: the endpoint is the full /v1/traces URL with an
// explicit port (pi-otel uses the URL verbatim and gives every enabled signal
// the same URL), headers carry the bearer key verbatim, protocol "http", and
// only traces are on.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPiOtelBlock,
  mergePiSettings,
  piTracesEndpoint,
  readPiKey,
  readPiSummary,
  resolvePiConfigPath,
  writePiConfig,
} from "../../src/client/piConfig.ts";
import { CLIENTS, resolveClient } from "../../src/client/clients.ts";
import { ONBOARD_CLIENTS, isOnboardClient } from "../../src/client/assistants.ts";
import { PLAN_PROVIDERS } from "../../src/client/plan.ts";
import { run } from "../../src/client/cli.ts";

const KEY = "cot_abcdefghijklmnopqrstuvwxyz012345";
const ENDPOINT = "https://ingest.example.com";

function tmpPiPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cot-pi-"));
  return path.join(dir, ".pi", "agent", "settings.json");
}

test("buildPiOtelBlock pins the pi-otel wire contract", () => {
  const block = buildPiOtelBlock(KEY, ENDPOINT, false);
  assert.equal(block.endpoint, "https://ingest.example.com:443/v1/traces");
  assert.equal(block.protocol, "http");
  assert.deepEqual(block.headers, { Authorization: `Bearer ${KEY}` });
  assert.equal(block.serviceName, "pi");
  assert.deepEqual(block.signals, { traces: true, metrics: false, logs: false });
  assert.equal("captureContent" in block, false, "content capture stays opt-in");
  assert.equal(buildPiOtelBlock(KEY, ENDPOINT, true).captureContent, "full");
});

test("the traces endpoint keeps an explicit port and the endpoint's base path (#384 review)", () => {
  assert.equal(piTracesEndpoint("http://127.0.0.1:4318"), "http://127.0.0.1:4318/v1/traces");
  assert.equal(piTracesEndpoint("https://gateway.example.com/otel"), "https://gateway.example.com:443/otel/v1/traces");
  assert.equal(piTracesEndpoint("https://gateway.example.com/otel/"), "https://gateway.example.com:443/otel/v1/traces");
  assert.equal(piTracesEndpoint("https://h.example.com:8443/a/b"), "https://h.example.com:8443/a/b/v1/traces");
});

test("writePiConfig creates the file 0600 and merges without touching other settings", () => {
  const p = tmpPiPath();
  const created = writePiConfig({ key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.equal(created.created, true);
  assert.equal(created.backupPath, null);
  assert.ok(created.wrote.includes("endpoint"));
  if (process.platform !== "win32") assert.equal(fs.statSync(p).mode & 0o777, 0o600);

  fs.writeFileSync(p, JSON.stringify({ theme: "dark", packages: ["npm:pi-otel"], otel: { sampleRatio: 0.5, captureContent: "no_tool_content" } }));
  const updated = writePiConfig({ key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.equal(updated.created, false);
  assert.equal(updated.backupPath, `${p}.bak`);
  const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(onDisk.theme, "dark");
  assert.deepEqual(onDisk.packages, ["npm:pi-otel"]);
  assert.equal(onDisk.otel.sampleRatio, 0.5);
  assert.equal(onDisk.otel.captureContent, "no_tool_content", "a user's capture choice survives when enrich is off");
  assert.equal(onDisk.otel.enabled, true);

  fs.writeFileSync(p, "{ not json");
  assert.throws(() => writePiConfig({ key: KEY, ingestEndpoint: ENDPOINT, configPath: p }), /refusing to overwrite/);
});

test("mergePiSettings: managed keys win, everything else is kept", () => {
  assert.deepEqual(mergePiSettings({ otel: { enabled: false, logLevel: "debug" }, other: 1 }, { enabled: true, endpoint: "x" }),
    { other: 1, otel: { enabled: true, logLevel: "debug", endpoint: "x" } });
});

test("readPiKey / readPiSummary report state without the key", () => {
  const p = tmpPiPath();
  assert.equal(readPiKey(p), null);
  assert.deepEqual(readPiSummary(p), { exists: false, otelKeys: [], hasKey: false, extensionInstalled: false });
  writePiConfig({ key: KEY, ingestEndpoint: ENDPOINT, configPath: p });
  assert.equal(readPiKey(p), KEY);
  const summary = readPiSummary(p);
  assert.equal(summary.hasKey, true);
  assert.equal(summary.extensionInstalled, false);
  assert.ok(!JSON.stringify(summary).includes(KEY));
  const settings = JSON.parse(fs.readFileSync(p, "utf8"));
  fs.writeFileSync(p, JSON.stringify({ ...settings, packages: ["npm:pi-otel@0.1.0"] }));
  assert.equal(readPiSummary(p).extensionInstalled, true);
  fs.writeFileSync(p, JSON.stringify({ ...settings, packages: ["npm:pi-otel-fork"] }));
  assert.equal(readPiSummary(p).extensionInstalled, false);
});

test("the client descriptors resolve pi, and the client list is the registry's twin", () => {
  assert.deepEqual([...ONBOARD_CLIENTS], ["claude", "codex", "pi", "kiro"]);
  assert.deepEqual([...PLAN_PROVIDERS], [...ONBOARD_CLIENTS]);
  assert.equal(resolveClient(undefined).id, "claude");
  assert.equal(resolveClient("pi").id, "pi");
  assert.ok(isOnboardClient("pi"));
  assert.throws(() => resolveClient("cursor"), /unknown client/);
  assert.ok(CLIENTS.pi.resolveConfigPath({}).endsWith(path.join(".pi", "agent", "settings.json")));
  assert.equal(resolvePiConfigPath({ path: "/x/y.json" }), path.resolve("/x/y.json"));
  assert.match(CLIENTS.pi.printConfig(ENDPOINT, false), /"endpoint": "https:\/\/ingest\.example\.com:443\/v1\/traces"/);
});

test("the CLI: --client pi prints pi's block, --client is validated, --codex stays an alias", async () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const capture = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = capture;
  try {
    assert.equal(await run(["print-config", "--client", "pi", "--endpoint", ENDPOINT]), 0);
    assert.equal(await run(["print-config", "--client", "emacs"]), 1);
    assert.equal(await run(["print-config", "--client", "pi", "--codex"]), 1);
    assert.equal(await run(["print-config", "--codex", "--endpoint", ENDPOINT]), 0);
  } finally {
    process.stdout.write = write;
  }
  const output = lines.join("");
  assert.match(output, /"serviceName": "pi"/);
  assert.match(output, /pi install npm:pi-otel/);
  assert.match(output, /--client must be one of claude, codex, pi, kiro\./);
  assert.match(output, /--codex conflicts with --client pi\./);
  assert.match(output, /\[otel\]/);
});
