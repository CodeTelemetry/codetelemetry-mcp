// Cursor onboarding, lifecycle commands and their public twins. Loaded here as
// well as by the test scripts, so this file cannot reach the real home however
// it is run. Every install below lives in a temporary home directory, every
// service-manager call goes to a recording fake, and every request goes to a
// fake fetch. As a second line of defence the first PATH entry holds stand-ins
// for the service-manager binaries that only record that they were called; the
// last test asserts that none ever was.
import "../support/isolateHome.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONNECT_VERSION, run } from "../../src/client/cli.ts";
import { onboard, type OnboardOptions } from "../../src/client/onboard.ts";
import { CLIENTS, resolveClient } from "../../src/client/clients.ts";
import { ONBOARD_CLIENTS, SESSION_FILTER_ASSISTANTS } from "../../src/client/assistants.ts";
import { CURSOR_NODE_NOTICE, checkCursorFormat, cursorNodeNotice, cursorStatus, runCursorCommand,
  type CursorCommandHost } from "../../src/client/cursor/command.ts";
import { CURSOR_PLATFORM_NOTE, CURSOR_SERVICE, CursorPreflightRefusal, cursorPreflight } from "../../src/client/cursor/preflight.ts";
import { cursorPaths, cursorStateFiles, readCursorConfig, updateCursorConfig } from "../../src/client/cursor/config.ts";
import { cursorDestinationHash, writeCursorHealth, type CursorHealth } from "../../src/client/cursor/collector.ts";
import { CURSOR_HOOK_EVENTS, CURSOR_HOOK_LIMITS } from "../../src/client/cursor/hookProgram.ts";
import { cursorHooksManualBlock } from "../../src/client/cursor/hooksFile.ts";
import { OnboardingSession } from "../../src/session.ts";
import { callTool, requestedConfigPath, TOOLS, type ToolContext } from "../../src/tools.ts";
import type { FetchLike } from "../../src/client/otlp.ts";

const KEY = "cot_" + "synthetic".repeat(4);
const INGEST = "https://ingest.example.invalid";
const FORMAT = "cursor-hooks-source-v1";
const FORMAT_HEADER = "x-codetelemetry-source-format";
const PURGE = "npx -y @codetelemetry/connect cursor uninstall --purge";
const FOREIGN_HOOKS = `{
  "version": 1,
  "hooks": {
    "stop": [
      { "command": "/opt/acme/notify-done.sh" }
    ],
    "beforeShellExecution": [
      { "command": "/opt/acme/audit.sh", "timeout": 3 }
    ]
  },
  "acmeNote": "kept as written"
}
`;
const COMMENTED_HOOKS = `{
  // team hooks, edited by hand
  "version": 1,
  "hooks": {
    "stop": [{ "command": "/opt/acme/notify-done.sh" }],
  },
}
`;

// Stand-ins for the binaries no test may reach. Each records its own name.
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-onboard-guard-"));
const guardLog = path.join(guardDir, "called");
for (const name of ["systemctl", "launchctl", "loginctl", "crontab"]) {
  fs.writeFileSync(path.join(guardDir, name), `#!/bin/sh\necho ${name} >> '${guardLog}'\nexit 97\n`, { mode: 0o755 });
}
process.env.PATH = `${guardDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.on("exit", () => fs.rmSync(guardDir, { recursive: true, force: true }));

type Format = "ok" | "unsupported-415" | "codeless-400" | "no-echo" | "coded-400" | "key-401" | "budget-402" | "network" | "server-503" | "missing-404";
type Request = { url: string; headers: Record<string, string>; body: string };

/** A fetch that answers as an ingest endpoint would. `onFormatCheck` runs
 *  while the format check is in flight. */
function ingest(format: Format = "ok", onFormatCheck: () => void = () => {}) {
  const requests: Request[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const request = { url: String(input), headers, body: String(init?.body ?? "") };
    requests.push(request);
    if (request.url !== `${INGEST}/v1/logs`) return new Response("{}", { status: 404 });
    if (headers[FORMAT_HEADER] === undefined) return new Response("{}", { status: 200 });
    if (request.body === '{"resourceLogs":[]}') onFormatCheck();
    const echo = { [FORMAT_HEADER]: FORMAT };
    switch (format) {
      case "ok": return new Response("{}", { status: 200, headers: echo });
      case "no-echo": return new Response("{}", { status: 200 });
      case "unsupported-415": return Response.json({ error: "unsupported source format", code: "source_format_unsupported" }, { status: 415 });
      case "codeless-400": return new Response("bad request", { status: 400 });
      case "coded-400": return Response.json({ error: "invalid source envelope", code: "source_envelope_invalid" }, { status: 400 });
      case "key-401": return new Response("{}", { status: 401 });
      case "budget-402": return new Response("{}", { status: 402 });
      case "server-503": return new Response("{}", { status: 503 });
      case "missing-404": return new Response("{}", { status: 404 });
      case "network": throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
  };
  return { requests, fetchImpl, formatChecks: () => requests.filter(request => request.headers[FORMAT_HEADER] !== undefined) };
}

/** Every entry under `root`: files with a digest of their bytes, links with
 *  their target, directories with a trailing slash. */
function tree(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), relative = path.relative(root, full);
      if (entry.isSymbolicLink()) found.push(`${relative} -> ${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) {
        found.push(`${relative}/`);
        visit(full);
      } else found.push(`${relative} ${createHash("sha256").update(fs.readFileSync(full)).digest("hex").slice(0, 12)}`);
    }
  };
  visit(root);
  return found.sort();
}
/** Rejects with exactly this message. */
const rejectsWith = (action: Promise<unknown>, message: RegExp): Promise<void> => assert.rejects(action, (error: Error) => {
  assert.match(error.message, message);
  return true;
});
const filesOf = (root: string): string[] => tree(root).filter(entry => !entry.endsWith("/")).map(entry => entry.split(" ")[0]!);
const mode = (file: string): number => fs.lstatSync(file).mode & 0o777;

type SandboxOptions = { platform?: NodeJS.Platform; nodeVersion?: string; prefix?: string; env?: NodeJS.ProcessEnv };

/** The mode line with both options on, and with both off. */
const MODE_ON = "Capture: prompt text, reply text and reasoning, tool commands, tool output, file paths, file content and workspace path (turn off: login --client cursor --no-enrich). Developer email: sent (turn off: login --client cursor --no-identity).";
const MODE_OFF = "Capture: metadata only (turn on prompt and reply text and tool details: login --client cursor --enrich). Developer email: not sent (turn on: login --client cursor --identity).";

function sandbox(t: TestContext, opts: SandboxOptions = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? "cursor-onboard-"));
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-onboard-fixtures-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
  });
  // A two-file stand-in for the Connect runtime the service copies.
  fs.writeFileSync(path.join(fixtures, "bin.ts"), 'import "./cli.ts";\n');
  fs.writeFileSync(path.join(fixtures, "cli.ts"), "export {};\n");
  const calls: string[] = [];
  const manager = { fails: (_line: string): boolean => false, during: (_line: string): void => {} };
  const platform = opts.platform ?? "linux";
  const host: CursorCommandHost = {
    home, platform, nodeVersion: opts.nodeVersion ?? "24.1.0", uid: 501, env: opts.env ?? {},
    node: { execPath: process.execPath }, runtimeSource: fixtures, extension: ".ts",
    execute: (command, args) => {
      const line = [command, ...args].join(" ").replaceAll(home, "<home>");
      calls.push(line);
      manager.during(line);
      if (manager.fails(line)) throw new Error(`service manager refused ${KEY}`);
      return "";
    },
  };
  const paths = cursorPaths(home);
  const unit = platform === "darwin" ? path.join(home, "Library/LaunchAgents/com.codetelemetry.cursor-hooks.plist")
    : path.join(home, ".config/systemd/user/codetelemetry-cursor-hooks.service");
  const log: string[] = [];
  const install = (extra: Partial<OnboardOptions> & { fetchImpl?: FetchLike } = {}) => {
    const { cursor, ...rest } = extra;
    return onboard({
      client: "cursor", key: KEY, endpoints: { ingestEndpoint: INGEST }, sendTest: false, verify: false, fetchImpl: ingest().fetchImpl,
      logger: line => log.push(line), ...rest, cursor: { ...cursor, host },
    });
  };
  const command = async (args: string[], flags: Record<string, string | boolean> = {}, extra: Partial<CursorCommandHost> = {}) => {
    const lines: string[] = [];
    const code = await runCursorCommand(args, flags, line => lines.push(line), { ...host, ...extra });
    return { code, lines, text: lines.join("\n") };
  };
  const writeHooks = (text: string): void => {
    fs.mkdirSync(path.dirname(paths.hooksFile), { recursive: true });
    fs.writeFileSync(paths.hooksFile, text);
  };
  const hooks = (): Record<string, Array<{ command: string; timeout?: number }>> => JSON.parse(fs.readFileSync(paths.hooksFile, "utf8")).hooks;
  return { home, fixtures, host, calls, manager, paths, unit, log, install, command, writeHooks, hooks, config: () => readCursorConfig(paths.config) };
}

const health = (extra: Partial<CursorHealth> = {}): CursorHealth => ({
  version: 1, status: "idle", lastTickAt: 0, lastOutcome: null, lastDetail: null, lastErrorClass: null, lastAckAt: null, nextAttemptAt: null,
  pendingRecords: 0, recordsSpooled: 0, recordsAcknowledged: 0, recordsMalformed: 0, recordsExpired: 0, recordsRejected: 0, recordsLost: 0,
  envelopesReframed: 0, requests: 0, requestsLastMinute: 0, rejectedBytes: 0, rejectedEnvelopes: 0, hookDrops: 0, spoolBytes: 0,
  spoolSegments: 0, backlogBytes: 0, ...extra,
});

