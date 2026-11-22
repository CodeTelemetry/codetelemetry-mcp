// The hook program and its launchers, run as Cursor runs them: as child
// processes fed an event on stdin. Every path is inside a temporary directory
// and no child inherits this process's environment; the import below also moves
// the home directory, so nothing here can reach a real ~/.cursor or ~/.local.
import "../support/isolateHome.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { holdsCredentialStrict as holdsCredential, passesSecretArgument, scrubCredentials as releasedScrub, scrubCredentialsStrict as scrubCredentials } from "../../src/client/collector/scrub.ts";
import { CURSOR_FILE_MARKER, cursorPaths, cursorStateFiles, type CursorNetwork, type CursorNode } from "../../src/client/cursor/config.ts";
import {
  CURSOR_HOOK_EVENTS, CURSOR_HOOK_LIMITS, cursorCollectorLauncher, cursorHookLauncher, cursorHookProgram,
  installCursorCollectorLauncher, installCursorHookFiles, removeCursorHookFiles, type CursorSpoolLine,
} from "../../src/client/cursor/hookProgram.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");
const EVENTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "hook-events.json"), "utf8")) as Record<string, Record<string, any>>;
const CONVERSATION = "6f1d2c3b-4a59-4e68-9f70-8192a3b4c5d6";
const TURN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

type Policy = { prompts?: boolean; toolDetails?: boolean; email?: boolean };
type Outcome = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number };
type Sandbox = ReturnType<typeof sandbox>;

function sandbox(t: TestContext, policy: Policy = {}, node: CursorNode = { execPath: process.execPath }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = cursorPaths(root), state = cursorStateFiles(paths.stateDir);
  const install = (next: Policy = policy, interpreter: CursorNode = node) => installCursorHookFiles({
    shareDir: paths.shareDir, stateDir: paths.stateDir, node: interpreter,
    content: { prompts: !!next.prompts, toolDetails: !!next.toolDetails }, identity: { email: !!next.email },
  });
  install();
  return { root, paths, state, install };
}

/** Run a command with exactly the given environment and input. With `hold`,
 *  stdin stays open until the child has exited on its own. A child that has not
 *  exited after 20 seconds is killed, which the caller sees as a signal. */
function execute(command: string, args: string[], input: string | Buffer | null,
  opts: { hold?: boolean; env?: Record<string, string> } = {}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { env: opts.env ?? {}, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", () => child.stdin.destroy());
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), elapsedMs: performance.now() - started });
    });
    if (input !== null) child.stdin.write(input);
    if (!opts.hold) child.stdin.end();
  });
}

const runHook = (s: Sandbox, input: string | Buffer | null, opts: { hold?: boolean; preload?: string } = {}) =>
  execute(process.execPath, [...(opts.preload ? ["-r", opts.preload] : []), s.paths.hookProgram], input, opts);
const runLauncher = (s: Sandbox, input: string | null, env: Record<string, string> = {}) =>
  execute("/bin/sh", [s.paths.hook], input, { env });

/** The whole contract with the editor: status 0, and not one byte printed. */
function assertSilent(outcome: Outcome, label = ""): void {
  assert.deepEqual({ code: outcome.code, signal: outcome.signal, stdout: outcome.stdout, stderr: outcome.stderr },
    { code: 0, signal: null, stdout: "", stderr: "" }, label);
}

function spoolText(s: Sandbox): string {
  if (!fs.existsSync(s.state.spool) || !fs.statSync(s.state.spool).isDirectory()) return "";
  return fs.readdirSync(s.state.spool).sort().map(name => fs.readFileSync(path.join(s.state.spool, name), "utf8")).join("");
}
function spoolLines(s: Sandbox): CursorSpoolLine[] {
  const text = spoolText(s);
  assert.ok(text === "" || text.endsWith("\n"), "every record ends its line");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as CursorSpoolLine);
}
const drops = (s: Sandbox): number => fs.existsSync(s.state.dropped) ? fs.statSync(s.state.dropped).size : 0;
const event = (name: string, patch: Record<string, unknown> = {}): string => JSON.stringify({ ...EVENTS[name], ...patch });
/** UTF-8 size of a string as it is, or of any other value as JSON. */
const utf8 = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const segmentName = (offset = 0) => `seg-${Math.floor(Date.now() / CURSOR_HOOK_LIMITS.segmentMs) + offset}.jsonl`;

async function payloadOf(s: Sandbox, input: string): Promise<Record<string, any>> {
  const before = spoolLines(s).length;
  assertSilent(await runHook(s, input));
  const lines = spoolLines(s);
  assert.equal(lines.length, before + 1, "one event, one line");
  return lines.at(-1)!.payload;
}

