// ELL-655 (C5): imported rows carry the identity attributes live exporters
// send, as record attributes on every imported record and the commit marker.
// Synthetic ~/.claude.json / auth.json files in temporary directories only;
// the id token is never verified, logged or returned. Also pins the
// JSON-safe tool-input truncation.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  claudeGlobalConfigPath,
  readClaudeIdentity,
  readCodexIdentity,
  resolveImportIdentity,
  taggedId,
} from "../../src/client/import/identity.ts";
import { MAX_TOOL_INPUT_CHARS, capToolInput, maskEmail, maskIdentity } from "../../src/client/import/model.ts";
import { parseClaudeTranscriptText } from "../../src/client/import/sources/claudeCodeText.ts";
import { parseCodexRolloutText } from "../../src/client/import/sources/codexText.ts";
import { runImport } from "../../src/client/import/run.ts";
import { importFiles } from "../../src/client/import/browser.ts";
import { API, CLAUDE_SID, FakeServer, INGEST, KEY, NOW } from "./importFake.ts";
import { claudeTranscript, codexRollout, fakeJwt } from "./historyFixtures.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "import");
const ACCOUNT_UUID = "6f1d2c3b-4a59-4e8f-9a7b-0c1d2e3f4a5b";
const ORG_UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const USER_ID = "a".repeat(64);
const ID_TOKEN_SECRET_MARKER = "synthetic-signature-material";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ct-identity-"));
}

function claudeConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({
    userID: USER_ID,
    oauthAccount: { accountUuid: ACCOUNT_UUID, emailAddress: "dev@example.org", organizationUuid: ORG_UUID },
    projects: { "/work/app": { history: [] } },
    ...extra,
  }));
  return file;
}

function codexAuth(dir: string, payload: Record<string, unknown>, tokens: Record<string, unknown> = {}): string {
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt(payload) + ID_TOKEN_SECRET_MARKER, access_token: "synthetic-access", refresh_token: "synthetic-refresh", ...tokens },
    last_refresh: "2026-10-01T00:00:00Z",
  }));
  return file;
}

test("Claude Code's tagged account id: user_01 + 22 base58 characters of the uuid", () => {
  assert.equal(taggedId("user", "00000000-0000-0000-0000-000000000000"), "user_01" + "1".repeat(22));
  assert.equal(taggedId("user", "00000000-0000-0000-0000-000000000039"), "user_01" + "1".repeat(21) + "z", "57 is the last digit");
  assert.equal(taggedId("user", "00000000-0000-0000-0000-00000000003a"), "user_01" + "1".repeat(20) + "21", "58 carries");
  assert.equal(taggedId("user", "ffffffff-ffff-ffff-ffff-ffffffffffff")!.length, "user_01".length + 22);
  assert.equal(taggedId("user", "not-a-uuid"), undefined);
});

test("Claude identity comes from ~/.claude.json exactly as live exporters send it", () => {
  const dir = tmp();
  const configPath = claudeConfig(dir);
  const settingsPath = path.join(dir, "settings.json");
  assert.deepEqual(readClaudeIdentity({ configPath, settingsPath, env: {} }), {
    "organization.id": ORG_UUID,
    "user.account_id": taggedId("user", ACCOUNT_UUID),
    "user.account_uuid": ACCOUNT_UUID,
    "user.email": "dev@example.org",
    "user.id": USER_ID,
  });
  // OTEL_METRICS_INCLUDE_ACCOUNT_UUID off (env or settings.json env): no account ids.
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false" } }));
  const noUuid = readClaudeIdentity({ configPath, settingsPath, env: {} });
  assert.equal(noUuid["user.account_uuid"], undefined);
  assert.equal(noUuid["user.account_id"], undefined);
  assert.equal(noUuid["user.email"], "dev@example.org");
  fs.rmSync(settingsPath);
  // CLAUDE_CODE_ACCOUNT_TAGGED_ID wins, as in Claude Code.
  assert.equal(readClaudeIdentity({ configPath, settingsPath, env: { CLAUDE_CODE_ACCOUNT_TAGGED_ID: "user_01override" } })["user.account_id"], "user_01override");
  // An API-key / signed-out config carries only the installation id.
  fs.writeFileSync(configPath, JSON.stringify({ userID: USER_ID }));
  assert.deepEqual(readClaudeIdentity({ configPath, settingsPath, env: {} }), { "user.id": USER_ID });
  fs.writeFileSync(configPath, "{ not json");
  assert.deepEqual(readClaudeIdentity({ configPath, settingsPath, env: {} }), {});
});