test("the steps run in order: the format is checked before anything is written, and hooks.json is edited last", async t => {
  const s = sandbox(t);
  let atFormatCheck: string[] | null = null, atStart: string[] | null = null;
  const service = ingest("ok", () => { atFormatCheck = tree(s.home); });
  s.manager.during = line => {
    if (line.endsWith(`restart ${CURSOR_SERVICE.linuxName}`)) atStart = filesOf(s.home);
  };
  const result = await s.install({ fetchImpl: service.fetchImpl, sendTest: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.name),
    ["authenticate", "check_format", "write_config", "install_hook_program", "activate_collector", "merge_hooks", "send_test_event"]);
  assert.deepEqual(atFormatCheck, [], "nothing exists while the format check is in flight: the key is not stored yet");
  const [check, probe] = service.requests;
  assert.equal(check!.url, `${INGEST}/v1/logs`);
  assert.equal(check!.body, '{"resourceLogs":[]}');
  assert.equal(check!.headers[FORMAT_HEADER], FORMAT);
  assert.equal(check!.headers.authorization, `Bearer ${KEY}`);
  assert.match(check!.headers["x-code-telemetry-idempotency-key"]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(probe!.headers[FORMAT_HEADER], undefined, "the ordinary test event follows the install");

  // When the service starts, everything it needs exists and Cursor has no hook yet.
  assert.ok(atStart);
  const started = atStart as string[];
  for (const file of [".config/codetelemetry/cursor-hooks-v1.json", ".local/share/codetelemetry/cursor-hooks-v1/hook.sh",
    ".local/share/codetelemetry/cursor-hooks-v1/hook.cjs", ".local/share/codetelemetry/cursor-hooks-v1/collector.sh",
    ".config/systemd/user/codetelemetry-cursor-hooks.service"]) assert.ok(started.includes(file), `${file} exists before the service starts`);
  assert.ok(!started.includes(".cursor/hooks.json"), "hooks never exist without a collector");
  assert.deepEqual(s.calls, [
    "systemctl --user show-environment",
    "systemctl --user daemon-reload",
    `systemctl --user enable ${CURSOR_SERVICE.linuxName}`,
    `systemctl --user restart ${CURSOR_SERVICE.linuxName}`,
  ]);

  const unit = fs.readFileSync(s.unit, "utf8");
  assert.match(unit, /^# CodeTelemetry Cursor hooks collector v1\n/);
  assert.ok(unit.includes(`ExecStart="/bin/sh" "${s.paths.collectorLauncher}"\n`));
  assert.ok(!/node/i.test(unit.replaceAll(s.home, "")), "the unit names no Node.js binary");
  const launcher = fs.readFileSync(s.paths.collectorLauncher, "utf8");
  assert.match(launcher, new RegExp(`runtime-[a-f0-9]{16}/bin\\.ts' cursor collect --settings '${s.paths.config}'`));
  assert.deepEqual(Object.keys(s.hooks()).sort(), [...CURSOR_HOOK_EVENTS].sort());
  for (const event of CURSOR_HOOK_EVENTS) assert.deepEqual(s.hooks()[event], [{ command: event === "beforeReadFile" ? s.paths.readHook : s.paths.hook, timeout: 5 }]);
  assert.equal(mode(s.paths.readHook), 0o700);
  assert.ok(!fs.readFileSync(s.paths.hooksFile, "utf8").includes("failClosed"));

  const config = s.config();
  assert.deepEqual([config.enabled, config.content, config.identity, config.createdByConnect],
    [true, { prompts: true, toolDetails: true }, { email: true }, true]);
  assert.deepEqual([mode(s.paths.config), mode(s.paths.hook), mode(s.paths.hookProgram), mode(s.paths.collectorLauncher), mode(s.unit),
    mode(s.paths.shareDir), mode(s.paths.stateDir)], [0o600, 0o700, 0o700, 0o700, 0o600, 0o700, 0o700]);
  assert.ok(!fs.existsSync(path.join(s.paths.shareDir, "collector.lock")), "the install lock is released");

  // What was installed, where, the capture mode and how to remove it.
  const printed = s.log.join("\n");
  assert.match(printed, /Installed for Cursor:/);
  for (const location of [s.paths.config, s.paths.shareDir, s.paths.stateDir, s.unit, s.paths.hooksFile]) assert.ok(printed.includes(`  ${location}  `), location);
  assert.ok(s.log.includes(MODE_ON), "a new install prints what it sends and how to turn each off");
  assert.ok(printed.includes(CURSOR_PLATFORM_NOTE));
  assert.ok(printed.includes(`Remove everything, including the stored key and unsent records: ${PURGE}`));
  assert.match(printed, /Headless runs \(cursor-agent -p\) report tools, their output and durations, but no prompts, no replies and no tokens\./);
  assert.match(printed, /Remote-SSH, WSL or a Dev Container/);
  assert.deepEqual(result.cursor, {
    installed: result.cursor!.installed, hooks: "installed", service: "started", capture: MODE_ON, advice: [],
  });
  assert.deepEqual(result.cursor!.installed.map(item => item.path), [s.paths.config, s.paths.shareDir, s.paths.stateDir, s.unit, s.paths.hooksFile]);
  for (const text of [JSON.stringify(result), printed, s.calls.join("\n"), unit, launcher, fs.readFileSync(s.paths.hookProgram, "utf8")]) {
    assert.ok(!text.includes(KEY), "the key is stored in the settings file only");
  }
});

test("every machine refusal comes before a key is requested and writes nothing", async t => {
  const cases: Array<{ name: string; reason: string; message: RegExp; opts?: SandboxOptions; prepare?: (s: ReturnType<typeof sandbox>) => void;
    extra?: Partial<OnboardOptions>; argv?: string[] }> = [
    { name: "Windows", reason: "platform", message: /^Cursor collection supports Linux and macOS\. Nothing was installed\.$/, opts: { platform: "win32" } },
    { name: "an unknown platform", reason: "platform", message: /supports Linux and macOS/, opts: { platform: "freebsd" } },
    { name: "Node.js 22", reason: "node", message: /requires Node\.js 24 or newer; this is Node\.js 22\.21\.0\. Nothing was installed\.$/, opts: { nodeVersion: "22.21.0" } },
    { name: "no service manager", reason: "service_manager", message: /No per-user service manager is available[^]*login --client cursor --hooks-only[^]*\/bin\/sh [^\n]*collector\.sh[^]*Nothing was installed\.$/,
      prepare: s => { s.manager.fails = line => line.endsWith("show-environment"); } },
    { name: "a home directory with a space", reason: "path", message: /through a shell without quoting[^]*no spaces[^]*Nothing was installed\.$/, opts: { prefix: "cursor onboard " } },
    { name: "a symbolic link at hooks.json", reason: "hooks_file", message: /symbolic link[^]*--hooks-manual[^]*Nothing was installed\.$/,
      prepare: s => {
        fs.mkdirSync(path.dirname(s.paths.hooksFile), { recursive: true });
        fs.writeFileSync(path.join(s.fixtures, "dotfiles-hooks.json"), FOREIGN_HOOKS);
        fs.symlinkSync(path.join(s.fixtures, "dotfiles-hooks.json"), s.paths.hooksFile);
      } },
    { name: "comments and trailing commas in hooks.json", reason: "hooks_file", message: /comments[^]*--hooks-manual[^]*Nothing was installed\.$/, prepare: s => s.writeHooks(COMMENTED_HOOKS) },
    { name: "a hooks.json of another version", reason: "hooks_file", message: /Nothing was installed\.$/, prepare: s => s.writeHooks('{"version":2,"hooks":{}}') },
    { name: "project scope", reason: "project_scope", message: /per user; project scope is not supported\. Nothing was installed\.$/, extra: { settings: { scope: "project" } }, argv: ["--scope", "project"] },
    { name: "a service definition that is not ours", reason: "service_unit", message: /was not written by CodeTelemetry[^]*Nothing was installed\.$/,
      prepare: s => {
        fs.mkdirSync(path.dirname(s.unit), { recursive: true });
        fs.writeFileSync(s.unit, "[Unit]\nDescription=someone else's unit\n");
      } },
    { name: "settings that cannot be read", reason: "config", message: /cannot be used[^]*Nothing was installed\.$/,
      prepare: s => {
        fs.mkdirSync(path.dirname(s.paths.config), { recursive: true });
        fs.writeFileSync(s.paths.config, "{not json");
      } },
    { name: "a plain-http ingest endpoint", reason: "endpoint", message: /only to an https ingest endpoint[^]*Nothing was installed\.$/,
      extra: { endpoints: { ingestEndpoint: "http://ingest.example.invalid" } }, argv: ["--endpoint", "http://ingest.example.invalid"] },
    { name: "a proxy value that a launcher cannot carry", reason: "network", message: /HTTPS_PROXY contains a line break[^]*Nothing was installed\.$/,
      opts: { env: { HTTPS_PROXY: "http://proxy.example.invalid:3128\nexport X=1" } } },
    { name: "a state directory that is a link", reason: "path", message: /must be a directory, not a link[^]*Nothing was installed\.$/,
      prepare: s => {
        fs.mkdirSync(path.dirname(s.paths.stateDir), { recursive: true });
        fs.symlinkSync(s.fixtures, s.paths.stateDir);
      } },
  ];
  for (const item of cases) {
    const s = sandbox(t, item.opts);
    item.prepare?.(s);
    const before = tree(s.home), service = ingest();
    let requested = false;
    const refusal = await onboard({
      client: "cursor", endpoints: { ingestEndpoint: INGEST }, fetchImpl: service.fetchImpl, ...item.extra, cursor: { host: s.host },
      getKey: async () => { requested = true; throw new Error("a key must not be requested"); },
    }).then(() => null, error => error);
    assert.ok(refusal instanceof CursorPreflightRefusal, `${item.name}: ${String(refusal)}`);
    assert.equal(refusal.reason, item.reason, item.name);
    assert.match(refusal.message, item.message, item.name);
    assert.equal(requested, false, `${item.name}: no key was requested`);
    assert.deepEqual(service.requests, [], `${item.name}: no request was made`);
    assert.deepEqual(tree(s.home), before, `${item.name}: nothing was written`);

    // The same through the command line: no device code is requested either.
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
    let code: number;
    try {
      code = await run(["login", "--client", "cursor", "--no-open", "--endpoint", INGEST, "--api-base", "http://127.0.0.1:1", ...(item.argv ?? [])],
        { cursor: s.host, fetchImpl: service.fetchImpl });
    } finally {
      process.stdout.write = write;
    }
    assert.equal(code, 1, item.name);
    assert.match(lines.join("").trimEnd(), item.message, `${item.name}: the command prints the reason`);
    assert.deepEqual(service.requests, [], `${item.name}: no device code was requested`);
    assert.deepEqual(tree(s.home), before, `${item.name}: the command wrote nothing`);
  }

  // The paste block names the eight events and the exact command of each.
  const s = sandbox(t);
  s.writeHooks(COMMENTED_HOOKS);
  const refusal = await s.install().then(() => null, error => error);
  assert.ok(refusal.message.includes(cursorHooksManualBlock(s.paths.hook)));
  for (const event of CURSOR_HOOK_EVENTS) assert.ok(refusal.message.includes(`"${event}"`));
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), COMMENTED_HOOKS);
});