/** What each fixture event must become with every option off. */
function metadataOnly(name: string): Record<string, unknown> {
  const e = EVENTS[name]!;
  const turn = { generation_id: TURN, model: "default", cursor_version: "2099.1.2-synthetic" };
  const tool = "tool_name" in e
    ? { ...turn, tool_name: e.tool_name, tool_use_id: e.tool_use_id, duration: e.duration, tool_input_size_bytes: jsonBytes(e.tool_input) } : turn;
  switch (name) {
    case "beforeSubmitPrompt": return { ...turn, model_id: "synthetic-auto", composer_mode: "agent", prompt_length: 49, attachment_count: 1 };
    case "afterAgentThought": return { generation_id: `${TURN}-0-zz91`, model: "synthetic-model-high", model_id: "synthetic-model",
      model_params: [{ id: "effort", value: "high" }, { id: "speed", value: "default" }] };
    case "afterAgentThoughtDefault": return { generation_id: TURN, model: "default" };
    case "afterShellExecution": return { tool_use_id: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", sandbox: true };
    case "postToolUseRead": return { ...tool, result: { content_length: 57 } };
    case "postToolUseShell": return { ...tool, result: { exit_code: 0, output_bytes: 24 } };
    case "postToolUseWrite": return { ...tool, result: { success: true } };
    case "postToolUseGrep": return { ...tool, result: { success: true } };
    case "postToolUseTask": return { ...tool, result: { agent_id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f" } };
    case "postToolUseFailure": return { ...tool, failure_type: "error", is_interrupt: false, error_bytes: 29 };
    case "stop": return { ...turn, model_id: "synthetic-auto", status: "completed", loop_count: 0,
      input_tokens: 18250, output_tokens: 310, cache_read_tokens: 17920, cache_write_tokens: 0 };
    default: throw new Error(`no expectation for ${name}`);
  }
}

async function capture(s: Sandbox): Promise<Record<string, CursorSpoolLine>> {
  const captured: Record<string, CursorSpoolLine> = {};
  for (const name of Object.keys(EVENTS)) {
    assertSilent(await runHook(s, event(name)), name);
    captured[name] = spoolLines(s).at(-1)!;
  }
  assert.equal(spoolLines(s).length, Object.keys(EVENTS).length);
  assert.equal(drops(s), 0);
  return captured;
}

test("the fixture covers the six registered events", () => {
  assert.deepEqual([...new Set(Object.values(EVENTS).map(e => e.hook_event_name))].sort(), [...CURSOR_HOOK_EVENTS].sort());
  assert.equal(EVENTS.beforeSubmitPrompt!.prompt.length, 49);
  assert.equal(utf8(EVENTS.postToolUseFailure!.error_message), 29);
});

test("metadata-only writes no prompt text, tool input or output, path or email", async t => {
  const s = sandbox(t), started = BigInt(Date.now()) * 1_000_000n;
  const captured = await capture(s);
  const finished = BigInt(Date.now() + 1) * 1_000_000n;
  for (const [name, line] of Object.entries(captured)) {
    assert.deepEqual(Object.keys(line), ["v", "id", "t", "hook", "conversation_id", "p", "payload"], name);
    assert.equal(line.v, 1);
    assert.match(line.id, /^[0-9a-f]{32}$/);
    assert.match(line.t, /^\d{16}000$/, "nanoseconds at microsecond precision");
    assert.ok(BigInt(line.t) >= started && BigInt(line.t) <= finished, "capture time is the wall clock");
    assert.equal(line.hook, EVENTS[name]!.hook_event_name);
    assert.equal(line.conversation_id, CONVERSATION);
    assert.deepEqual(line.p, { prompts: false, toolDetails: false, email: false });
    assert.deepEqual(line.payload, metadataOnly(name), name);
  }
  assert.equal(new Set(Object.values(captured).map(line => line.id)).size, Object.keys(EVENTS).length);
  assert.equal(captured.postToolUseRead!.payload.tool_use_id,
    "call-5d0c7a11-22b3-4c44-9d55-66e7f8a9b0c1-0\nfc_1e2d3c4b-5a69-4788-8695-a4b3c2d1e0f9_0", "a tool id with a line break survives");
  const text = spoolText(s);
  for (const forbidden of ["CANARY", "/srv/fixture", "example.test", "transcript", "workspace", "user_email", "tool_output", "error_message", "edits"]) {
    assert.ok(!text.includes(forbidden), `metadata-only spool holds ${forbidden}`);
  }
  assert.equal(fs.statSync(path.join(s.state.spool, fs.readdirSync(s.state.spool)[0]!)).mode & 0o777, 0o600);
});

test("--enrich keeps the scrubbed prompt and allow-listed tool arguments, and still no output, content or email", async t => {
  const s = sandbox(t, { prompts: true, toolDetails: true });
  const captured = await capture(s), root = "/srv/fixture/repo-alpha";
  const withRoot = (name: string, extra: Record<string, unknown>) => {
    const { generation_id, model, model_id, cursor_version, composer_mode, ...rest } = metadataOnly(name);
    return { generation_id, model, ...(model_id ? { model_id } : {}), cursor_version, ...(composer_mode ? { composer_mode } : {}), workspace_root: root, ...rest, ...extra };
  };
  assert.deepEqual(captured.beforeSubmitPrompt!.payload, withRoot("beforeSubmitPrompt", { prompt: "CANARY_PROMPT rename the helper and run the tests" }));
  assert.deepEqual(captured.postToolUseShell!.payload, withRoot("postToolUseShell", { tool_input: { command: "npm test -- CANARY_COMMAND", cwd: root, timeout: 30000 } }));
  assert.deepEqual(captured.postToolUseRead!.payload, withRoot("postToolUseRead", { tool_input: { file_path: `${root}/src/CANARY_PATH.ts` } }));
  assert.deepEqual(captured.postToolUseWrite!.payload, withRoot("postToolUseWrite", { tool_input: { file_path: `${root}/src/CANARY_PATH.ts` } }));
  assert.deepEqual(captured.postToolUseGrep!.payload, withRoot("postToolUseGrep", { tool_input: { pattern: "CANARY_PATTERN", glob: "*.ts", output_mode: "files_with_matches" } }));
  assert.deepEqual(captured.postToolUseTask!.payload, withRoot("postToolUseTask",
    { tool_input: { subagent_type: "explore", run_in_background: false, model: "fast", description: "CANARY_TASK_DESCRIPTION list the callers" } }));
  assert.deepEqual(captured.postToolUseFailure!.payload, withRoot("postToolUseFailure", { tool_input: { command: "false # CANARY_COMMAND", cwd: root, timeout: 30000 } }));
  assert.deepEqual(captured.stop!.payload, withRoot("stop", {}));
  for (const name of ["afterAgentThought", "afterAgentThoughtDefault", "afterShellExecution"]) {
    assert.deepEqual(captured[name]!.payload, metadataOnly(name), "context records carry no option-dependent field");
  }
  for (const line of Object.values(captured)) assert.deepEqual(line.p, { prompts: true, toolDetails: true, email: false });
  const text = spoolText(s);
  for (const forbidden of ["CANARY_FILE_CONTENT", "CANARY_OUTPUT", "CANARY_ERROR", "CANARY_THOUGHT", "CANARY_EDIT", "CANARY_TASK_PROMPT",
    "CANARY_RESPONSE", "CANARY_TRANSCRIPT", "CANARY_ATTACHMENT", "repo-beta", "example.test", "head_limit"]) {
    assert.ok(!text.includes(forbidden), `--enrich spool holds ${forbidden}`);
  }
});

test("--identity alone adds the account email to the four uploaded events and nothing else", async t => {
  const s = sandbox(t, { email: true });
  const captured = await capture(s);
  for (const [name, line] of Object.entries(captured)) {
    const uploaded = !["afterAgentThought", "afterShellExecution"].includes(line.hook);
    assert.deepEqual(line.payload, uploaded ? { ...metadataOnly(name), user_email: "dev.fixture@example.test" } : metadataOnly(name), name);
    assert.deepEqual(line.p, { prompts: false, toolDetails: false, email: true });
  }
  assert.ok(!/CANARY|\/srv\/fixture/.test(spoolText(s)));
  for (const invalid of ["no-at-sign", "two@@example.test", "spaced name@example.test", `${"a".repeat(65)}@example.test`, 7, null, ["dev@example.test"]]) {
    assert.ok(!("user_email" in await payloadOf(s, event("stop", { user_email: invalid }))), `kept ${JSON.stringify(invalid)}`);
  }
});

test("each content option adds only its own fields", async t => {
  const prompts = sandbox(t, { prompts: true });
  assert.equal((await payloadOf(prompts, event("beforeSubmitPrompt"))).prompt, "CANARY_PROMPT rename the helper and run the tests");
  for (const name of ["postToolUseShell", "postToolUseTask", "postToolUseFailure", "stop"]) {
    assert.deepEqual(await payloadOf(prompts, event(name)), metadataOnly(name), `prompts alone changed ${name}`);
  }
  const details = sandbox(t, { toolDetails: true });
  const prompt = await payloadOf(details, event("beforeSubmitPrompt"));
  assert.ok(!("prompt" in prompt));
  assert.equal(prompt.workspace_root, "/srv/fixture/repo-alpha");
  assert.deepEqual((await payloadOf(details, event("postToolUseTask"))).tool_input, { subagent_type: "explore", run_in_background: false, model: "fast" },
    "a Task description is prompt text and needs the prompts option as well");
  assert.ok(!spoolText(details).includes("CANARY_PROMPT") && !spoolText(details).includes("CANARY_TASK"));
});

test("prompt text is scrubbed exactly as the shared scrubber does, then cut", async t => {
  const s = sandbox(t, { prompts: true });
  const samples = [
    "plain text stays as it is",
    `use Bearer ${"b".repeat(24)} for the call`,
    "password: hunter2-fixture and api_key=FIXTUREVALUE1234",
    `{"token": "fixture-token-value", "other": 1}`,
    `aws ${"AKIA" + "Q".repeat(16)} and ${"gh" + "p_" + "a1".repeat(12)} and ${"sk-" + "z9".repeat(10)}`,
    `-----BEGIN RSA ${"PRIVATE"} KEY-----\nFIXTUREBODY\n-----END RSA ${"PRIVATE"} KEY-----\nafter the block`,
    `jwt ${"ey" + "J" + "a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)} end`,
    "clone https://fixture-user:fixture-pass@git.example.test/repo.git now",
    `key ${"cot" + "_" + "k".repeat(28)} end`,
    `unterminated -----BEGIN ${"PRIVATE"} KEY----- tail without an end marker`,
  ];
  for (const sample of samples) {
    const payload = await payloadOf(s, event("beforeSubmitPrompt", { prompt: sample }));
    assert.equal(payload.prompt, scrubCredentials(sample, CURSOR_HOOK_LIMITS.promptChars), sample.slice(0, 30));
    assert.equal(payload.prompt_length, sample.length, "the length is that of the original");
  }
  assert.ok(samples.slice(1).every(sample => scrubCredentials(sample, 1e6) !== sample), "every credential sample is one the scrubber changes");

  const long = "word ".repeat(5000);
  const cut = await payloadOf(s, event("beforeSubmitPrompt", { prompt: long }));
  assert.equal(cut.prompt, long.slice(0, CURSOR_HOOK_LIMITS.promptChars));
  assert.equal(cut.prompt_length, 25000);

  // A secret that begins inside the kept length and runs past the scrubbed
  // prefix must not leave a readable piece behind.
  const secret = `${"sk-"}${"s".repeat(8000)}`;
  const straddle = await payloadOf(s, event("beforeSubmitPrompt", { prompt: `${"lead ".repeat(3200)}${secret} tail` }));
  assert.ok(!straddle.prompt.includes("sss"), "no part of the cut token is kept");
  assert.ok(straddle.prompt.length <= CURSOR_HOOK_LIMITS.promptChars);

  const pair = String.fromCodePoint(0x1f600);
  const surrogate = await payloadOf(s, event("beforeSubmitPrompt", { prompt: "x".repeat(CURSOR_HOOK_LIMITS.promptChars - 1) + pair + "y" }));
  assert.equal(surrogate.prompt, "x".repeat(CURSOR_HOOK_LIMITS.promptChars - 1), "a cut never leaves half a character");
});

// Invented values in the shapes a reviewer found passing unscrubbed. SECRET is
// the part that must never reach the spool.
const SECRET = "S3cr3tFixture9Zq";
const LEAKY_PROMPTS = [
  `why does curl -H 'Authorization: Bearer ${SECRET}' fail`,
  `header is Authorization: Basic ${SECRET} ok?`,
  `token = Bearer ${SECRET}`,
  `{"Authorization": "Basic ${SECRET}"}`,
  `set AWS_SECRET_ACCESS_KEY=${SECRET} then run`,
  `export STRIPE_KEY=rk_live_${SECRET}`,
  `db_password: ${SECRET}`,
  `export API_TOKEN="two words ${SECRET}"`,
  `my db is postgres://admin:${SECRET}@db.example.test/prod`,
  `redis://:${SECRET}@cache.example.test:6379 and mongodb+srv://app:${SECRET}@cluster.example.test`,
  `the password is ${SECRET}`,
  `curl -H 'X-Auth: ${SECRET}' https://api.example.test`,
];
const LEAKY_COMMANDS = [
  `export AWS_SECRET_ACCESS_KEY=${SECRET}`,
  `STRIPE_KEY=rk_live_${SECRET} node x.js`,
  `psql postgres://admin:${SECRET}@db.example.test:5432/prod`,
  `mysql -u root -p${SECRET} prod`,
  `mysql --password ${SECRET}`,
  `tool --password=${SECRET} run`,
  `docker login -u me -p ${SECRET}`,
  `sshpass -p ${SECRET} ssh host.example.test`,
  `redis-cli -a ${SECRET} ping`,
  `curl -u admin:${SECRET} https://api.example.test/x`,
  `curl --user admin:${SECRET} https://api.example.test/x`,
  `curl -H 'X-Auth: ${SECRET}' https://api.example.test/x`,
  `curl -H "X-Api-Key: ${SECRET}" https://api.example.test/x`,
  `curl -H 'Authorization: Basic ${SECRET}' https://api.example.test/x`,
];
const PLAIN_COMMANDS = ["npm test -- --grep transport", "mkdir -p a/b && ls -la", "ssh -p 2222 host.example.test uptime", "docker run -p 8080:80 nginx",
  "git commit --author 'A Fixture <a@example.test>' -m message", "curl -H 'Accept: application/json' https://api.example.test/x"];

test("credential shapes the released patterns let through are scrubbed from prompts and withhold a tool input", async t => {
  const s = sandbox(t, { prompts: true, toolDetails: true });
  for (const sample of LEAKY_PROMPTS) {
    const payload = await payloadOf(s, event("beforeSubmitPrompt", { prompt: sample }));
    assert.ok(!payload.prompt.includes(SECRET), `the prompt kept the secret: ${sample.replace(SECRET, "<secret>")}`);
    assert.ok(payload.prompt.includes("<REDACTED>"));
    assert.equal(payload.prompt, scrubCredentials(sample, CURSOR_HOOK_LIMITS.promptChars), "the generated program and the module agree");
  }
  assert.ok(LEAKY_PROMPTS.filter(sample => releasedScrub(sample, 1e6).includes(SECRET)).length >= 10, "these are shapes the released patterns do not remove");
  for (const command of LEAKY_COMMANDS) {
    const payload = await payloadOf(s, event("postToolUseShell", { tool_input: { command, cwd: "/srv/fixture/repo-alpha" } }));
    assert.ok(!("tool_input" in payload), `the command was kept: ${command.replace(SECRET, "<secret>")}`);
    assert.ok(holdsCredential(command) || passesSecretArgument(command));
  }
  assert.ok(!spoolText(s).includes(SECRET), "no form of the secret is on disk");
  for (const command of PLAIN_COMMANDS) {
    const payload = await payloadOf(s, event("postToolUseShell", { tool_input: { command } }));
    assert.deepEqual(payload.tool_input, { command }, "an ordinary command is still kept whole");
  }
  // Only a Shell command is read as a command line.
  const grep = await payloadOf(s, event("postToolUseGrep", { tool_input: { pattern: "mysql -u root -p", glob: "*.md" } }));
  assert.deepEqual(grep.tool_input, { pattern: "mysql -u root -p", glob: "*.md" });
});

test("the credential patterns stay linear on text built to make them rescan", async t => {
  const cases: Record<string, string> = {
    "colons after a scheme": "x http://" + "a:".repeat(9900),
    "colons before a scheme": "http://" + ":a".repeat(9900),
    "one long secret-named word": "key_".repeat(4900),
    "many header prefixes": "x-".repeat(9900),
    "schemes without an end": "a://b:".repeat(3300),
    "unterminated quotes": ('password="' + "a".repeat(100)).repeat(180),
    "long options": (" --" + "a".repeat(30)).repeat(600),
    "a program and no option": ("mysql " + "a".repeat(500)).repeat(38),
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(text.length <= CURSOR_HOOK_LIMITS.scrubChars, name);
    // Ten times the text must not cost anything like a hundred times as much.
    const cost = (value: string) => {
      const started = performance.now();
      for (let round = 0; round < 5; round++) { scrubCredentials(value, 1e6); passesSecretArgument(value); }
      return performance.now() - started;
    };
    cost(text);
    assert.ok(cost(text) < 250, `${name} took ${cost(text)} ms for five passes`);
  }
  const s = sandbox(t, { prompts: true });
  for (const text of Object.values(cases)) {
    const outcome = await runHook(s, event("beforeSubmitPrompt", { prompt: text }));
    assertSilent(outcome);
    assert.ok(outcome.elapsedMs < CURSOR_HOOK_LIMITS.deadlineMs, `took ${outcome.elapsedMs} ms`);
  }
  assert.equal(drops(s), 0);
});

test("the scrubbed prefix bounds the cost of a pathological prompt", async t => {
  const s = sandbox(t, { prompts: true });
  const outcome = await runHook(s, event("beforeSubmitPrompt", { prompt: "http://" + "a:".repeat(1_000_000) }));
  assertSilent(outcome);
  assert.ok(outcome.elapsedMs < CURSOR_HOOK_LIMITS.deadlineMs, `took ${outcome.elapsedMs} ms`);
  const [line] = spoolLines(s);
  assert.equal(line!.payload.prompt, "");
  assert.equal(line!.payload.prompt_length, 2_000_007);
});

test("tool arguments are kept whole or withheld whole", async t => {
  const s = sandbox(t, { prompts: true, toolDetails: true });
  const shell = (tool_input: unknown, patch: Record<string, unknown> = {}) => payloadOf(s, event("postToolUseShell", { tool_input, ...patch }));
  const withheld = [
    { command: `curl -H "Authorization: Bearer ${"t".repeat(20)}" https://api.example.test`, cwd: "/srv/fixture/repo-alpha" },
    { command: `deploy --key ${"cot" + "_" + "k".repeat(28)}`, cwd: "/srv/fixture/repo-alpha" },
    { command: "echo <REDACTED>", cwd: "/srv/fixture/repo-alpha" },
    { command: "x".repeat(CURSOR_HOOK_LIMITS.inputChars), cwd: "/srv/fixture/repo-alpha" },
    { other: "only keys outside the list" },
    {},
  ];
  for (const tool_input of withheld) {
    const payload = await shell(tool_input);
    assert.ok(!("tool_input" in payload), `kept ${JSON.stringify(tool_input).slice(0, 50)}`);
    assert.equal(payload.tool_input_size_bytes, jsonBytes(tool_input), "the size is always reported");
  }
  assert.ok(holdsCredential(withheld[0]!.command!) && holdsCredential(withheld[1]!.command!));
  assert.deepEqual((await shell({ command: "ls", cwd: 5, timeout: "30", env: { A: "b" }, extra: true })).tool_input, { command: "ls" },
    "a listed key of the wrong type and every unlisted key are left out");
  assert.deepEqual((await shell({ command: "ls -la", cwd: "/srv/x", timeout: 1500.5 })).tool_input, { command: "ls -la", cwd: "/srv/x", timeout: 1500.5 });
  for (const tool_input of ["a string", ["command", "ls"], 7, null]) {
    const payload = await shell(tool_input);
    assert.ok(!("tool_input" in payload));
    assert.equal(payload.tool_input_size_bytes, jsonBytes(tool_input));
  }
  for (const tool_name of ["Edit", "mcp__fixture__query", "constructor", "__proto__", "toString"]) {
    assert.ok(!("tool_input" in await shell({ command: "ls", file_path: "/srv/x" }, { tool_name })), `${tool_name} has no allow-list`);
  }
  const write = await payloadOf(s, event("postToolUseWrite"));
  assert.deepEqual(write.tool_input, { file_path: "/srv/fixture/repo-alpha/src/CANARY_PATH.ts" });
  assert.ok(!spoolText(s).includes("CANARY_FILE_CONTENT"), "file content is never copied");
  const secretPath = await payloadOf(s, event("stop", { workspace_roots: ["/srv/fixture/password=hunter2-dir"] }));
  assert.ok(!("workspace_root" in secretPath), "a path the scrubber would change is withheld, not altered");
  for (const workspace_roots of [[], [7], "/srv/x", [""], ["/" + "p".repeat(2048)]]) {
    assert.ok(!("workspace_root" in await payloadOf(s, event("stop", { workspace_roots }))));
  }
});

test("only values of the expected type and size are copied", async t => {
  const s = sandbox(t);
  const stop = await payloadOf(s, event("stop", {
    generation_id: "g".repeat(257), model: 7, model_id: "", cursor_version: "v".repeat(65), composer_mode: ["agent"], status: { nested: true },
    loop_count: "0", input_tokens: "18250", output_tokens: "9".repeat(33), cache_read_tokens: null, cache_write_tokens: [0],
  }));
  assert.deepEqual(stop, { input_tokens: "18250" }, "a counter passes through as a number or a short string, verbatim");
  assert.deepEqual(await payloadOf(s, event("stop", { input_tokens: 1.5, output_tokens: -3, cache_read_tokens: 1e15, cache_write_tokens: "" })),
    { ...metadataOnly("stop"), input_tokens: 1.5, output_tokens: -3, cache_read_tokens: 1e15, cache_write_tokens: "" },
    "the hook does not judge a counter; the service does");

  const tool = await payloadOf(s, event("postToolUseShell", { tool_name: "n".repeat(129), tool_use_id: "i".repeat(513), duration: "618", tool_input: undefined }));
  assert.deepEqual(tool, { generation_id: TURN, model: "default", cursor_version: "2099.1.2-synthetic", result: { exit_code: 0, output_bytes: 24 } });
  assert.equal((await payloadOf(s, event("postToolUseShell", { tool_use_id: "i".repeat(512) }))).tool_use_id.length, 512);

  const results: Array<[unknown, Record<string, unknown>]> = [
    ['{"output":"h\\u00e9llo","exitCode":3}', { exit_code: 3, output_bytes: 6 }],
    ['{"output":7,"exitCode":"0","content_length":"57","success":"true","agentId":9}', {}],
    ['{"exitCode":1.5,"content_length":-4,"success":false}', { content_length: -4, success: false }],
    ["not json", {}],
    ['["array"]', {}],
    ["null", {}],
    [undefined, {}],
    [{ exitCode: 0, output: "" }, { exit_code: 0, output_bytes: 0 }],
    [`{"agentId":"${"a".repeat(257)}"}`, {}],
  ];
  for (const [tool_output, expected] of results) {
    assert.deepEqual((await payloadOf(s, event("postToolUseShell", { tool_output }))).result, expected, String(tool_output));
  }

  const failure = await payloadOf(s, event("postToolUseFailure", { failure_type: "f".repeat(65), is_interrupt: "no", error_message: { text: "CANARY_ERROR" } }));
  assert.ok(!("failure_type" in failure) && !("is_interrupt" in failure) && !("error_bytes" in failure) && !("result" in failure));
  assert.equal((await payloadOf(s, event("postToolUseFailure", { is_interrupt: true, error_message: "h" + String.fromCharCode(0xe9) }))).error_bytes, 3);

  const params = Array.from({ length: 12 }, (_, index) => ({ id: `id${index}`, value: `value${index}`, note: "CANARY_PARAM" }));
  const thought = await payloadOf(s, event("afterAgentThought", {
    model_params: [{ id: "x".repeat(65), value: "long id" }, { id: "typed", value: 3 }, "text", null, ...params],
  }));
  assert.deepEqual(thought.model_params, params.slice(0, 8).map(({ id, value }) => ({ id, value })), "at most eight {id, value} string pairs");
  assert.ok(!("model_params" in await payloadOf(s, event("afterAgentThought", { model_params: "high" }))));
  assert.deepEqual(await payloadOf(s, event("afterShellExecution", { sandbox: "true", tool_use_id: 5 })), {});
  assert.deepEqual(await payloadOf(s, event("beforeSubmitPrompt", { prompt: ["CANARY_PROMPT"], attachments: "CANARY_ATTACHMENT" })),
    { generation_id: TURN, model: "default", model_id: "synthetic-auto", cursor_version: "2099.1.2-synthetic", composer_mode: "agent" });
  assert.ok(!spoolText(s).includes("CANARY"));
});

test("a prompt that would take its line over the bound is cut to the longest beginning that fits", async t => {
  const s = sandbox(t, { prompts: true, toolDetails: true });
  const lastLineBytes = () => utf8(spoolText(s).trimEnd().split("\n").at(-1)!) + 1;
  // Three bytes a character: the whole prompt would be 48 KiB of a 32 KiB line.
  const wide = String.fromCodePoint(0x4e16).repeat(CURSOR_HOOK_LIMITS.promptChars);
  assert.ok(utf8(wide) > CURSOR_HOOK_LIMITS.lineBytes);
  const payload = await payloadOf(s, event("beforeSubmitPrompt", { prompt: wide }));
  assert.ok(payload.prompt.length > 10000 && payload.prompt.length < CURSOR_HOOK_LIMITS.promptChars);
  assert.equal(payload.prompt, wide.slice(0, payload.prompt.length), "what is kept is the beginning, unchanged");
  assert.equal(payload.prompt_length, CURSOR_HOOK_LIMITS.promptChars, "the length is that of the original");
  assert.equal(payload.workspace_root, "/srv/fixture/repo-alpha");
  assert.ok(lastLineBytes() <= CURSOR_HOOK_LIMITS.lineBytes);
  assert.ok(lastLineBytes() > CURSOR_HOOK_LIMITS.lineBytes - 3, "one more character would not fit");

  // Characters that JSON writes as six bytes each, and pairs that must stay whole.
  const control = await payloadOf(s, event("beforeSubmitPrompt", { prompt: "\u0001".repeat(CURSOR_HOOK_LIMITS.promptChars) }));
  assert.match(control.prompt, /^\u0001{4000,5461}$/);
  assert.ok(lastLineBytes() <= CURSOR_HOOK_LIMITS.lineBytes && lastLineBytes() > CURSOR_HOOK_LIMITS.lineBytes - 6);
  const pair = String.fromCodePoint(0x1f600);
  for (const lead of ["", "x"]) {
    const pairs = await payloadOf(s, event("beforeSubmitPrompt", { prompt: lead + pair.repeat(8191) }));
    assert.ok(lastLineBytes() <= CURSOR_HOOK_LIMITS.lineBytes);
    assert.equal(pairs.prompt, lead + pair.repeat((pairs.prompt.length - lead.length) / 2), "a cut never leaves half a character");
    assert.ok(pairs.prompt.length > 15000);
  }

  const fits = await payloadOf(s, event("beforeSubmitPrompt", { prompt: String.fromCodePoint(0x4e16).repeat(10000) }));
  assert.equal(fits.prompt.length, 10000);
  assert.equal(drops(s), 0);
  for (const line of spoolLines(s)) assert.deepEqual(line.p, { prompts: true, toolDetails: true, email: false });
});

test("events Connect did not register leave no line and no drop; an unusable conversation id is a drop", async t => {
  const s = sandbox(t);
  for (const hook_event_name of ["sessionStart", "afterAgentResponse", "beforeReadFile", "", 7, null, undefined, "constructor"]) {
    assertSilent(await runHook(s, event("stop", { hook_event_name })));
  }
  assert.deepEqual(spoolLines(s), []);
  assert.equal(drops(s), 0);
  const invalid = [undefined, null, 7, "", "has space", "-leading", "a".repeat(257), "line\nbreak", ["x"]];
  for (const conversation_id of invalid) assertSilent(await runHook(s, event("stop", { conversation_id })));
  assert.deepEqual(spoolLines(s), []);
  assert.equal(drops(s), invalid.length);
  assert.equal(fs.statSync(s.state.dropped).mode & 0o777, 0o600);
});

test("malformed, empty and oversized input exits 0, prints nothing and counts a drop", async t => {
  const s = sandbox(t);
  const inputs: Array<string | Buffer> = ["", "not json {{{", "{", "[1,2,3]", "null", "42", '"text"', event("stop").slice(0, -1), Buffer.from([0xff, 0xfe, 0x00, 0x7b])];
  for (const input of inputs) assertSilent(await runHook(s, input), String(input).slice(0, 20));
  assert.equal(drops(s), inputs.length);

  const huge = event("beforeSubmitPrompt", { prompt: "p".repeat(CURSOR_HOOK_LIMITS.stdinBytes + 1024) });
  const garbage = Buffer.alloc(3 * CURSOR_HOOK_LIMITS.stdinBytes, 0x78);
  for (const input of [huge, garbage]) {
    const outcome = await runHook(s, input);
    assertSilent(outcome);
    assert.ok(outcome.elapsedMs < CURSOR_HOOK_LIMITS.deadlineMs + 1500, `took ${outcome.elapsedMs} ms`);
  }
  assert.equal(drops(s), inputs.length + 2);
  assert.deepEqual(spoolLines(s), []);
  const atBound = event("beforeSubmitPrompt", { prompt: "p".repeat(CURSOR_HOOK_LIMITS.stdinBytes - 4096) });
  assert.ok(utf8(atBound) <= CURSOR_HOOK_LIMITS.stdinBytes);
  assert.equal((await payloadOf(s, atBound)).prompt_length, CURSOR_HOOK_LIMITS.stdinBytes - 4096);
});

test("stdin held open cannot hold the editor: the hook exits 0 at its deadline", async t => {
  const s = sandbox(t);
  const stuck = await Promise.all([
    runHook(s, null, { hold: true }),
    runHook(s, event("stop").slice(0, 40), { hold: true }),
    runHook(s, event("stop"), { hold: true }),
  ]);
  for (const outcome of stuck) {
    assertSilent(outcome);
    assert.ok(outcome.elapsedMs >= CURSOR_HOOK_LIMITS.deadlineMs - 100, `exited after ${outcome.elapsedMs} ms without waiting for the deadline`);
    assert.ok(outcome.elapsedMs < 3000, `exited after ${outcome.elapsedMs} ms; Cursor's own timeout is 5000`);
  }
  assert.equal(drops(s), 2, "nothing and half an event are drops");
  assert.deepEqual(spoolLines(s).map(line => line.payload), [metadataOnly("stop")], "a complete event is kept even though stdin never closed");
});

test("a missing or unusable spool exits 0, prints nothing and counts a drop", async t => {
  const missing = sandbox(t);
  fs.rmSync(missing.state.spool, { recursive: true });
  assertSilent(await runHook(missing, event("stop")));
  assert.equal(drops(missing), 1);
  assert.equal(fs.existsSync(missing.state.spool), false, "the hook creates no directory");

  const gone = sandbox(t);
  fs.rmSync(gone.paths.stateDir, { recursive: true });
  assertSilent(await runHook(gone, event("stop")));
  assert.equal(fs.existsSync(gone.paths.stateDir), false);

  const file = sandbox(t);
  fs.rmSync(file.state.spool, { recursive: true });
  fs.writeFileSync(file.state.spool, "");
  assertSilent(await runHook(file, event("stop")));
  assert.equal(drops(file), 1);

  // A planted link is never written through, for the segment or the counter.
  const linked = sandbox(t), victim = path.join(linked.root, "victim.txt");
  fs.writeFileSync(victim, "untouched");
  for (const offset of [0, 1]) fs.symlinkSync(victim, path.join(linked.state.spool, segmentName(offset)));
  fs.symlinkSync(victim, linked.state.dropped);
  assertSilent(await runHook(linked, event("stop")));
  assert.equal(fs.readFileSync(victim, "utf8"), "untouched");

  const directory = sandbox(t);
  for (const offset of [0, 1]) fs.mkdirSync(path.join(directory.state.spool, segmentName(offset)));
  assertSilent(await runHook(directory, event("stop")));
  assert.equal(drops(directory), 1);

  // Opening a FIFO for writing waits for a reader unless the open is non-blocking.
  const fifo = sandbox(t);
  const made = [0, 1].map(offset => spawnSync("mkfifo", [path.join(fifo.state.spool, segmentName(offset))], { env: { PATH: "/usr/bin:/bin" } }).status);
  if (made.every(status => status === 0)) {
    const outcome = await runHook(fifo, event("stop"));
    assertSilent(outcome);
    assert.ok(outcome.elapsedMs < CURSOR_HOOK_LIMITS.deadlineMs - 100, `waited ${outcome.elapsedMs} ms on a FIFO`);
    assert.equal(drops(fifo), 1);
  } else t.diagnostic("mkfifo is unavailable; the FIFO case was not run");
});

/** Run `step` again if the ten-minute bucket changed while it ran: what it
 *  prepared was then for the bucket before the one the hook used. */
async function inOneBucket<T>(step: (bucket: number) => Promise<T>): Promise<T> {
  for (;;) {
    const bucket = Math.floor(Date.now() / CURSOR_HOOK_LIMITS.segmentMs);
    const result = await step(bucket);
    if (Math.floor(Date.now() / CURSOR_HOOK_LIMITS.segmentMs) === bucket) return result;
  }
}
const spoolSize = (s: Sandbox) => path.join(s.paths.stateDir, "spool-size");
/** A segment of an earlier bucket with `bytes` of size and nothing on disk. */
function sparse(s: Sandbox, index: number, bytes: number): void {
  const file = path.join(s.state.spool, `seg-${10000 + index}.jsonl`);
  fs.writeFileSync(file, "");
  if (bytes) fs.truncateSync(file, bytes);
}
/** The hooks of the records in the segments the hook itself wrote, beside the prepared ones. */
function written(s: Sandbox): string[] {
  return fs.readdirSync(s.state.spool).filter(name => !/^seg-1\d{4}[.]jsonl$/.test(name)).sort()
    .flatMap(name => fs.readFileSync(path.join(s.state.spool, name), "utf8").split("\n").filter(Boolean).map(line => (JSON.parse(line) as CursorSpoolLine).hook));
}

test("the spool is bounded by its bytes and the fourteen days of buckets, not by 128 segments", async t => {
  assert.equal(CURSOR_HOOK_LIMITS.spoolBytes, 128 * 1024 * 1024);
  assert.ok(CURSOR_HOOK_LIMITS.segments >= 14 * 24 * 3_600_000 / CURSOR_HOOK_LIMITS.segmentMs + CURSOR_HOOK_LIMITS.spoolBytes / CURSOR_HOOK_LIMITS.segmentBytes,
    "a segment for every bucket of fourteen days, and every numbered one the byte bound allows");

  // Two weeks of small segments while the service refuses records: far more
  // than 128 files, far less than the byte bound. The event is recorded.
  const held = sandbox(t);
  for (let index = 0; index < 2016; index++) sparse(held, index, 200);
  assertSilent(await runHook(held, event("stop")));
  assert.deepEqual(written(held), ["stop"]);
  assert.equal(drops(held), 0);
  assert.match(fs.readFileSync(spoolSize(held), "utf8"), /^\d+ 2016 403200\n$/, "the sum of the settled segments is kept beside the spool");
  assert.equal(fs.statSync(spoolSize(held)).mode & 0o777, 0o600);

  // The byte bound, to the byte: the line fits exactly, then nothing more does.
  const exact = sandbox(t);
  await payloadOf(exact, event("stop"));
  const lineBytes = Buffer.byteLength(spoolText(exact));
  for (const name of fs.readdirSync(exact.state.spool)) fs.rmSync(path.join(exact.state.spool, name));
  for (let index = 0; index < 127; index++) sparse(exact, index, CURSOR_HOOK_LIMITS.segmentBytes);
  sparse(exact, 127, CURSOR_HOOK_LIMITS.segmentBytes - lineBytes);
  sparse(exact, 128, 0);
  assertSilent(await runHook(exact, event("stop")));
  assert.deepEqual(written(exact), ["stop"], "a line that fills the spool exactly is recorded");
  assert.equal(drops(exact), 0);
  assertSilent(await runHook(exact, event("stop")));
  assert.equal(drops(exact), 1, "past the byte bound the event is dropped and counted");
  assert.deepEqual(written(exact), ["stop"]);
  // A segment the collector removes makes room again.
  fs.rmSync(path.join(exact.state.spool, "seg-10000.jsonl"));
  assertSilent(await runHook(exact, event("stop")));
  assert.equal(drops(exact), 1, "the kept sum is counted again once a settled segment is gone");
  assert.deepEqual(written(exact), ["stop", "stop"]);

  // The kept sum is what an event uses: no settled segment is looked at.
  const trusted = sandbox(t);
  for (let index = 0; index < 200; index++) sparse(trusted, index, 0);
  await inOneBucket(async bucket => {
    fs.rmSync(trusted.state.dropped, { force: true });
    fs.writeFileSync(spoolSize(trusted), `${bucket} 200 ${CURSOR_HOOK_LIMITS.spoolBytes}\n`);
    assertSilent(await runHook(trusted, event("stop")));
  });
  assert.equal(drops(trusted), 1, "a sum for this bucket and this many segments is not recomputed");
  // A sum for another bucket, another count, or no sum at all is counted again.
  for (const stale of [`1 200 ${CURSOR_HOOK_LIMITS.spoolBytes}\n`, `x 200 9\n`, "", "9".repeat(200)]) {
    await inOneBucket(async bucket => {
      fs.writeFileSync(spoolSize(trusted), stale.replace(/^x/, String(bucket + 5)));
      fs.rmSync(trusted.state.dropped, { force: true });
      for (const name of fs.readdirSync(trusted.state.spool)) if (!/^seg-1\d{4}[.]jsonl$/.test(name)) fs.rmSync(path.join(trusted.state.spool, name));
      assertSilent(await runHook(trusted, event("stop")));
      assert.match(fs.readFileSync(spoolSize(trusted), "utf8"), new RegExp(`^${bucket} 200 0\\n$`));
    });
    assert.equal(drops(trusted), 0, JSON.stringify(stale.slice(0, 20)));
  }
  // A link in its place is neither read nor written through.
  const outside = path.join(trusted.root, "outside");
  fs.writeFileSync(outside, "untouched");
  fs.rmSync(spoolSize(trusted));
  fs.symlinkSync(outside, spoolSize(trusted));
  assertSilent(await runHook(trusted, event("stop")));
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  assert.equal(drops(trusted), 0);

  // The file bound still holds, and a record for a segment that exists is appended at it.
  const full = sandbox(t);
  for (let index = 0; index < CURSOR_HOOK_LIMITS.segments; index++) sparse(full, index, 0);
  assertSilent(await runHook(full, event("stop")));
  assert.equal(drops(full), 1);
  assert.equal(fs.readdirSync(full.state.spool).length, CURSOR_HOOK_LIMITS.segments, "no segment is added past the bound");
  const open = sandbox(t);
  for (let index = 0; index < CURSOR_HOOK_LIMITS.segments - 2; index++) sparse(open, index, 0);
  for (const offset of [0, 1]) fs.writeFileSync(path.join(open.state.spool, segmentName(offset)), "");
  assert.deepEqual(await payloadOf(open, event("stop")), metadataOnly("stop"));
  assert.equal(drops(open), 0);
  // A full segment cannot continue in a numbered one when that would be one file too many.
  for (const offset of [0, 1]) fs.truncateSync(path.join(open.state.spool, segmentName(offset)), CURSOR_HOOK_LIMITS.segmentBytes);
  assertSilent(await runHook(open, event("stop")));
  assert.equal(drops(open), 1);
  assert.equal(fs.readdirSync(open.state.spool).length, CURSOR_HOOK_LIMITS.segments);

  fs.writeFileSync(full.state.dropped, Buffer.alloc(CURSOR_HOOK_LIMITS.droppedBytes, 0x2e));
  assertSilent(await runHook(full, event("stop")));
  assert.equal(drops(full), CURSOR_HOOK_LIMITS.droppedBytes);
});

test("a bucket whose segment is full continues in a numbered segment, so a burst is not dropped", async t => {
  const s = sandbox(t);
  const nearlyFull = "x".repeat(CURSOR_HOOK_LIMITS.segmentBytes - 100) + "\n";
  const numbered = (offset: number, part: number) => segmentName(offset).replace(/[.]jsonl$/, `-${part}.jsonl`);
  // Both the current bucket and the next, so the bucket may change mid-test.
  for (const offset of [0, 1]) fs.writeFileSync(path.join(s.state.spool, segmentName(offset)), nearlyFull);
  assertSilent(await runHook(s, event("stop")));
  assert.equal(drops(s), 0, "a full segment no longer drops the event");
  const rolled = fs.readdirSync(s.state.spool).filter(name => /^seg-\d+-1[.]jsonl$/.test(name));
  assert.equal(rolled.length, 1);
  assert.ok([numbered(0, 1), numbered(-1, 1), numbered(1, 1)].includes(rolled[0]!));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.state.spool, rolled[0]!), "utf8")).hook, "stop");
  assert.equal(fs.statSync(path.join(s.state.spool, rolled[0]!.replace("-1.jsonl", ".jsonl"))).size, nearlyFull.length, "the full segment is not grown");
  assert.equal(fs.statSync(path.join(s.state.spool, rolled[0]!)).mode & 0o777, 0o600);

  // The newest numbered segment takes the next records; a full one is followed by the next number.
  assertSilent(await runHook(s, event("stop")));
  assert.equal(fs.readFileSync(path.join(s.state.spool, rolled[0]!), "utf8").split("\n").filter(Boolean).length, 2);
  for (const offset of [-1, 0, 1]) for (const part of [1, 2, 3]) fs.writeFileSync(path.join(s.state.spool, numbered(offset, part)), part === 3 ? nearlyFull : "");
  for (const offset of [-1, 0, 1]) fs.writeFileSync(path.join(s.state.spool, segmentName(offset)), nearlyFull);
  assertSilent(await runHook(s, event("stop")));
  assert.equal(drops(s), 0);
  const fourth = fs.readdirSync(s.state.spool).filter(name => /^seg-\d+-4[.]jsonl$/.test(name));
  assert.equal(fourth.length, 1, "the record follows the highest number, not the first segment with room");
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.state.spool, fourth[0]!), "utf8")).hook, "stop");

  // Sixty-four hooks at once over a full segment: every line whole, none lost.
  const burst = sandbox(t);
  for (const offset of [0, 1]) fs.writeFileSync(path.join(burst.state.spool, segmentName(offset)), nearlyFull);
  const outcomes = await Promise.all(Array.from({ length: 64 }, (_, index) => runHook(burst, event("stop", { conversation_id: `burst-${index}` }))));
  outcomes.forEach(outcome => assertSilent(outcome));
  assert.equal(drops(burst), 0);
  const lines = fs.readdirSync(burst.state.spool).filter(name => /^seg-\d+-\d+[.]jsonl$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(burst.state.spool, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).conversation_id));
  assert.equal(new Set(lines).size, 64);
});