test("CLAUDE_CONFIG_DIR relocates the global config; a legacy .config.json is preferred when present", () => {
  const home = tmp();
  const custom = tmp();
  assert.equal(claudeGlobalConfigPath({}, home), path.join(home, ".claude.json"));
  assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: custom }, home), path.join(custom, ".claude.json"));
  fs.writeFileSync(path.join(custom, ".config.json"), "{}");
  assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: custom }, home), path.join(custom, ".config.json"));
  claudeConfig(home);
  assert.equal(readClaudeIdentity({ env: {}, home, settingsPath: path.join(home, "none.json") })["user.email"], "dev@example.org");
});

test("Codex identity: email and ChatGPT account id from the id token, never the token itself", () => {
  const dir = tmp();
  const authPath = codexAuth(dir, {
    email: "coder@example.org",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1234-5678", chatgpt_plan_type: "pro" },
  });
  const identity = readCodexIdentity({ authPath });
  assert.deepEqual(identity, { "user.account_id": "acct-1234-5678", "user.email": "coder@example.org" });
  assert.ok(!JSON.stringify(identity).includes(ID_TOKEN_SECRET_MARKER));
  // CODEX_HOME relocates auth.json.
  assert.deepEqual(readCodexIdentity({ env: { CODEX_HOME: dir } }), identity);
  // tokens.account_id is the fallback account id.
  const fallback = codexAuth(tmp(), { email: "coder@example.org" }, { account_id: "acct-fallback" });
  assert.equal(readCodexIdentity({ authPath: fallback })["user.account_id"], "acct-fallback");
  // API-key sign-in / garbage: nothing.
  const apiKey = path.join(tmp(), "auth.json");
  fs.writeFileSync(apiKey, JSON.stringify({ OPENAI_API_KEY: "sk-synthetic" }));
  assert.deepEqual(readCodexIdentity({ authPath: apiKey }), {});
  const garbage = codexAuth(tmp(), {});
  fs.writeFileSync(garbage, JSON.stringify({ tokens: { id_token: "not.a.jwt" } }));
  assert.deepEqual(readCodexIdentity({ authPath: garbage }), {});
});