test("a service that does not serve the format installs nothing; a refused key installs nothing; no credit and no response continue", async t => {
  for (const [format, message] of [
    ["unsupported-415", /^The service does not accept Cursor records yet\. Nothing was installed\.$/],
    ["codeless-400", /^The service does not accept Cursor records yet\. Nothing was installed\.$/],
    ["no-echo", /^The service does not accept Cursor records yet\. Nothing was installed\.$/],
    ["key-401", /^The ingest key was refused \(HTTP 401\)\. Nothing was installed\.$/],
    ["missing-404", /^The ingest endpoint refused the Cursor format check \(HTTP 404\)\. Nothing was installed\.$/],
  ] as const) {
    const s = sandbox(t), service = ingest(format);
    await rejectsWith(s.install({ fetchImpl: service.fetchImpl }), message);
    assert.deepEqual(tree(s.home), [], `${format}: the key was not stored and nothing was installed`);
    assert.deepEqual(s.calls, ["systemctl --user show-environment"], `${format}: the service manager was only asked whether it is there`);
    assert.equal(service.formatChecks().length, 1);
  }
  for (const [format, detail] of [
    ["budget-402", /Could not confirm[^]*out of credit/],
    ["network", /Could not confirm[^]*could not be reached \(connect\)/],
    ["server-503", /Could not confirm[^]*asked to retry \(HTTP 503\)/],
    ["coded-400", /^The service accepts Cursor records\.$/],
  ] as const) {
    const s = sandbox(t), result = await s.install({ fetchImpl: ingest(format).fetchImpl });
    assert.equal(result.ok, true, format);
    assert.match(result.steps.find(step => step.name === "check_format")!.detail, detail, format);
    assert.equal(s.config().enabled, true);
  }
  // A key from the device flow is checked the same way, and is not stored when the answer is no.
  const approved = sandbox(t), refusing = ingest("unsupported-415");
  let approvals = 0;
  await rejectsWith(onboard({
    client: "cursor", endpoints: { ingestEndpoint: INGEST }, fetchImpl: refusing.fetchImpl, cursor: { host: approved.host },
    getKey: async () => { approvals++; return { apiKey: KEY }; },
  }), /^The service does not accept Cursor records yet\. Nothing was installed\.$/);
  assert.deepEqual([approvals, refusing.formatChecks().length, tree(approved.home)], [1, 1, []]);
  // An ingest endpoint issued with the key must be https as well.
  await rejectsWith(onboard({
    client: "cursor", fetchImpl: ingest().fetchImpl, cursor: { host: approved.host },
    getKey: async () => ({ apiKey: KEY, ingestEndpoint: "http://ingest.example.invalid" }),
  }), /^The format check could not be made \(invalid Cursor ingest endpoint\)\. Nothing was installed\.$/);
  assert.deepEqual(tree(approved.home), []);

  assert.deepEqual(await checkCursorFormat({ key: KEY, ingestEndpoint: INGEST, fetchImpl: ingest("ok").fetchImpl }),
    { state: "supported", detail: "The service accepts Cursor records.", httpStatus: 200 });
  assert.equal((await checkCursorFormat({ key: KEY, ingestEndpoint: INGEST, fetchImpl: ingest("unsupported-415").fetchImpl })).state, "unsupported");
  await assert.rejects(checkCursorFormat({ key: KEY, ingestEndpoint: "http://ingest.example.invalid", fetchImpl: ingest().fetchImpl }), /invalid Cursor ingest endpoint/);
});

test("an install that fails midway leaves nothing behind, and a failed reinstall puts the previous one back", async t => {
  // First install: the service manager refuses to start the collector.
  const first = sandbox(t);
  first.manager.fails = line => line.includes(" restart ");
  await rejectsWith(first.install(), /^The systemd service manager did not start the Cursor collector\.\n(?![^]*cot_)[^]*--hooks-only[^]*\nNothing was installed\.$/);
  assert.deepEqual(tree(first.home), [], "no file and no directory is left");
  assert.deepEqual(first.calls.slice(-2), [`systemctl --user disable --now ${CURSOR_SERVICE.linuxName}`, "systemctl --user daemon-reload"]);

  // First install: hooks.json changes after the preflight, so the merge is refused once the service runs.
  const second = sandbox(t);
  second.manager.during = line => {
    if (line.includes(" restart ")) second.writeHooks(COMMENTED_HOOKS);
  };
  await assert.rejects(second.install(), /comments[^]*\nNothing was installed\.$/);
  assert.deepEqual(filesOf(second.home), [".cursor/hooks.json"]);
  assert.equal(fs.readFileSync(second.paths.hooksFile, "utf8"), COMMENTED_HOOKS);
  assert.ok(second.calls.includes(`systemctl --user disable --now ${CURSOR_SERVICE.linuxName}`), "the started service was stopped again");

  // Another Connect command holds the install lock: nothing is touched.
  const locked = sandbox(t);
  fs.mkdirSync(locked.paths.shareDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(locked.paths.shareDir, "collector.lock"), JSON.stringify({ version: 1, pid: process.pid, token: "held-by-this-test" }));
  const held = tree(locked.home);
  await rejectsWith(locked.install(), /^Another codetelemetry-connect command is changing the Cursor installation\. Nothing was changed; run the command again when it has finished\.$/);
  assert.deepEqual(tree(locked.home), held);

  // Reinstall: every file of the working installation comes back as it was.
  const third = sandbox(t);
  third.writeHooks(FOREIGN_HOOKS);
  await third.install({ settings: { enrich: false }, cursor: { identity: false } });
  const working = tree(third.home);
  third.manager.fails = line => line.includes(" restart ") && third.calls.filter(call => call.includes(" restart ")).length === 2;
  await assert.rejects(third.install({ settings: { enrich: true }, cursor: { identity: true } }),
    /did not start the Cursor collector[^]*\nThe previous installation was put back\.$/);
  assert.deepEqual(tree(third.home), working);
  assert.deepEqual([third.config().content, third.config().identity], [{ prompts: false, toolDetails: false }, { email: false }]);
  assert.equal(third.calls.filter(call => call.includes(" restart ")).length, 3, "the restored service was started again");
  third.manager.fails = () => false;
  assert.equal((await third.install({ settings: { enrich: true } })).ok, true, "the next attempt succeeds");
});