test("a full disk, a short write and faults inside the process all end in exit 0 and silence", async t => {
  const fault = (s: Sandbox, name: string, source: string) => {
    const file = path.join(s.root, `${name}.cjs`);
    fs.writeFileSync(file, source);
    return file;
  };
  const disk = sandbox(t);
  assertSilent(await runHook(disk, event("stop"), { preload: fault(disk, "enospc",
    'require("fs").writeSync = function () { var e = new Error("ENOSPC: no space left on device, write"); e.code = "ENOSPC"; throw e; };') }));
  assert.equal(spoolText(disk), "");

  // Ten bytes of the record reach the disk; the hook ends the partial line so
  // that the next record starts on a line of its own.
  const short = sandbox(t);
  assertSilent(await runHook(short, event("stop"), { preload: fault(short, "short",
    'var fs = require("fs"), real = fs.writeSync, first = true; fs.writeSync = function (fd, data) { if (first && Buffer.isBuffer(data)) { first = false; return real.call(fs, fd, data, 0, 10); } return real.apply(fs, arguments); };') }));
  assert.equal(spoolText(short), '{"v":1,"id\n');
  assert.equal(drops(short), 1);
  assertSilent(await runHook(short, event("stop")));
  assert.deepEqual(JSON.parse(spoolText(short).split("\n")[1]!).payload, metadataOnly("stop"));
  const nothing = sandbox(t);
  assertSilent(await runHook(nothing, event("stop"), { preload: fault(nothing, "zero",
    'var fs = require("fs"), real = fs.writeSync, first = true; fs.writeSync = function (fd, data) { if (first && Buffer.isBuffer(data)) { first = false; return 0; } return real.apply(fs, arguments); };') }));
  assert.equal(spoolText(nothing), "", "a write that stored nothing leaves no empty line");
  assert.equal(drops(nothing), 1);

  const faults: Array<[string, string, boolean]> = [
    ["throw-later", 'setImmediate(function () { throw new Error("thrown outside the hook"); });', true],
    ["reject-later", 'Promise.reject(new Error("rejected outside the hook"));', true],
    ["parse", 'JSON.parse = function () { throw new TypeError("parse fault"); };', false],
    ["random", 'require("crypto").randomBytes = function () { throw new Error("no entropy"); };', false],
    ["stdin", 'Object.defineProperty(process, "stdin", { get: function () { throw new Error("no stdin"); } });', false],
    ["readdir", 'require("fs").readdirSync = function () { var e = new Error("EIO"); e.code = "EIO"; throw e; };', false],
    ["fstat", 'require("fs").fstatSync = function () { var e = new Error("EIO"); e.code = "EIO"; throw e; };', false],
    ["stringify", 'var real = JSON.stringify; JSON.stringify = function (value) { if (value && value.v === 1) throw new RangeError("too deep"); return real.apply(JSON, arguments); };', false],
  ];
  for (const [name, source, hold] of faults) {
    const s = sandbox(t);
    const outcome = await runHook(s, hold ? null : event("stop"), { preload: fault(s, name, source), hold });
    assertSilent(outcome, name);
    assert.ok(outcome.elapsedMs < CURSOR_HOOK_LIMITS.deadlineMs - 100, `${name} waited for the deadline`);
    assert.equal(spoolText(s), "", name);
    assert.equal(drops(s), name === "fstat" ? 0 : 1, name);
  }
});