test("identity resolution follows the source and the opt-out; masking hides emails and ids", () => {
  const dir = tmp();
  const both = {
    claudeConfigPath: claudeConfig(dir), claudeSettingsPath: path.join(dir, "none.json"),
    codexAuthPath: codexAuth(dir, { email: "coder@example.org", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1234-5678" } }),
    env: {},
  };
  assert.deepEqual(Object.keys(resolveImportIdentity({ source: "all", ...both })).sort(), ["claude-code", "codex"]);
  assert.deepEqual(Object.keys(resolveImportIdentity({ source: "codex", ...both })), ["codex"]);
  assert.deepEqual(resolveImportIdentity({ source: "all", disabled: true, ...both }), {});
  assert.equal(maskEmail("elliot@gmail.com"), "e***@g***.com");
  assert.equal(maskEmail("a@b.co.uk"), "a***@b***.uk");
  const masked = maskIdentity(resolveImportIdentity({ source: "all", ...both }));
  assert.equal(masked["claude-code"]!["user.email"], "d***@e***.org");
  assert.ok(!JSON.stringify(masked).includes(ACCOUNT_UUID) && !JSON.stringify(masked).includes("acct-1234-5678"));
});

function fixtureDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-identity-import-"));
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

test("every imported record, token point and commit marker carries the identity; --email overrides; identity is in the plan id", async () => {
  const claude = { "organization.id": ORG_UUID, "user.account_id": "user_01x", "user.account_uuid": ACCOUNT_UUID, "user.email": "dev@example.org", "user.id": USER_ID };
  const codex = { "user.account_id": "acct-1234-5678", "user.email": "coder@example.org" };
  const base = {
    key: KEY, endpoints: { apiBase: API, ingestEndpoint: INGEST }, sinceMs: Date.parse("2026-09-15T00:00:00Z"), nowMs: NOW, sleep: async () => {},
  };
  const server = new FakeServer();
  let metricAttrs: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/v1/metrics")) {
      const body = JSON.parse(String(init?.body));
      for (const p of body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints) {
        metricAttrs.push(Object.fromEntries(p.attributes.map((kv: any) => [kv.key, kv.value.stringValue])));
      }
    }
    return server.fetch(url, init);
  }) as typeof fetch;
  const r = await runImport({ ...base, ...fixtureDirs(), fetchImpl, identity: { "claude-code": claude, codex } });
  assert.equal(r.ok, true, r.errors.join("; "));
  for (const l of server.logs) {
    const expected = l.resource["import.source"] === "codex" ? codex : claude;
    for (const [k, v] of Object.entries(expected)) assert.equal(l.attrs[k], v, `${l.attrs["event.name"]} ${k}`);
    if (l.resource["import.source"] === "codex") assert.equal(l.attrs["organization.id"], undefined);
  }
  assert.ok(server.logs.some((l) => l.marker), "markers are among the checked records");
  assert.ok(metricAttrs.length > 0);
  for (const m of metricAttrs) assert.equal(m["user.email"], "dev@example.org");
  assert.equal(r.identity?.["claude-code"]?.["user.email"], "d***@e***.org", "the result shows the identity masked");
  assert.ok(!JSON.stringify(r).includes(ACCOUNT_UUID));

  // --email overrides user.email on records (and still stamps the resource).
  const emailServer = new FakeServer();
  await runImport({ ...base, ...fixtureDirs(), fetchImpl: emailServer.fetch as typeof fetch, identity: { "claude-code": claude }, email: "ops@example.org", source: "claude-code" });
  for (const l of emailServer.logs) {
    assert.equal(l.attrs["user.email"], "ops@example.org");
    assert.equal(l.attrs["user.id"], USER_ID);
    assert.equal(l.resource["user.email"], "ops@example.org");
  }

  // The identity is part of the plan id: the same files plan differently without it.
  const bare = new FakeServer();
  await runImport({ ...base, ...fixtureDirs(), fetchImpl: bare.fetch as typeof fetch, source: "claude-code" });
  const withPlan = server.logs.find((l) => l.sid === CLAUDE_SID)!.resource["import.plan"];
  const barePlan = bare.logs.find((l) => l.sid === CLAUDE_SID)!.resource["import.plan"];
  assert.notEqual(withPlan, barePlan);
  assert.ok(bare.logs.every((l) => l.attrs["user.email"] === undefined), "the library stamps nothing unless asked");
});

test("a browser upload stamps the email it is given as user.email", async () => {
  const server = new FakeServer();
  const file = (rel: string) => new File([fs.readFileSync(path.join(FIX, rel))], path.basename(rel), { lastModified: Date.parse("2026-10-03T00:00:00Z") });
  const r = await importFiles([file("claude-projects/-work-app/cs-test-1.jsonl")], {
    key: KEY, apiBase: API, ingestEndpoint: INGEST, dryRun: false, sinceMs: Date.parse("2026-09-15T00:00:00Z"), nowMs: NOW,
    fetchImpl: server.fetch as typeof fetch, sleep: async () => {}, identity: { email: "web@example.org" },
  });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.ok(server.logs.length > 0);
  for (const l of server.logs) assert.equal(l.attrs["user.email"], "web@example.org");
});