test("--hooks-only installs no service, and --hooks-manual leaves hooks.json to the user", async t => {
  const only = sandbox(t);
  only.manager.fails = () => true;
  const result = await only.install({ cursor: { hooksOnly: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(only.calls, [], "the service manager is not even asked");
  assert.ok(!fs.existsSync(only.unit));
  assert.ok(fs.existsSync(only.paths.collectorLauncher) && fs.existsSync(only.paths.hook));
  assert.equal(result.cursor!.service, "not_installed");
  assert.deepEqual(result.cursor!.advice, [`No service runs the collector (--hooks-only). Start it under your own supervisor, or in a terminal that stays open: /bin/sh ${only.paths.collectorLauncher}`]);
  assert.ok(only.log.includes(result.cursor!.advice[0]!));
  assert.equal(Object.keys(only.hooks()).length, 8);
  assert.ok(fs.existsSync(only.paths.readHook), "the launcher of the file-read hook is installed with the other");
  const status = (await cursorStatus(only.paths.config, only.host))!;
  assert.deepEqual([status.service, status.running, status.hooks], ["not_installed", false, "installed"]);
  assert.ok(status.notices.some(notice => notice.includes(`/bin/sh ${only.paths.collectorLauncher}`)));

  const manual = sandbox(t);
  manual.writeHooks(COMMENTED_HOOKS);
  const pasted = await manual.install({ cursor: { hooksManual: true } });
  assert.equal(pasted.ok, true);
  assert.equal(fs.readFileSync(manual.paths.hooksFile, "utf8"), COMMENTED_HOOKS, "the file is not edited");
  assert.ok(!fs.existsSync(manual.paths.hooksBackup));
  assert.equal(pasted.cursor!.hooks, "missing");
  assert.equal(manual.config().createdByConnect, false);
  assert.ok(pasted.cursor!.advice[0]!.includes(cursorHooksManualBlock(manual.paths.hook)));
  assert.match(pasted.cursor!.advice[0]!, /holds none of the eight CodeTelemetry entries/);
  assert.ok(!pasted.cursor!.installed.some(item => item.path === manual.paths.hooksFile), "nothing in hooks.json is claimed as installed");
  assert.ok(fs.existsSync(manual.unit), "everything except the edit is installed");
  // The user pastes the block into the commented file: status reads it as Cursor would.
  manual.writeHooks(`{\n  // pasted by hand\n  "version": 1,\n  ${cursorHooksManualBlock(manual.paths.hook)},\n}\n`);
  assert.equal((await cursorStatus(manual.paths.config, manual.host))!.hooks, "installed");
  const again = await manual.install({ cursor: { hooksManual: true, hooksOnly: true } });
  assert.deepEqual(again.cursor!.advice, [
    `--hooks-only installed no service. The collector service from an earlier login (${manual.unit}) was left as it is.`,
    `hooks.json was not edited (--hooks-manual). ${manual.paths.hooksFile} already holds all eight CodeTelemetry entries.`,
  ]);
  assert.deepEqual(again.cursor!.installed.map(item => item.path), [manual.paths.config, manual.paths.shareDir, manual.paths.stateDir, manual.unit, manual.paths.hooksFile]);
  // Uninstall cannot edit that file. It says so, and removes the hook program so the entries do nothing.
  const removed = await manual.command(["uninstall"]);
  assert.equal(removed.code, 0);
  assert.match(removed.text, /was not changed[^]*by hand[^]*those entries now do nothing/);
  assert.ok(!fs.existsSync(manual.paths.hook) && !fs.existsSync(manual.paths.hookProgram));
  assert.match(fs.readFileSync(manual.paths.hooksFile, "utf8"), /pasted by hand/);
});

test("capture options are three-state: a flag turns one on or off, no flag keeps it, and the mode is printed every time", async t => {
  const s = sandbox(t);
  const modeLine = () => s.log.filter(line => line.startsWith("Capture: ")).at(-1);
  const program = () => fs.readFileSync(s.paths.hookProgram, "utf8");
  const stored = () => [s.config().content, s.config().identity];
  const ON = { prompts: true, toolDetails: true }, OFF = { prompts: false, toolDetails: false };

  await s.install();
  const everything = program();
  assert.deepEqual(stored(), [ON, { email: true }], "a new install has both options on");
  assert.equal(modeLine(), MODE_ON);

  await s.install();
  assert.deepEqual(stored(), [ON, { email: true }], "no flag keeps the stored choice");
  assert.equal(program(), everything);
  assert.ok(!s.log.some(line => line.startsWith("Records captured earlier")));

  await s.install({ settings: { enrich: false } });
  assert.deepEqual(stored(), [OFF, { email: true }]);
  assert.notEqual(program(), everything, "the hook program carries the choice");
  assert.equal(modeLine(), "Capture: metadata only (turn on prompt and reply text and tool details: login --client cursor --enrich). Developer email: sent (turn off: login --client cursor --no-identity).");
  assert.ok(s.log.includes("Records captured earlier and not yet sent are reduced to the new setting before they are sent."));

  await s.install({ cursor: { identity: false } });
  const metadataOnly = program();
  assert.deepEqual(stored(), [OFF, { email: false }]);
  assert.equal(modeLine(), MODE_OFF);

  await s.install();
  assert.deepEqual(stored(), [OFF, { email: false }], "a stored off stays off without a flag");
  assert.equal(program(), metadataOnly);
  assert.equal(modeLine(), MODE_OFF, "and the line names the flag that turns each on");

  await s.install({ settings: { enrich: true } });
  assert.deepEqual(stored(), [ON, { email: false }]);
  assert.equal(modeLine(), "Capture: prompt text, reply text and reasoning, tool commands, tool output, file paths, file content and workspace path (turn off: login --client cursor --no-enrich). Developer email: not sent (turn on: login --client cursor --identity).");

  await s.install({ cursor: { identity: true } });
  assert.equal(program(), everything, "turning both on restores the first program");
  assert.equal(modeLine(), MODE_ON);
  assert.equal(s.calls.filter(call => call.includes(" restart ")).length, 7, "every login restarts the collector with the new settings");

  // The same through the command line, where an absent flag must not read as "off".
  const silently = async (argv: string[]) => {
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = () => true;
    try {
      return await run(argv, { cursor: s.host, fetchImpl: ingest().fetchImpl });
    } finally {
      process.stdout.write = write;
    }
  };
  const quiet = (argv: string[]) => silently([KEY, "--client", "cursor", "--endpoint", INGEST, "--no-test", ...argv]);
  const choices = () => [s.config().content.prompts, s.config().content.toolDetails, s.config().identity.email];
  assert.equal(await quiet(["--no-enrich"]), 0);
  assert.deepEqual(choices(), [false, false, true]);
  assert.equal(await quiet(["--no-identity"]), 0);
  assert.deepEqual(choices(), [false, false, false]);
  assert.equal(await quiet([]), 0);
  assert.deepEqual(choices(), [false, false, false], "no flag keeps a stored off");
  assert.equal(await quiet(["--enrich", "--identity"]), 0);
  assert.deepEqual(choices(), [true, true, true]);
  assert.equal(await quiet([]), 0);
  assert.deepEqual(choices(), [true, true, true], "no flag keeps a stored on");
  assert.equal(await quiet(["--no-enrich", "--no-identity"]), 0);
  assert.deepEqual(choices(), [false, false, false]);
  for (const bad of [["--enrich", "yes"], ["--identity=1"], ["--hooks-only", "now"], ["--proxy-settings"], ["--hooks-manual=1"]]) assert.equal(await quiet(bad), 1, bad.join(" "));
  for (const flag of ["--identity", "--hooks-only", "--hooks-manual", "--no-proxy-settings"]) {
    assert.equal(await silently([KEY, "--client", "kiro", flag]), 1, `${flag} is refused for another client`);
  }
  assert.deepEqual(choices(), [false, false, false]);

  // A first install from the command line with no flag has both on; each --no- flag turns one off.
  for (const [flags, expected] of [[[], [true, true, true]], [["--no-enrich"], [false, false, true]], [["--no-identity"], [true, true, false]]] as const) {
    const fresh = sandbox(t);
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = () => true;
    try {
      assert.equal(await run([KEY, "--client", "cursor", "--endpoint", INGEST, "--no-test", ...flags], { cursor: fresh.host, fetchImpl: ingest().fetchImpl }), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual([fresh.config().content.prompts, fresh.config().content.toolDetails, fresh.config().identity.email], expected, flags.join(" ") || "no flag");
  }
});

test("without a service, turning capture off removes what the old setting had left in refused batches", async t => {
  const s = sandbox(t);
  await s.install({ settings: { enrich: true }, cursor: { hooksOnly: true } });
  const config = s.config(), rejected = cursorStateFiles(config.stateDir).rejected;
  const body = '{"resourceLogs":[]}', id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  fs.mkdirSync(rejected, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rejected, `${id}.json`), JSON.stringify({
    version: 1, id, body, digest: createHash("sha256").update(body).digest("hex"), records: 3, destinationHash: cursorDestinationHash(config),
    policy: { prompts: true, toolDetails: true, email: false }, createdAt: 1, rejectedAt: 2,
  }), { mode: 0o600 });

  await s.install({ cursor: { hooksOnly: true } });
  assert.deepEqual(fs.readdirSync(rejected), [`${id}.json`], "the same setting keeps it");
  await s.install({ settings: { enrich: false }, cursor: { hooksOnly: true } });
  assert.deepEqual(fs.readdirSync(rejected), [], "the batch framed with prompt text is gone");
  assert.equal(JSON.parse(fs.readFileSync(cursorStateFiles(config.stateDir).checkpoint, "utf8")).totals.lost, 3, "and counted");
  assert.ok(!fs.existsSync(cursorStateFiles(config.stateDir).lock));
});

test("proxy and CA settings are recorded for the collector, shown masked, kept across logins and cleared on request", async t => {
  const env = { HTTPS_PROXY: "http://builder:s3cret-pass@proxy.example.invalid:3128", NO_PROXY: "localhost,.internal.example", NODE_EXTRA_CA_CERTS: "/etc/ssl/corp's ca.pem" };
  const s = sandbox(t, { env });
  const plan = cursorPreflight({ host: s.host });
  assert.equal(plan.notices.length, 1);
  assert.match(plan.notices[0]!, /NODE_USE_ENV_PROXY=1/);
  assert.ok(!plan.notices[0]!.includes("s3cret-pass"));
  assert.deepEqual(cursorPreflight({ host: { ...s.host, env: { ...env, NODE_USE_ENV_PROXY: "1" } } }).notices, []);

  await s.install();
  assert.deepEqual(s.config().network, { httpsProxy: env.HTTPS_PROXY, noProxy: env.NO_PROXY, extraCaCerts: env.NODE_EXTRA_CA_CERTS });
  const launcher = fs.readFileSync(s.paths.collectorLauncher, "utf8");
  assert.ok(launcher.includes(`export HTTPS_PROXY='${env.HTTPS_PROXY}'\n`));
  assert.ok(launcher.includes("export NODE_EXTRA_CA_CERTS='/etc/ssl/corp'\\''s ca.pem'\n"));
  assert.ok(launcher.includes("export NODE_USE_ENV_PROXY=1\n"));
  assert.ok(launcher.indexOf("\nunset HTTPS_PROXY https_proxy ") > 0 && launcher.indexOf("\nunset ") < launcher.indexOf("\nexport "),
    "inherited proxy variables are cleared before the recorded ones are exported");
  assert.equal(mode(s.paths.collectorLauncher), 0o700);
  const status = await s.command(["status"], { json: true });
  assert.equal(JSON.parse(status.text).proxy, "proxy.example.invalid:3128");
  const human = await s.command(["status"]);
  assert.match(human.text, /^Proxy: proxy\.example\.invalid:3128$/m);
  for (const text of [status.text, human.text, s.log.join("\n")]) assert.ok(!text.includes("s3cret-pass") && !text.includes("builder"));

  // A later login from a shell without the variables keeps them.
  s.host.env = {};
  await s.install();
  assert.equal(s.config().network.httpsProxy, env.HTTPS_PROXY);
  await s.install({ cursor: { clearNetwork: true } });
  assert.deepEqual(s.config().network, {});
  const cleared = fs.readFileSync(s.paths.collectorLauncher, "utf8");
  assert.ok(!cleared.includes("export "), "nothing is exported once the settings are forgotten");
  assert.ok(cleared.includes("\nunset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy NODE_USE_ENV_PROXY\n"),
    "and a proxy variable the service manager passes on is still not used");
});

test("disable stops spooling and the service, enable brings both back, and each keeps foreign hooks", async t => {
  const s = sandbox(t);
  s.writeHooks(FOREIGN_HOOKS);
  const result = await s.install();
  assert.equal(result.steps.find(step => step.name === "merge_hooks")!.detail,
    `Added the eight CodeTelemetry hook entries to ${s.paths.hooksFile}; your other hooks are kept (copy of your file: ${s.paths.hooksBackup})`);
  assert.equal(fs.readFileSync(s.paths.hooksBackup, "utf8"), FOREIGN_HOOKS);
  assert.equal(s.config().createdByConnect, false);
  assert.deepEqual(s.hooks().stop, [{ command: "/opt/acme/notify-done.sh" }, { command: s.paths.hook, timeout: 5 }]);

  s.calls.length = 0;
  const disabled = await s.command(["disable"]);
  assert.equal(disabled.code, 0);
  assert.match(disabled.lines[0]!, /^Cursor collection disabled\. Records already captured stay in /);
  assert.equal(s.config().enabled, false);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), FOREIGN_HOOKS, "the user's file is byte-identical again");
  assert.deepEqual(s.calls, [`systemctl --user disable --now ${CURSOR_SERVICE.linuxName}`]);
  assert.ok(fs.existsSync(s.paths.hook) && fs.existsSync(s.unit), "the hook program and the service definition stay");
  const off = (await cursorStatus(s.paths.config, s.host))!;
  assert.deepEqual([off.enabled, off.hooks], [false, "missing"]);
  assert.ok(off.notices[0]!.startsWith("Collection is disabled."));
  assert.equal(off.notices.length, 1, "a disabled installation raises no other notice");

  // A disabled collector exits 0, so a service that restarts on failure stays stopped.
  const idle = await s.command(["collect"], {}, { fetchImpl: () => { throw new Error("no request while disabled"); } });
  assert.deepEqual([idle.code, idle.lines.length], [0, 1]);
  assert.match(idle.text, /^Cursor collection is disabled\./);

  s.calls.length = 0;
  const enabled = await s.command(["enable"]);
  assert.equal(enabled.code, 0);
  assert.equal(enabled.text, `Cursor collection enabled. ${MODE_ON}`);
  assert.equal(s.config().enabled, true);
  assert.deepEqual(s.hooks().stop, [{ command: "/opt/acme/notify-done.sh" }, { command: s.paths.hook, timeout: 5 }]);
  assert.deepEqual(s.calls, ["systemctl --user show-environment", "systemctl --user daemon-reload",
    `systemctl --user enable ${CURSOR_SERVICE.linuxName}`, `systemctl --user restart ${CURSOR_SERVICE.linuxName}`]);
  assert.ok(!fs.existsSync(`${s.paths.config}.previous`), "enable makes no settings backup");

  // enable refuses what login would refuse, and changes nothing.
  s.manager.fails = line => line.endsWith("show-environment");
  const before = tree(s.home);
  const refused = await s.command(["enable"]);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /No per-user service manager[^]*Nothing was changed\.$/);
  assert.deepEqual(tree(s.home), before);
  assert.equal((await s.command(["enable"], { "hooks-only": true })).code, 0);

  const fresh = sandbox(t);
  for (const operation of ["enable", "disable", "status", "retry-rejected"]) {
    const missing = await fresh.command([operation]);
    assert.equal(missing.code, 1, operation);
    assert.match(missing.text, /not set up on this machine\. Run: npx -y @codetelemetry\/connect login --client cursor$/);
  }
  assert.deepEqual(tree(fresh.home), []);
});

test("a hooks.json with an empty list survives login, a second login, disable, enable and uninstall byte for byte", async t => {
  const s = sandbox(t);
  const text = '{\n  "version": 1,\n  "hooks": {\n    "postToolUse": [],\n    "stop": [\n      { "command": "/opt/acme/notify-done.sh" }\n    ]\n  }\n}\n';
  const created = CURSOR_HOOK_EVENTS.filter(event => event !== "postToolUse" && event !== "stop");
  s.writeHooks(text);
  await s.install();
  assert.deepEqual(s.config().createdHookKeys, created, "the settings record which keys Connect added");
  assert.deepEqual(s.hooks().postToolUse, [{ command: s.paths.hook, timeout: 5 }]);
  const installed = fs.readFileSync(s.paths.hooksFile, "utf8"), stat = fs.statSync(s.paths.hooksFile);
  const again = await s.install();
  assert.equal(again.steps.find(step => step.name === "merge_hooks")!.detail, `${s.paths.hooksFile} already holds the eight CodeTelemetry hook entries`);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), installed);
  assert.deepEqual([fs.statSync(s.paths.hooksFile).ino, fs.statSync(s.paths.hooksFile).mtimeMs], [stat.ino, stat.mtimeMs], "the second login does not write the file");
  assert.deepEqual(s.config().createdHookKeys, created);
  assert.equal((await s.command(["disable"])).code, 0);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), text, "disable puts the empty list back");
  assert.equal((await s.command(["enable"])).code, 0);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), installed);
  assert.deepEqual(s.config().createdHookKeys, created);
  assert.equal((await s.command(["uninstall"])).code, 0);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), text, "uninstall restores the user's file, the empty list included");

  // Settings written before the record existed are still read, and a bad record is refused.
  const stored = JSON.parse(fs.readFileSync(s.paths.config, "utf8"));
  delete stored.createdHookKeys;
  fs.writeFileSync(s.paths.config, JSON.stringify(stored));
  assert.equal("createdHookKeys" in s.config(), false);
  for (const bad of ["stop", ["stop", 7], ["not a key!"], Array.from({ length: 17 }, () => "stop")]) {
    fs.writeFileSync(s.paths.config, JSON.stringify({ ...stored, createdHookKeys: bad }));
    assert.throws(() => s.config(), /invalid Cursor collector config fields/);
  }
});