test("fifty hook processes started at once write fifty intact lines", async t => {
  const s = sandbox(t, { prompts: true });
  const prompts = Array.from({ length: 50 }, (_, index) => String.fromCharCode(65 + (index % 26)).repeat(11000 + index));
  const outcomes = await Promise.all(prompts.map((prompt, index) =>
    runHook(s, event("beforeSubmitPrompt", { prompt, generation_id: `turn-${index}` }))));
  outcomes.forEach(outcome => assertSilent(outcome));
  const text = spoolText(s), lines = spoolLines(s);
  assert.equal(lines.length, 50);
  assert.equal(drops(s), 0);
  assert.equal(new Set(lines.map(line => line.id)).size, 50);
  assert.deepEqual(lines.map(line => Number(String(line.payload.generation_id).slice(5))).sort((a, b) => a - b), prompts.map((_, index) => index));
  for (const line of lines) {
    const index = Number(String(line.payload.generation_id).slice(5));
    assert.equal(line.payload.prompt, prompts[index], "no line holds bytes of another");
  }
  assert.equal(utf8(text), lines.reduce((sum, line) => sum + utf8(line) + 1, 0), "the segment holds the fifty lines and nothing else");
});

test("the program is ES5 CommonJS that loads only built-in file, crypto and clock modules", t => {
  const program = cursorHookProgram({ stateDir: "/srv/fixture/state", content: { prompts: true, toolDetails: true }, identity: { email: true } });
  assert.ok(program.startsWith(`"use strict";\n// ${CURSOR_FILE_MARKER}\n`));
  assert.ok(!/[^\x00-\x7f]/.test(program), "ASCII only");
  const source = ts.createSourceFile("hook.cjs", program, ts.ScriptTarget.ES5, true, ts.ScriptKind.JS);
  assert.deepEqual((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics, []);
  const newer: string[] = [], required: string[] = [], globals = new Set<string>();
  const visit = (node: ts.Node): void => {
    const kind = ts.SyntaxKind[node.kind]!;
    if (ts.isArrowFunction(node) || ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isClassLike(node) ||
      ts.isSpreadElement(node) || ts.isSpreadAssignment(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isForOfStatement(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isBigIntLiteral(node) ||
      ts.isMethodDeclaration(node) || ts.isComputedPropertyName(node) ||
      (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) !== 0) ||
      (ts.isCatchClause(node) && !node.variableDeclaration) || (ts.isParameter(node) && (!!node.initializer || !!node.dotDotDotToken)) ||
      (ts.isFunctionLike(node) && !!ts.getCombinedModifierFlags(node as ts.Declaration)) ||
      node.kind === ts.SyntaxKind.QuestionDotToken || node.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.kind === ts.SyntaxKind.AsteriskAsteriskToken || node.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) newer.push(`${kind} at ${node.pos}`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      required.push((node.arguments[0] as ts.StringLiteral).text);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) globals.add(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(newer, [], "syntax newer than ES5");
  assert.deepEqual(required.sort(), ["crypto", "fs", "perf_hooks"]);
  for (const forbidden of ["console", "child_process", "http", "https", "net", "module", "global", "globalThis"]) {
    assert.ok(!globals.has(forbidden), `the program uses ${forbidden}`);
  }
  assert.ok(!/process\.(stdout|stderr|env|argv|kill|chdir)|setInterval|\beval\b|Function\(/.test(program));
  assert.equal(program.includes("process.exit(0)"), true);
  assert.deepEqual(program.match(/process\.exit\([^)]*\)/g), ["process.exit(0)"], "the only exit status is 0");
  assert.throws(() => cursorHookProgram({ stateDir: "relative/state", content: { prompts: false, toolDetails: false }, identity: { email: false } }));
  t.diagnostic(`hook program: ${utf8(program)} bytes`);
});

test("capture options are a constant in the program, and only an exact true turns one on", () => {
  const read = (program: string) => JSON.parse(/^var POLICY = (.*);$/m.exec(program)![1]!);
  const make = (content: any, identity: any) => read(cursorHookProgram({ stateDir: "/srv/fixture/state", content, identity }));
  assert.deepEqual(make({ prompts: false, toolDetails: false }, { email: false }), { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(make({ prompts: true, toolDetails: false }, { email: true }), { prompts: true, toolDetails: false, email: true });
  assert.deepEqual(make({ prompts: "yes", toolDetails: 1 }, { email: "true" }), { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(make({}, {}), { prompts: false, toolDetails: false, email: false });
  const awkward = "/srv/it's \"here\"\\x/" + String.fromCharCode(0x2028) + "state";
  const quoted = cursorHookProgram({ stateDir: awkward, content: { prompts: false, toolDetails: false }, identity: { email: false } });
  assert.ok(!/[^\x00-\x7f]/.test(quoted));
  assert.equal(new Function(`${/^var STATE = .*;$/m.exec(quoted)![0]} return STATE;`)(), awkward);
});

test("install writes private executables once, rewrites only what changed and clears the stale-interpreter markers", t => {
  const s = sandbox(t);
  const mode = (file: string) => fs.statSync(file).mode & 0o777;
  for (const directory of [s.paths.shareDir, s.paths.stateDir, s.state.spool]) assert.equal(mode(directory), 0o700);
  for (const file of [s.paths.hook, s.paths.hookProgram]) assert.equal(mode(file), 0o700);
  assert.deepEqual(fs.readdirSync(s.paths.shareDir).sort(), ["hook.cjs", "hook.sh"]);
  assert.deepEqual(s.install(), { command: s.paths.hook, written: [] }, "an unchanged install writes nothing");

  fs.writeFileSync(s.state.nodePath, "/removed/node\n");
  fs.writeFileSync(s.state.nodeStale, "");
  fs.chmodSync(s.paths.hook, 0o644);
  fs.chmodSync(s.state.spool, 0o755);
  assert.deepEqual(s.install({ prompts: true }), { command: s.paths.hook, written: [s.paths.hookProgram, s.paths.hook] });
  assert.equal(mode(s.paths.hook), 0o700);
  assert.equal(mode(s.state.spool), 0o700);
  assert.equal(fs.existsSync(s.state.nodePath) || fs.existsSync(s.state.nodeStale), false);
  assert.match(fs.readFileSync(s.paths.hookProgram, "utf8"), /^var POLICY = \{"prompts":true,"toolDetails":false,"email":false\};$/m);
  assert.deepEqual(s.install({ prompts: true }, { execPath: "/opt/fixture/node" }).written, [s.paths.hook], "a new interpreter rewrites only the launcher");
  assert.deepEqual(fs.readdirSync(s.paths.shareDir).sort(), ["hook.cjs", "hook.sh"], "no temporary is left behind");

  const collector = installCursorCollectorLauncher({ shareDir: s.paths.shareDir, stateDir: s.paths.stateDir, node: { execPath: process.execPath },
    entry: path.join(s.paths.shareDir, "runtime-0000", "bin.js"), configPath: s.paths.config });
  assert.deepEqual(collector, { path: s.paths.collectorLauncher, written: true });
  assert.equal(mode(s.paths.collectorLauncher), 0o700);
  assert.deepEqual(removeCursorHookFiles(s.paths.shareDir), [s.paths.hook, s.paths.hookProgram]);
  assert.deepEqual(fs.readdirSync(s.paths.shareDir), ["collector.sh"]);
  assert.deepEqual(removeCursorHookFiles(s.paths.shareDir, { collector: true }), [s.paths.collectorLauncher]);
  assert.deepEqual(removeCursorHookFiles(s.paths.shareDir, { collector: true }), []);
});

test("install refuses a path a shell would split, a linked directory and a value a launcher cannot carry", t => {
  const s = sandbox(t);
  const options = { stateDir: s.paths.stateDir, node: { execPath: process.execPath }, content: { prompts: false, toolDetails: false }, identity: { email: false } };
  for (const home of ["home dir", "home$x", "it's", "semi;colon"]) {
    const shareDir = cursorPaths(path.join(s.root, home)).shareDir;
    assert.throws(() => installCursorHookFiles({ ...options, shareDir }), /no spaces/);
    assert.equal(fs.existsSync(path.join(s.root, home)), false, "nothing is created before the refusal");
  }
  const real = path.join(s.root, "real"), link = path.join(s.root, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  assert.throws(() => installCursorHookFiles({ ...options, shareDir: link }), /not a link/);
  assert.throws(() => installCursorHookFiles({ ...options, shareDir: path.join(s.root, "fresh"), stateDir: link }), /not a link/);
  assert.deepEqual(fs.readdirSync(real), []);
  for (const execPath of ["/opt/node\n/bin/node", "/opt/node\0", "/opt/node\r"]) {
    assert.throws(() => installCursorHookFiles({ ...options, shareDir: path.join(s.root, "clean"), node: { execPath } }), /line break or NUL/);
  }
  assert.equal(fs.existsSync(path.join(s.root, "clean")), false);
  fs.rmSync(s.paths.hook);
  fs.mkdirSync(s.paths.hook);
  assert.throws(() => s.install(), /is a directory/);
});

/** A stand-in interpreter: a script that runs this Node.js binary, or `body`. */
function interpreter(file: string, body = `exec '${process.execPath}' "$@"`): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test("the launcher runs the hook through the recorded interpreter and passes stdin through", async t => {
  const s = sandbox(t);
  const text = fs.readFileSync(s.paths.hook, "utf8");
  assert.ok(text.startsWith(`#!/bin/sh\n# ${CURSOR_FILE_MARKER}\n`));
  assert.ok(text.endsWith("\nexit 0\n"));
  assertSilent(await runLauncher(s, event("stop")));
  assert.deepEqual(spoolLines(s).map(line => line.payload), [metadataOnly("stop")]);
  assert.equal(fs.existsSync(s.state.nodeStale) || fs.existsSync(s.state.nodePath), false);
  // Options meant for the user's own Node.js programs must not reach the hook.
  assertSilent(await runLauncher(s, event("stop"), { NODE_OPTIONS: `--require ${path.join(s.root, "missing-preload.cjs")}` }));
  assert.equal(spoolLines(s).length, 2);
});

test("with the recorded interpreter gone the launcher uses the command path, then PATH, and records what it found", async t => {
  const s = sandbox(t), gone = path.join(s.root, "removed", "bin", "node");
  const command = interpreter(path.join(s.root, "stable", "node"));
  s.install({}, { execPath: gone, commandPath: command });
  assertSilent(await runLauncher(s, event("stop")));
  assert.equal(spoolLines(s).length, 1);
  assert.equal(fs.existsSync(s.state.nodeStale) || fs.existsSync(s.state.nodePath), false, "a working recorded path is not stale");

  const onPath = interpreter(path.join(s.root, "path bin", "node"));
  s.install({}, { execPath: gone, commandPath: path.join(s.root, "also-removed", "node") });
  assertSilent(await runLauncher(s, event("stop"), { PATH: path.dirname(onPath) }));
  assert.equal(spoolLines(s).length, 2);
  assert.equal(fs.readFileSync(s.state.nodePath, "utf8"), `${onPath}\n`);
  assert.equal(fs.readFileSync(s.state.nodeStale, "utf8"), "");
  assert.equal(fs.statSync(s.state.nodePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.state.nodeStale).mode & 0o777, 0o600);
  const written = fs.statSync(s.state.nodePath).mtimeMs;
  assertSilent(await runLauncher(s, event("stop"), { PATH: path.dirname(onPath) }));
  assert.equal(spoolLines(s).length, 3);
  assert.equal(fs.statSync(s.state.nodePath).mtimeMs, written, "an unchanged discovery is not rewritten");

  // A directory named like the interpreter is not an interpreter.
  fs.mkdirSync(gone, { recursive: true });
  assertSilent(await runLauncher(s, event("stop"), { PATH: path.dirname(onPath) }));
  assert.equal(spoolLines(s).length, 4);
});

test("the launcher exits 0 and prints nothing whatever the interpreter or the state directory does, never 2", async t => {
  const s = sandbox(t), gone = path.join(s.root, "removed", "node");
  const empty = path.join(s.root, "empty-bin");
  fs.mkdirSync(empty);
  s.install({}, { execPath: gone });
  // PATH is always given: without one a shell searches its own default, which may hold a real node.
  for (const env of [{ PATH: "" }, { PATH: empty }, { PATH: "relative-bin" }, { PATH: `${empty}:${path.join(s.root, "absent")}` }]) {
    assertSilent(await runLauncher(s, event("stop"), env), `no interpreter with ${JSON.stringify(env)}`);
  }
  assert.equal(fs.existsSync(s.state.nodeStale), false, "nothing was found, so nothing is recorded");

  for (const body of ["echo to-stdout; echo to-stderr >&2; exit 2", "exit 2", "exit 1", "kill -9 $$", "cat >/dev/null; exit 2"]) {
    s.install({}, { execPath: interpreter(path.join(s.root, "bad", "node"), body) });
    assertSilent(await runLauncher(s, event("stop")), body);
  }

  // The stale-interpreter bookkeeping writes into the state directory. With
  // that directory gone, a plain `: > file` would end a POSIX shell with status 2.
  const onPath = interpreter(path.join(s.root, "bin", "node"));
  s.install({}, { execPath: gone });
  fs.rmSync(s.paths.stateDir, { recursive: true });
  assertSilent(await runLauncher(s, event("stop"), { PATH: path.dirname(onPath) }));
  fs.writeFileSync(s.paths.stateDir, "a file where the directory was");
  assertSilent(await runLauncher(s, event("stop"), { PATH: path.dirname(onPath) }));
  fs.rmSync(s.paths.stateDir);

  // The capture options are a constant inside the program, so the only file
  // the hook could fail to read is the program itself.
  s.install({}, { execPath: process.execPath });
  if (process.getuid?.() !== 0) {
    fs.chmodSync(s.paths.hookProgram, 0o000);
    assertSilent(await runLauncher(s, event("stop")), "an unreadable program");
  }
  fs.rmSync(s.paths.hookProgram);
  fs.writeFileSync(s.paths.hookProgram, "this is not JavaScript {{{");
  assertSilent(await runLauncher(s, event("stop")), "a corrupt program");
  fs.rmSync(s.paths.hookProgram);
  assertSilent(await runLauncher(s, event("stop")), "a missing program");
  fs.writeFileSync(s.paths.hookProgram, "process.stdout.write('x'); process.stderr.write('y'); process.exit(2);");
  assertSilent(await runLauncher(s, event("stop")), "a program that prints and exits 2");
  assert.deepEqual(spoolLines(s), []);
});

test("launcher text stays valid shell for any path it is allowed to carry", async t => {
  const s = sandbox(t);
  const awkward = path.join(s.root, "it's a \"state\" $HOME `id` \\ dir");
  fs.mkdirSync(path.join(awkward, "spool"), { recursive: true });
  const gone = path.join(s.root, "node's gone", "node"), onPath = interpreter(path.join(s.root, "bin", "node"));
  const options = { stateDir: awkward, node: { execPath: gone, commandPath: `${gone} too` }, content: { prompts: false, toolDetails: false }, identity: { email: false } };
  installCursorHookFiles({ ...options, shareDir: s.paths.shareDir });
  assertSilent(await runLauncher(s, event("stop"), { PATH: path.dirname(onPath) }));
  assert.equal(fs.readFileSync(path.join(awkward, "node-path"), "utf8"), `${onPath}\n`);
  assert.equal(fs.readdirSync(path.join(awkward, "spool")).length, 1);
  assert.deepEqual(fs.readdirSync(s.root).sort(), [".local", "bin", path.basename(awkward)].sort(), "nothing was created from an expanded or split path");

  const collector = path.join(s.root, "collector.sh");
  fs.writeFileSync(collector, cursorCollectorLauncher({ stateDir: awkward, node: options.node, entry: path.join(awkward, "bin.js"),
    configPath: path.join(awkward, "config.json"), network: { httpsProxy: "http://u:p'a$s`s@proxy.example.test:8080", noProxy: "a b;c", extraCaCerts: awkward } }));
  for (const script of [s.paths.hook, collector]) assertSilent(await execute("/bin/sh", ["-n", script], null), `sh -n ${script}`);
  for (const stateDir of ["/srv/state\nrm", "/srv/state\0", "/srv/state\r"]) {
    assert.throws(() => cursorHookLauncher({ stateDir, program: "/srv/hook.cjs", node: { execPath: "/opt/node" } }), /line break or NUL/);
    assert.throws(() => cursorCollectorLauncher({ stateDir, node: { execPath: "/opt/node" }, entry: "/srv/bin.js", configPath: "/srv/c.json" }), /line break or NUL/);
  }
  for (const network of [{ httpsProxy: "http://proxy\nexport X=1" }, { noProxy: "a\0b" }, { extraCaCerts: "/srv/ca\r.pem" }]) {
    assert.throws(() => cursorCollectorLauncher({ stateDir: "/srv/state", node: { execPath: "/opt/node" }, entry: "/srv/bin.js", configPath: "/srv/c.json", network }), /line break or NUL/);
  }
  for (const retrySeconds of [0, -1, 1.5, 3601, Number.NaN]) {
    assert.throws(() => cursorCollectorLauncher({ stateDir: "/srv/state", node: { execPath: "/opt/node" }, entry: "/srv/bin.js", configPath: "/srv/c.json", retrySeconds }), /retry wait/);
  }
});

test("the collector launcher exports the recorded network settings, starts the collector, and cannot exit 2", async t => {
  const s = sandbox(t), entry = path.join(s.root, "runtime", "bin.cjs"), config = path.join(s.root, "cursor-hooks-v1.json");
  fs.mkdirSync(path.dirname(entry));
  fs.writeFileSync(entry, 'require("fs").writeFileSync(require("path").join(__dirname, "started.json"), JSON.stringify({ args: process.argv.slice(2), env: process.env }));\n');
  const network = { httpsProxy: "http://user:pa'ss@proxy.example.test:8080", noProxy: "localhost,.internal.example.test", extraCaCerts: path.join(s.root, "corp ca.pem") };
  const launch = async (node: CursorNode, settings: CursorNetwork = network) => {
    const script = path.join(s.root, "collector.sh");
    fs.writeFileSync(script, cursorCollectorLauncher({ stateDir: s.paths.stateDir, node, entry, configPath: config, network: settings, retrySeconds: 1 }));
    fs.rmSync(path.join(path.dirname(entry), "started.json"), { force: true });
    const outcome = await execute("/bin/sh", [script], null, { env: { PATH: "/usr/bin:/bin" } });
    const record = path.join(path.dirname(entry), "started.json");
    return { outcome, script, started: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : null };
  };
  fs.writeFileSync(network.extraCaCerts, "");
  const first = await launch({ execPath: process.execPath });
  assert.equal(first.outcome.code, 0);
  assert.equal(first.outcome.stdout, "");
  assert.deepEqual(first.started.args, ["cursor", "collect", "--settings", config]);
  assert.equal(first.started.env.HTTPS_PROXY, network.httpsProxy);
  assert.equal(first.started.env.NO_PROXY, network.noProxy);
  assert.equal(first.started.env.NODE_EXTRA_CA_CERTS, network.extraCaCerts);
  assert.equal(first.started.env.NODE_USE_ENV_PROXY, "1");
  const bare = await launch({ execPath: process.execPath }, {});
  for (const name of ["HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"]) assert.ok(!(name in bare.started.env), name);

  const none = await launch({ execPath: path.join(s.root, "removed", "node") });
  assert.equal(none.outcome.code, 1);
  assert.equal(none.started, null);
  assert.equal(fs.statSync(s.state.nodeStale).mode & 0o777, 0o600);
  // Whatever fails inside the script, the status it reports is not 2.
  const text = fs.readFileSync(none.script, "utf8"), lines = text.split("\n");
  assert.match(lines[3]!, /^trap /);
  fs.writeFileSync(none.script, [...lines.slice(0, 4), "exit 2", ...lines.slice(4)].join("\n"));
  assert.equal((await execute("/bin/sh", [none.script], null, { env: { PATH: "/usr/bin:/bin" } })).code, 1);
});