const BIN = fileURLToPath(new URL("../../src/client/bin.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

test("cli import --dry-run shows the identity masked; --no-identity omits it", async () => {
  const home = tmp();
  claudeConfig(home);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    CODETELEMETRY_INGEST_KEY: KEY,
    // Unroutable on purpose: the status read fails, the dry run still summarizes.
    CODETELEMETRY_API_BASE: "http://127.0.0.1:9",
  };
  const shown = await runCli(["import", "--dry-run", "--source", "claude-code"], env);
  assert.match(shown.text, /Identity on imported rows: Claude Code d\*\*\*@e\*\*\*\.org \+ organization\.id, user\.account_id, user\.account_uuid, user\.id/, shown.text);
  assert.ok(!shown.text.includes("dev@example.org") && !shown.text.includes(ACCOUNT_UUID));
  const hidden = await runCli(["import", "--dry-run", "--source", "claude-code", "--no-identity"], env);
  assert.ok(!/Identity on imported rows/.test(hidden.text), hidden.text);
});

test("long tool inputs stay valid JSON within the bound, keeping paths and commands", () => {
  const content = "x".repeat(50_000);
  const input = { file_path: "/work/app/src/very/long/path/file.ts", content, old_string: "y".repeat(30_000) };
  const full = JSON.stringify(input);
  const capped = capToolInput(input, full, MAX_TOOL_INPUT_CHARS);
  assert.ok(capped.length <= MAX_TOOL_INPUT_CHARS);
  const parsed = JSON.parse(capped);
  assert.equal(parsed.file_path, input.file_path);
  assert.ok(parsed.content.endsWith("…") && parsed.content.length > 1_000, "the bulky value is shortened, not dropped");
  assert.equal(capToolInput({ command: "ls" }, JSON.stringify({ command: "ls" }), MAX_TOOL_INPUT_CHARS), JSON.stringify({ command: "ls" }));

  // A protected value too long on its own is shortened last; still valid.
  const hugeCommand = { command: "echo " + "z".repeat(40_000), description: "d" };
  const c2 = capToolInput(hugeCommand, JSON.stringify(hugeCommand), MAX_TOOL_INPUT_CHARS);
  assert.ok(c2.length <= MAX_TOOL_INPUT_CHARS && JSON.parse(c2).command.startsWith("echo zzz"));
  // Escape-heavy text and surrogate pairs never break the JSON.
  const tricky = { file_path: "/a", content: "\"\\\n😀".repeat(10_000) };
  const c3 = capToolInput(tricky, JSON.stringify(tricky), MAX_TOOL_INPUT_CHARS);
  assert.ok(c3.length <= MAX_TOOL_INPUT_CHARS);
  assert.equal(JSON.parse(c3).file_path, "/a");
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(JSON.parse(c3).content), "no lone high surrogate");
  // Structure alone over the bound: the identifying keys survive.
  const wide: Record<string, unknown> = { path: "/repo" };
  for (let i = 0; i < 5_000; i++) wide[`k${i}`] = i;
  const c4 = capToolInput(wide, JSON.stringify(wide), MAX_TOOL_INPUT_CHARS);
  assert.deepEqual(JSON.parse(c4), { truncated: true, path: "/repo" });

  // Through the parsers, with tool details kept.
  const T = Date.parse("2026-10-01T10:00:00Z");
  const claude = parseClaudeTranscriptText(
    claudeTranscript("trunc-1", [{ ts: T, input: 1, output: 1 }], "/work/est", [{ ts: T + 1_000, name: "Write", input }]),
    {}, { keep: { prompts: false, toolDetails: true } })!;
  const tool = claude.toolCalls[0];
  assert.equal(JSON.parse(tool.input!).file_path, input.file_path);
  assert.equal(tool.inputBytes, full.length, "the full size is still reported");
  const patch = JSON.stringify({ path: "/repo/a.ts", input: "p".repeat(40_000) });
  const codex = parseCodexRolloutText(
    codexRollout("0199bbbb-cccc-7ddd-8eee-ffff00000003", [{ ts: T, input: 10, cached: 0, output: 1 }], [{ ts: T + 1_000, arguments: patch }]),
    {}, { keep: { prompts: false, toolDetails: true } })!;
  const args = codex.toolCalls[0].input!;
  assert.ok(args.length <= MAX_TOOL_INPUT_CHARS);
  assert.equal(JSON.parse(args).path, "/repo/a.ts");
});