test("uninstall prints every path it leaves, and --purge leaves none while a foreign hook entry survives", async t => {
  const s = sandbox(t);
  s.writeHooks(FOREIGN_HOOKS);
  await s.install({ settings: { enrich: true } });
  await s.install();
  const state = cursorStateFiles(s.config().stateDir);
  fs.writeFileSync(path.join(state.spool, "seg-1.jsonl"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(state.pending, "{}", { mode: 0o600 });
  fs.writeFileSync(state.checkpoint, "{}", { mode: 0o600 });
  fs.writeFileSync(state.health, "{}", { mode: 0o600 });
  fs.mkdirSync(state.rejected, { recursive: true });
  fs.writeFileSync(path.join(s.paths.stateDir, "stray.txt"), "left by something else");

  s.calls.length = 0;
  const removed = await s.command(["uninstall"]);
  assert.equal(removed.code, 0);
  assert.equal(removed.lines[0], "Cursor collection uninstalled: the hook entries, the hook program, the launchers and the service are removed.");
  assert.deepEqual(s.calls, [`systemctl --user disable --now ${CURSOR_SERVICE.linuxName}`, "systemctl --user daemon-reload"]);
  for (const gone of [s.paths.hook, s.paths.readHook, s.paths.hookProgram, s.paths.collectorLauncher, s.unit]) assert.ok(!fs.existsSync(gone), gone);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), FOREIGN_HOOKS, "only our entries were removed");
  assert.equal(s.config().enabled, false);

  const start = removed.lines.indexOf("Left on this machine:");
  assert.ok(start > 0);
  assert.equal(removed.lines.at(-1), `Run \`${PURGE}\` to delete them.`);
  const listed = removed.lines.slice(start + 1, -1).map(line => /^  (\S+)  (.+)$/.exec(line)!);
  const left = new Map(listed.map(match => [match[1]!, match[2]!]));
  assert.equal(left.get(s.paths.config), "settings; holds the ingest key in plain text");
  assert.equal(left.get(`${s.paths.config}.previous`), "previous settings; holds an ingest key in plain text");
  assert.match(left.get(state.spool)!, /records waiting to be sent; holds prompt and reply text, commands, tool output and file content unless capture was always off \(--no-enrich\)/);
  assert.match(left.get(state.pending)!, /holds prompt and reply text, commands, tool output and file content/);
  assert.match(left.get(state.rejected)!, /holds prompt and reply text, commands, tool output and file content/);
  assert.match(left.get(state.checkpoint)!, /reasoning and file content that wait for their record; holds prompt and reply text/);
  for (const expected of [state.checkpoint, state.health, s.paths.stateDir, s.paths.shareDir, s.paths.hooksBackup, path.join(s.paths.stateDir, "stray.txt")]) assert.ok(left.has(expected), expected);
  assert.ok([...left.keys()].some(file => /\/runtime-[a-f0-9]{16}$/.test(file)), "the runtime copy is named");
  // Every file still on the machine is one of the listed paths, or inside a listed directory.
  for (const file of filesOf(s.home).filter(name => name !== ".cursor/hooks.json")) {
    const full = path.join(s.home, file);
    assert.ok([...left.keys()].some(listedPath => full === listedPath || full.startsWith(`${listedPath}/`)), `${file} is left but not listed`);
  }
  for (const listedPath of left.keys()) assert.ok(fs.existsSync(listedPath), `${listedPath} is listed and exists`);
  const asJson = JSON.parse((await s.command(["uninstall"], { json: true })).text);
  assert.deepEqual(asJson.left.map((item: { path: string }) => item.path), [...left.keys()]);
  assert.ok(!removed.text.includes(KEY));

  const purged = await s.command(["uninstall"], { purge: true });
  assert.equal(purged.code, 0);
  assert.deepEqual(filesOf(s.home), [".cursor/hooks.json"], "nothing of ours is left");
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), FOREIGN_HOOKS);
  assert.equal(purged.lines.at(-1), "Nothing of the Cursor collector is left on this machine.");
  for (const deleted of [s.paths.stateDir, s.paths.shareDir, s.paths.config, `${s.paths.config}.previous`, s.paths.hooksBackup]) assert.ok(purged.lines.includes(`Deleted ${deleted}`), deleted);
  for (const parent of [path.dirname(s.paths.config), path.dirname(s.paths.shareDir), path.dirname(s.paths.stateDir)]) assert.ok(!fs.existsSync(parent), `${parent} was empty and is gone`);
  const twice = await s.command(["uninstall"], { purge: true });
  assert.deepEqual([twice.code, twice.lines], [0, ["Nothing of the Cursor collector is installed on this machine."]], "purging twice is harmless");
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), FOREIGN_HOOKS);

  // A hooks.json that Connect created holds nothing else, so it goes too; other CodeTelemetry files stay.
  const own = sandbox(t);
  await own.install();
  const kiroConfig = path.join(path.dirname(own.paths.config), "kiro-v3.json");
  fs.writeFileSync(kiroConfig, "{}");
  assert.equal((await own.command(["uninstall"], { purge: true })).code, 0);
  assert.deepEqual(filesOf(own.home), [".config/codetelemetry/kiro-v3.json"]);
});

test("purge never follows a link out of an owned directory and never deletes a directory that is not ours", async t => {
  const s = sandbox(t);
  await s.install({ cursor: { hooksOnly: true } });
  const outside = path.join(s.fixtures, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "not ours");
  // A link inside the state directory is removed as a link; a state directory that is a link is left alone.
  fs.symlinkSync(outside, path.join(s.paths.stateDir, "spool", "escape"));
  fs.rmSync(s.paths.shareDir, { recursive: true });
  fs.symlinkSync(outside, s.paths.shareDir);
  const purged = await s.command(["uninstall"], { purge: true });
  assert.equal(purged.code, 1);
  assert.match(purged.text, new RegExp(`${s.paths.shareDir} is a link or a file, not a directory\\. It was not followed or removed\\.`));
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "not ours");
  assert.ok(fs.lstatSync(s.paths.shareDir).isSymbolicLink());
  assert.ok(!fs.existsSync(s.paths.stateDir), "the real state directory was removed, link and all");
  assert.ok(purged.lines.includes("Still on this machine:"));

  // A --settings path is deleted only when it holds our settings, and printed commands carry it.
  const custom = sandbox(t), elsewhereSettings = path.join(custom.home, "work", "cursor-collector.json");
  fs.mkdirSync(path.dirname(elsewhereSettings));
  await custom.install({ settings: { path: elsewhereSettings }, cursor: { hooksOnly: true } });
  assert.ok(custom.log.includes(`Status: npx -y @codetelemetry/connect cursor status --settings ${elsewhereSettings}`));
  assert.ok(custom.log.includes(`Remove everything, including the stored key and unsent records: ${PURGE} --settings ${elsewhereSettings}`));
  assert.ok(fs.readFileSync(custom.paths.collectorLauncher, "utf8").includes(`cursor collect --settings '${elsewhereSettings}'`));
  assert.equal((await custom.command(["status"])).code, 1, "the default path holds nothing");
  const listed = await custom.command(["uninstall"], { settings: elsewhereSettings });
  assert.equal(listed.lines.at(-1), `Run \`${PURGE} --settings ${elsewhereSettings}\` to delete them.`);
  const notOurs = path.join(custom.home, "work", "tsconfig.json");
  fs.writeFileSync(notOurs, '{"compilerOptions":{}}');
  const mistaken = await custom.command(["uninstall"], { purge: true, settings: notOurs });
  assert.equal(mistaken.code, 1);
  assert.match(mistaken.text, /tsconfig\.json does not hold Cursor collector settings\. It was not removed\./);
  assert.ok(!mistaken.lines.some(line => line.startsWith(`  ${notOurs}`)), "and it is not listed as ours");
  assert.equal(fs.readFileSync(notOurs, "utf8"), '{"compilerOptions":{}}');
  assert.ok(fs.existsSync(elsewhereSettings), "and the real settings were not the target");
  assert.equal((await custom.command(["uninstall"], { purge: true, settings: elsewhereSettings })).code, 0);
  assert.deepEqual(filesOf(custom.home), ["work/tsconfig.json"]);

  // Settings that name some other directory as the state directory do not make it ours.
  const other = sandbox(t);
  await other.install({ cursor: { hooksOnly: true } });
  const elsewhere = path.join(other.home, "projects");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "thesis.txt"), "years of work");
  const config = JSON.parse(fs.readFileSync(other.paths.config, "utf8"));
  fs.writeFileSync(other.paths.config, JSON.stringify({ ...config, stateDir: elsewhere }));
  const refused = await other.command(["uninstall"], { purge: true });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /projects is not one of CodeTelemetry's own directories[^]*It was not removed\./);
  assert.equal(fs.readFileSync(path.join(elsewhere, "thesis.txt"), "utf8"), "years of work");
});

test("a stop the service manager cannot confirm keeps the service definition and purges nothing", async t => {
  const s = sandbox(t);
  await s.install();
  s.manager.fails = line => line.includes("disable --now");
  const before = filesOf(s.home);
  const result = await s.command(["uninstall"], { purge: true });
  assert.equal(result.code, 1);
  assert.match(result.text, /could not confirm that the collector stopped[^]*Nothing was purged, because the service could not be removed\./);
  assert.ok(fs.existsSync(s.unit) && fs.existsSync(s.paths.collectorLauncher), "the definition and the launcher it starts stay together");
  assert.ok(result.lines.some(line => line.startsWith(`  ${s.unit}  `)), "and the definition is listed");
  assert.equal(s.config().enabled, false, "the collector is told to exit on its own");
  assert.ok(!fs.existsSync(s.paths.hook) && !fs.existsSync(s.paths.hooksFile), "nothing spools meanwhile");
  assert.deepEqual(filesOf(s.home).filter(file => !before.includes(file)), []);
  assert.ok(!result.text.includes(KEY), "the manager's own error text is not repeated");

  // While a collector still holds the state, purge waits and then refuses to delete under it.
  s.manager.fails = () => false;
  const lock = cursorStateFiles(s.config().stateDir).lock;
  fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, token: "held-by-this-test" }), { mode: 0o600 });
  let waits = 0;
  const held = await s.command(["uninstall"], { purge: true }, { sleep: async () => { waits++; } });
  assert.equal(held.code, 1);
  assert.match(held.text, /still running and holds [^]*nothing was purged/);
  assert.equal(waits, 40, "ten seconds in quarter-second steps");
  assert.ok(fs.existsSync(s.paths.config));
  // A lease that a crash left behind before the machine restarted holds nothing,
  // even though its pid belongs to a live process again.
  fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, token: "before-the-restart", boot: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), { mode: 0o600 });
  assert.equal((await s.command(["uninstall"], { purge: true }, { bootId: "11111111-2222-4333-8444-555555555555" })).code, 0);
  assert.deepEqual(filesOf(s.home), []);
});

test("macOS installs a LaunchAgent that runs the launcher, and removes it again", async t => {
  const s = sandbox(t, { platform: "darwin" });
  const result = await s.install();
  assert.equal(result.ok, true);
  assert.deepEqual(s.calls, [
    "launchctl version",
    "launchctl bootout gui/501/com.codetelemetry.cursor-hooks",
    "launchctl enable gui/501/com.codetelemetry.cursor-hooks",
    "launchctl bootstrap gui/501 <home>/Library/LaunchAgents/com.codetelemetry.cursor-hooks.plist",
  ]);
  const plist = fs.readFileSync(s.unit, "utf8");
  assert.ok(plist.includes(`<array><string>/bin/sh</string><string>${s.paths.collectorLauncher}</string></array>`));
  assert.ok(plist.includes("<!-- CodeTelemetry Cursor hooks collector v1 -->"));
  assert.match(s.log.join("\n"), /Started the background collector \(LaunchAgent com\.codetelemetry\.cursor-hooks\)/);
  assert.ok(s.log.includes(CURSOR_PLATFORM_NOTE));
  assert.equal((await s.command(["uninstall"], { purge: true })).code, 0);
  assert.deepEqual(filesOf(s.home), []);
  assert.deepEqual(s.calls.slice(4), ["launchctl bootout gui/501/com.codetelemetry.cursor-hooks"]);
});

test("status reports the collector, the hooks, delivery and what needs attention, never the key", async t => {
  const s = sandbox(t);
  await s.install();
  const now = 1_900_000_000_000, stateDir = s.config().stateDir, state = cursorStateFiles(stateDir);
  const at = { now: () => now };

  const quiet = JSON.parse((await s.command(["status"], { json: true }, at)).text);
  assert.deepEqual([quiet.installed, quiet.running, quiet.enabled, quiet.hooks, quiet.service, quiet.nodePathValid, quiet.delivery, quiet.proxy],
    [true, false, true, "installed", "installed", true, null, null]);
  assert.deepEqual([quiet.capture, quiet.identity, quiet.mode], [{ prompts: true, toolDetails: true }, { email: true }, MODE_ON]);
  assert.match(quiet.notices[0], /^The collector is not running\. Records wait in the spool \(at most 128 MiB\) for up to 14 days/);
  assert.deepEqual([quiet.lastTickAt, quiet.lastOutcome, quiet.lastAckAt, quiet.recordsSpooled, quiet.hookDrops, quiet.pid], [0, null, null, 0, 0, 0]);

  await writeCursorHealth(stateDir, health({ lastTickAt: now - 3000, lastAckAt: now - 20_000, lastOutcome: "ok", lastDetail: "accepted",
    recordsSpooled: 12, recordsAcknowledged: 9, pendingRecords: 3, status: "retrying" }), { running: true, pid: process.pid });
  const running = JSON.parse((await s.command(["status"], { json: true }, at)).text);
  assert.deepEqual([running.running, running.delivery, running.lastOutcome, running.recordsSpooled, running.recordsAcknowledged, running.pendingRecords, running.pid, running.notices],
    [true, "retrying", "ok", 12, 9, 3, process.pid, []]);
  for (const field of ["lastTickAt", "lastErrorClass", "lastAckAt", "nextAttemptAt", "recordsMalformed", "recordsExpired", "recordsRejected", "recordsLost", "rejectedBytes", "hookDrops", "spoolBytes"]) {
    assert.ok(field in running, `${field} is reported`);
  }
  assert.ok(!("version" in running));
  assert.deepEqual(Object.keys(running).sort(), Object.keys(quiet).sort(), "the same keys whether or not the collector has reported");
  const human = (await s.command(["status"], {}, at)).lines;
  assert.equal(human[0], `Cursor collection: enabled; collector running (pid ${process.pid}); service installed`);
  assert.equal(human[1], `Hooks: installed (${s.paths.hooksFile})`);
  assert.equal(human[2], MODE_ON);
  {
    // An installation with both options off: status says so and names the flags that turn them on.
    const off = sandbox(t);
    await off.install({ settings: { enrich: false }, cursor: { identity: false } });
    const json = JSON.parse((await off.command(["status"], { json: true }, at)).text);
    assert.deepEqual([json.capture, json.identity, json.mode], [{ prompts: false, toolDetails: false }, { email: false }, MODE_OFF]);
    assert.equal((await off.command(["status"], {}, at)).lines[2], MODE_OFF);
  }
  assert.equal(human[3], "Last pass 3s ago; last accepted delivery 20s ago; last answer: accepted");
  assert.match(human[4]!, /^Records: 12 read, 9 sent, 3 being sent; /);

  // A stale pass, a dead process or a health file that claims too much does not count as running.
  assert.equal(JSON.parse((await s.command(["status"], { json: true }, { now: () => now + 31_000 })).text).running, false);
  await writeCursorHealth(stateDir, health({ lastTickAt: now }), { running: true, pid: 2 ** 22 + 7 });
  assert.equal((await cursorStatus(s.paths.config, { ...s.host, ...at }))!.running, false);
  fs.writeFileSync(state.health, JSON.stringify({ version: 1, running: true, pid: process.pid, lastTickAt: now, secret: KEY, lastOutcome: "made-up" }));
  const odd = await s.command(["status"], { json: true }, at);
  assert.ok(!odd.text.includes(KEY) && !odd.text.includes("made-up"), "health is read as a fixed set of fields");

  const noticeFor = async (extra: Partial<CursorHealth>) => {
    await writeCursorHealth(stateDir, health({ lastTickAt: now, ...extra }), { running: true, pid: process.pid });
    return (await cursorStatus(s.paths.config, { ...s.host, ...at }))!.notices.join("\n");
  };
  assert.match(await noticeFor({ lastOutcome: "auth" }), /^The ingest key was refused\. Run `npx -y @codetelemetry\/connect login --client cursor` again\.$/);
  assert.match(await noticeFor({ lastOutcome: "budget" }), /out of credit/);
  assert.match(await noticeFor({ lastOutcome: "unsupported" }), /does not accept Cursor records yet[^]*none is set aside/);
  assert.match(await noticeFor({ lastOutcome: "rejected" }), /cursor retry-rejected/);
  assert.match(await noticeFor({ lastOutcome: "network", lastErrorClass: "proxy" }), /export HTTPS_PROXY[^]*--no-proxy-settings/);
  assert.match(await noticeFor({ lastOutcome: "network", lastErrorClass: "tls" }), /NODE_EXTRA_CA_CERTS=<file>/);
  assert.match(await noticeFor({ lastOutcome: "network", lastErrorClass: "dns" }), /could not be reached \(dns\)/);
  assert.match(await noticeFor({ hookDrops: 4, rejectedEnvelopes: 2, rejectedBytes: 900 }), /4 event\(s\) could not be recorded by the hook \(a spool at its 128 MiB bound, oversized input or a failed write\)[^]*2 refused batch\(es\) are set aside \(900 bytes\)/);
  assert.equal(await noticeFor({ lastOutcome: "ok" }), "");
  // The bound status names is the one the hook enforces.
  await writeCursorHealth(stateDir, health({ lastTickAt: now, spoolBytes: 4096, spoolSegments: 3, backlogBytes: 512 }), { running: true, pid: process.pid });
  assert.match((await s.command(["status"], {}, at)).text, new RegExp(`^Spool: 4096 of at most ${CURSOR_HOOK_LIMITS.spoolBytes} bytes in 3 segment\\(s\\), 512 not yet read; `, "m"));
  assert.equal(CURSOR_HOOK_LIMITS.spoolBytes, 134_217_728);

  // Another tool rewrote hooks.json and dropped some of ours.
  const document = JSON.parse(fs.readFileSync(s.paths.hooksFile, "utf8"));
  delete document.hooks.stop;
  fs.writeFileSync(s.paths.hooksFile, JSON.stringify(document));
  const partial = (await cursorStatus(s.paths.config, { ...s.host, ...at }))!;
  assert.equal(partial.hooks, "partial");
  assert.match(partial.notices.join("\n"), /holds only some of the eight CodeTelemetry hook entries[^]*cursor enable` adds them back/);

  // The hook found the recorded Node.js gone: status says so, and so does every other command, on stderr.
  assert.equal(cursorNodeNotice(s.home), null);
  fs.writeFileSync(state.nodeStale, "");
  const stale = (await cursorStatus(s.paths.config, { ...s.host, ...at }))!;
  assert.equal(stale.nodePathValid, false);
  assert.ok(stale.notices.includes(CURSOR_NODE_NOTICE));
  assert.equal(cursorNodeNotice(s.home), "The Cursor collector's Node.js path changed; run `login --client cursor` again to refresh it.");
  const errors: string[] = [], writeError = process.stderr.write.bind(process.stderr), write = process.stdout.write.bind(process.stdout);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; };
  (process.stdout as { write: unknown }).write = () => true;
  try {
    assert.equal(await run(["print-config"], { cursor: s.host }), 0);
    assert.equal(await run(["cursor", "status"], { cursor: s.host }), 0);
  } finally {
    process.stderr.write = writeError;
    process.stdout.write = write;
  }
  assert.deepEqual(errors, [`${CURSOR_NODE_NOTICE}\n`], "once, and not from the command that reports it itself");
  await s.install();
  assert.ok(!fs.existsSync(state.nodeStale), "login refreshes the paths and clears the marker");
  assert.equal(cursorNodeNotice(s.home), null);

  // With no executable candidate left, the path is invalid even without the marker.
  const config = JSON.parse(fs.readFileSync(s.paths.config, "utf8"));
  fs.writeFileSync(s.paths.config, JSON.stringify({ ...config, node: { execPath: "/opt/removed/node-v24/bin/node" } }));
  assert.equal((await cursorStatus(s.paths.config, s.host))!.nodePathValid, false);
  fs.writeFileSync(state.nodePath, `${process.execPath}\n`);
  assert.equal((await cursorStatus(s.paths.config, s.host))!.nodePathValid, true, "the path the hook found counts");
});

test("collect sends spooled records with the format header and the Connect version, and stops when its settings change", async t => {
  const s = sandbox(t);
  await s.install({ settings: { enrich: false }, cursor: { hooksOnly: true, identity: false } });
  const stateDir = s.config().stateDir, state = cursorStateFiles(stateDir);
  const now = 1_900_000_000_000, captured = now - 60_000;
  const line = (id: string, hook: string, payload: Record<string, unknown>) => JSON.stringify({
    v: 1, id: id.padStart(32, "0"), t: `${captured}000000`, hook, conversation_id: "5b1c7f0e-2d3a-4c4b-9e8f-0a1b2c3d4e5f",
    p: { prompts: false, toolDetails: false, email: false }, payload,
  });
  const segment = path.join(state.spool, `seg-${Math.floor(captured / CURSOR_HOOK_LIMITS.segmentMs)}.jsonl`);
  fs.writeFileSync(segment, [
    line("a1", "beforeSubmitPrompt", { generation_id: "turn-1", model: "default", prompt_length: 42, attachment_count: 0 }),
    line("a2", "postToolUse", { generation_id: "turn-1", tool_name: "Read", tool_use_id: "call-1", duration: 4.5, tool_input_size_bytes: 20, result: { content_length: 12 } }),
  ].map(text => `${text}\n`).join(""), { mode: 0o600 });

  const service = ingest();
  const lines: string[] = [], write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
  let code: number;
  try {
    code = await run(["cursor", "collect", "--once", "--settings", s.paths.config], { cursor: { ...s.host, fetchImpl: service.fetchImpl, now: () => now } });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 0);
  assert.equal(service.requests.length, 1);
  const sent = service.requests[0]!, envelope = JSON.parse(sent.body);
  assert.equal(sent.headers[FORMAT_HEADER], FORMAT);
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(envelope.resourceLogs[0].resource.attributes, [
    { key: "service.name", value: { stringValue: "cursor" } },
    { key: "codetelemetry.connect.version", value: { stringValue: CONNECT_VERSION } },
  ]);
  assert.equal(envelope.resourceLogs[0].scopeLogs[0].logRecords.length, 2);
  const reported = JSON.parse(lines.join(""));
  assert.deepEqual([reported.status, reported.recordsAcknowledged, reported.lastOutcome], ["idle", 2, "ok"]);
  const after = JSON.parse((await s.command(["status"], { json: true }, { now: () => now })).text);
  assert.deepEqual([after.running, after.recordsAcknowledged, after.pid], [false, 2, process.pid], "a one-shot pass is not a running collector");
  assert.ok(!fs.existsSync(state.lock), "the state is released");
  assert.ok(!lines.join("").includes(KEY));

  // Records the service does not take leave a non-zero exit, so a caller can tell.
  fs.appendFileSync(segment, `${line("a3", "stop", { generation_id: "turn-1", status: "completed", input_tokens: 10, output_tokens: 2 })}\n`);
  const refused = await s.command(["collect"], { once: true }, { fetchImpl: ingest("unsupported-415").fetchImpl, now: () => now + 60_000 });
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.text).lastOutcome, "unsupported");

  // A running collector re-reads its settings before every pass.
  let passes = 0;
  const changed = await s.command(["collect"], {}, {
    fetchImpl: ingest().fetchImpl, now: () => now + 120_000,
    sleep: async () => {
      if (++passes === 2) await s.install({ settings: { enrich: true }, cursor: { hooksOnly: true } });
    },
  });
  assert.equal(changed.code, 1, "a non-zero exit makes a supervisor start it again with the new settings");
  assert.match(changed.text, /^Cursor collector settings changed; a restart applies them\. Unsent records are kept\.$/);
  assert.equal(passes, 2);
  passes = 0;
  const disabled = await s.command(["collect"], {}, {
    fetchImpl: ingest().fetchImpl, now: () => now + 180_000,
    sleep: async () => {
      if (++passes === 1) fs.writeFileSync(s.paths.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.paths.config, "utf8")), enabled: false }));
    },
  });
  assert.deepEqual([disabled.code, disabled.lines], [0, []], "disabled while running: a clean exit");
  assert.equal((await readHealthRunning(state.health)), false);

  assert.equal((await s.command(["collect"], {}, { nodeVersion: "22.21.0" })).code, 1);
});

async function readHealthRunning(file: string): Promise<boolean> {
  return JSON.parse(fs.readFileSync(file, "utf8")).running === true;
}

test("retry-rejected asks the collector to send set-aside batches again", async t => {
  const s = sandbox(t);
  await s.install({ cursor: { hooksOnly: true } });
  const stateDir = s.config().stateDir, rejected = cursorStateFiles(stateDir).rejected;
  const none = await s.command(["retry-rejected"]);
  assert.deepEqual([none.code, none.text], [0, "No refused batches are set aside; there is nothing to send again."]);
  fs.mkdirSync(rejected, { recursive: true });
  fs.writeFileSync(path.join(rejected, "0f8fad5b-d9cb-469f-a165-70867728950e.json"), "{}");
  const one = await s.command(["retry-rejected"], { json: true }, { now: () => 1_900_000_000_000 });
  assert.deepEqual(JSON.parse(one.text), { ok: true, envelopes: 1, detail: "1 set-aside batch(es) will be sent again when the collector next starts." });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "retry-rejected"), "utf8")), { version: 1, requestedAt: 1_900_000_000_000 });
});

test("the cursor subcommands validate their own options", async t => {
  const s = sandbox(t);
  for (const [args, flags, message] of [
    [["launch"], {}, /^Usage: codetelemetry-connect cursor status\|collect\|enable\|disable\|uninstall\|retry-rejected/],
    [["status", "extra"], {}, /^Usage: /],
    [["status"], { purge: true }, /^Unknown option --purge for cursor status\./],
    [["status"], { once: true }, /^Unknown option --once for cursor status\./],
    [["disable"], { "hooks-only": true }, /^Unknown option --hooks-only for cursor disable\./],
    [["uninstall"], { purge: "now" }, /^--purge takes no value\.$/],
    [["status"], { json: false }, /^--json takes no value\.$/],
    [["status"], { settings: true }, /^--settings needs a path\.$/],
    [["status"], { endpoint: "https://example.invalid" }, /^Unknown option --endpoint for cursor status\./],
  ] as Array<[string[], Record<string, string | boolean>, RegExp]>) {
    const result = await s.command(args, flags);
    assert.equal(result.code, 1, JSON.stringify([args, flags]));
    assert.match(result.text, message);
  }
  await assert.rejects(s.command(["status"], { settings: path.join(s.home, ".cursor", "cursor-hooks-v1.json") }), /outside Cursor's own configuration directory/);
  assert.deepEqual(tree(s.home), []);
});

test("the client twins, the descriptor, the help text and the versions agree", async () => {
  assert.deepEqual([...ONBOARD_CLIENTS], ["claude", "codex", "pi", "kiro", "cursor"]);
  assert.deepEqual([...SESSION_FILTER_ASSISTANTS], ["claude", "codex", "kiro", "cursor"]);
  const descriptor = resolveClient("cursor");
  assert.deepEqual([descriptor.id, descriptor.label, descriptor.noun, descriptor.cliFlag], ["cursor", "Cursor", "collector settings", " --client cursor"]);
  assert.ok(descriptor.resolveConfigPath({}).endsWith(path.join(".config", "codetelemetry", "cursor-hooks-v1.json")));
  assert.ok(descriptor.resolveConfigPath({}).startsWith(os.homedir()), "inside the isolated home");
  const printed = JSON.parse(CLIENTS.cursor.printConfig(INGEST, true));
  assert.deepEqual([printed.kind, printed.key, printed.ingestEndpoint, printed.content, printed.identity],
    ["codetelemetry-cursor-hooks-v1", "cot_<YOUR_INGEST_KEY>", INGEST, { prompts: true, toolDetails: true }, { email: true }]);
  const reduced = JSON.parse(CLIENTS.cursor.printConfig(INGEST, false, false));
  assert.deepEqual([reduced.content, reduced.identity], [{ prompts: false, toolDetails: false }, { email: false }]);
  assert.equal(descriptor.readKey(path.join(os.tmpdir(), "no-such-cursor-config.json")), null);
  assert.deepEqual(descriptor.readSummary(path.join(os.tmpdir(), "no-such-cursor-config.json")), { exists: false, otelKeys: [], hasKey: false, collectorEnabled: false });

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const json = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  assert.equal(json("packages/connect/package.json").version, CONNECT_VERSION);
  assert.equal(json("package-lock.json").version, json("package.json").version);
  assert.equal(json("package-lock.json").packages[""].version, json("package.json").version);
  for (const file of ["README.md", "packages/connect/README.md"]) {
    const pins = [...fs.readFileSync(path.join(root, file), "utf8").matchAll(/@codetelemetry\/connect@(\d+\.\d+\.\d+)/g)].map(match => match[1]);
    assert.ok(pins.length > 0, `${file} pins a Connect version`);
    assert.deepEqual([...new Set(pins)], [CONNECT_VERSION], `${file} pins this Connect release`);
  }
  const exported = Object.keys(json("package.json").exports);
  for (const name of ["collector/scrub", "collector/service", "collector/state", "collector/transport", "cursor/collector", "cursor/command",
    "cursor/config", "cursor/hookProgram", "cursor/hooksFile", "cursor/preflight", "cursor/records"]) assert.ok(exported.includes(`./client/${name}`), name);

  const lines: string[] = [], write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
  try {
    assert.equal(await run(["--help"]), 0);
    assert.equal(await run(["print-config", "--client", "cursor", "--endpoint", INGEST]), 0);
    assert.equal(await run(["print-config", "--client", "emacs"]), 1);
    assert.equal(await run(["import", "--client", "cursor", "--dry-run"]), 1);
  } finally {
    process.stdout.write = write;
  }
  const output = lines.join("");
  // print-config shows what a new install stores: both on, or off for each --no- flag.
  const block = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const shown = block(output.slice(output.indexOf('{\n  "kind"')).split("\n\nCursor is set up")[0]!);
  assert.deepEqual([shown.content, shown.identity], [{ prompts: true, toolDetails: true }, { email: true }]);
  lines.length = 0;
  (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
  try {
    assert.equal(await run(["print-config", "--client", "cursor", "--endpoint", INGEST, "--no-enrich", "--no-identity"]), 0);
  } finally {
    process.stdout.write = write;
  }
  const turnedOff = block(lines.join("").split("\n\nCursor is set up")[0]!);
  assert.deepEqual([turnedOff.content, turnedOff.identity], [{ prompts: false, toolDetails: false }, { email: false }]);
  assert.match(output, /cursor status\|collect\|enable\|disable\|uninstall\|retry-rejected/);
  assert.match(output, /--client claude\|codex\|pi\|kiro\|cursor/);
  assert.match(output, /Verified on Linux\. macOS\s+is in preview\. Windows is not supported\./);
  assert.match(output, /A new install sends prompt text, the reply and the model's reasoning for\s+each turn, tool commands, tool output, the error text of a failed call,\s+file paths, the content of files read and written, the workspace path[^]*and your Cursor account email/);
  assert.match(output, /--no-enrich \/ --enrich Stop sending prompt text, reply text, reasoning, tool\s+commands, tool output, error text, file paths, file\s+content and the workspace path, or send them again\./);
  assert.match(output, /After upgrading Connect, run `login --client cursor` again/);
  // print-config says what each capture option sends.
  assert.match(output, /content\.prompts sends prompt text, the reply of each turn and the model's reasoning\. content\.toolDetails sends tool commands, tool output, the error text of a failed call, file paths, the content of files read and written, and the workspace path\. identity\.email sends your Cursor account email\./);
  assert.match(output, /It installs eight hooks and a background collector/);
  assert.match(output, /On by\s+default for a new install; with neither flag an\s+existing install keeps its stored choice\./);
  assert.match(output, /Headless runs\s+\(cursor-agent -p\) report tools, their output and durations, but no prompts,\s+no replies and no tokens\./);
  assert.match(output, /Remote-SSH, WSL or a\s+Dev Container/);
  for (const flag of ["--no-enrich / --enrich", "--no-identity / --identity", "--hooks-only", "--hooks-manual", "--no-proxy-settings", "cursor uninstall --purge"]) assert.ok(output.includes(flag), flag);
  assert.match(output, /"kind": "codetelemetry-cursor-hooks-v1"/);
  assert.match(output, /Cursor is set up by running `npx -y @codetelemetry\/connect login --client cursor`/);
  assert.match(output, /--client must be one of claude, codex, pi, kiro, cursor\./);
  assert.match(output, /Cursor sessions are collected by its hooks as they happen; history import does not support this source\./);
  assert.ok(!/[^\x00-\x7f]/.test(output.slice(output.indexOf("Cursor (--client cursor):"), output.indexOf('"kind"'))), "the Cursor help is plain ASCII");
});

test("the MCP tools list cursor, refuse to install it, and tell the model which command the user runs", async t => {
  const s = sandbox(t);
  const session = new OnboardingSession();
  const ctx: ToolContext = { session, endpointsOverride: { ingestEndpoint: INGEST }, configPathsOverride: { cursor: s.paths.config },
    fetchImpl: () => { throw new Error("no request may be made"); } };
  const schema = (name: string) => TOOLS.find(tool => tool.name === name)!.inputSchema as any;
  for (const name of ["write_local_config", "onboard", "status"]) {
    assert.deepEqual(schema(name).properties.client.enum, ["claude", "codex", "pi", "kiro", "cursor"], name);
    assert.match(schema(name).properties.client.description, /cursor is not configured by these tools[^]*npx -y @codetelemetry\/connect login --client cursor/);
    assert.match(schema(name).properties.path.description, /with client "cursor" a cursor-hooks-v1\.json inside \.config\/codetelemetry/);
  }
  assert.deepEqual(schema("search_sessions").properties.assistant.enum, ["all", "claude", "codex", "kiro", "cursor"]);
  assert.deepEqual(schema("estimate_plan").properties.provider.enum, ["claude", "codex", "pi", "kiro", "cursor"]);

  for (const [name, args] of [["onboard", { client: "cursor", key: KEY }], ["onboard", { client: "cursor" }], ["write_local_config", { client: "cursor" }],
    ["onboard", { client: "cursor", path: "/etc/passwd" }]] as const) {
    const result = await callTool(name, args, ctx);
    assert.deepEqual([result.ok, result.error], [false, "use_connect_cli"], name);
    assert.match(String(result.message), /Ask the user to run `npx -y @codetelemetry\/connect login --client cursor`[^]*where the Cursor workspace lives[^]*adds eight hook entries[^]*A new install sends prompt text, the reply and reasoning of each turn, tool commands, tool output, file paths, the content of files read and written, the workspace path and the user's Cursor account email[^]*--no-enrich[^]*--no-identity[^]*keeps its stored choices/);
  }
  assert.equal(session.hasKey(), false, "a key passed with the refused call is not kept");
  assert.deepEqual(tree(s.home), [], "nothing was installed or written");
  assert.deepEqual(s.calls, []);

  // status is read-only and works for an installation the user made with Connect.
  await s.install();
  const status = await callTool("status", { client: "cursor" }, ctx);
  assert.equal(status.ok, true);
  assert.deepEqual(status.settings, { path: s.paths.config, exists: true, otelKeys: ["ingestEndpoint", "content", "identity", "hooksFile"], hasKey: true, collectorEnabled: true });
  assert.ok(!JSON.stringify(status).includes(KEY));

  const allowed = path.join(s.home, ".config", "codetelemetry", "cursor-hooks-v1.json");
  assert.deepEqual(requestedConfigPath("cursor", { path: allowed }), { ok: true, path: allowed });
  for (const refusedPath of [path.join(s.home, ".cursor", "cursor-hooks-v1.json"), path.join(s.home, ".config", "codetelemetry", "kiro-v3.json"), path.join(s.home, ".cursor", "hooks.json")]) {
    assert.deepEqual(requestedConfigPath("cursor", { path: refusedPath }),
      { ok: false, message: "path must name cursor-hooks-v1.json inside a .config/codetelemetry directory, outside Cursor configuration." });
  }
  assert.equal((await callTool("status", { client: "cursor", path: path.join(s.home, ".cursor", "hooks.json") }, { session })).error, "bad_input");
});

test("the real Connect runtime fits the bounds of the copy the service runs from", async t => {
  const s = sandbox(t);
  delete s.host.runtimeSource;
  delete s.host.extension;
  await s.install();
  const launcher = fs.readFileSync(s.paths.collectorLauncher, "utf8");
  const entry = /^ *"\$N" '([^']+)' cursor collect/m.exec(launcher)![1]!;
  assert.ok(entry.startsWith(`${s.paths.shareDir}/runtime-`) && entry.endsWith("/bin.ts"));
  const runtime = path.dirname(entry);
  for (const file of ["cli.ts", "cursor/command.ts", "cursor/collector.ts", "collector/transport.ts", "package.json"]) assert.ok(fs.existsSync(path.join(runtime, file)), file);
  assert.equal(fs.readdirSync(s.paths.shareDir).filter(name => name.startsWith("runtime-")).length, 1);
});

test("no test in this file reached a real service manager", () => {
  assert.equal(fs.existsSync(guardLog), false, fs.existsSync(guardLog) ? fs.readFileSync(guardLog, "utf8") : "");
});

test("an installation made with six hooks is brought to eight by enable or the next login, with the user's hooks kept", async t => {
  const s = sandbox(t);
  s.writeHooks(FOREIGN_HOOKS);
  await s.install();
  // The machine as the earlier release left it: six entries, no launcher for the file-read hook.
  const earlier = CURSOR_HOOK_EVENTS.slice(0, 6), foreign = JSON.parse(FOREIGN_HOOKS).hooks as Record<string, unknown[]>;
  const document = JSON.parse(fs.readFileSync(s.paths.hooksFile, "utf8"));
  for (const event of ["afterAgentResponse", "beforeReadFile"]) {
    if (event in foreign) document.hooks[event] = foreign[event];
    else delete document.hooks[event];
  }
  fs.writeFileSync(s.paths.hooksFile, JSON.stringify(document, null, 2) + "\n");
  fs.rmSync(s.paths.readHook);
  updateCursorConfig(s.paths.config, { createdHookKeys: earlier.filter(event => !(event in foreign)) });

  const before = (await cursorStatus(s.paths.config, s.host))!;
  assert.equal(before.hooks, "partial");
  assert.match(before.notices.join("\n"), /holds only some of the eight CodeTelemetry hook entries, so Cursor reports only part of each session\. An earlier Connect release installed six of them[^]*cursor enable` adds them back/);

  const enabled = await s.command(["enable"]);
  assert.equal(enabled.code, 0);
  assert.equal((await cursorStatus(s.paths.config, s.host))!.hooks, "installed");
  assert.ok(fs.existsSync(s.paths.readHook));
  assert.deepEqual(s.hooks().beforeReadFile!.at(-1), { command: s.paths.readHook, timeout: 5 });
  assert.deepEqual(s.hooks().afterAgentResponse!.at(-1), { command: s.paths.hook, timeout: 5 });
  for (const [event, entries] of Object.entries(foreign)) assert.deepEqual(s.hooks()[event]!.slice(0, entries.length), entries, `the user's ${event} hooks are kept`);
  assert.deepEqual(s.config().createdHookKeys, CURSOR_HOOK_EVENTS.filter(event => !(event in foreign)));

  // Uninstall then gives the user's file back, byte for byte.
  assert.equal((await s.command(["uninstall"])).code, 0);
  assert.equal(fs.readFileSync(s.paths.hooksFile, "utf8"), JSON.stringify(JSON.parse(FOREIGN_HOOKS), null, 2) + "\n");
});
