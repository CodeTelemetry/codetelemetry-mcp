// The Cursor collector's private config. Every file is in a temporary
// directory; the import below also moves the home directory there, so a default
// path cannot reach the real ~/.config, ~/.local or ~/.cursor.
import "../support/isolateHome.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorHookCommand,
  CURSOR_CONFIG_BYTES, cursorCaptureSummary, cursorNetworkFromEnv, cursorNodePaths, cursorPaths, cursorPolicy, cursorProxyDisplay,
  cursorShareFiles, cursorStateFiles, isSafeCursorPath, readCursorConfig, readCursorKey, readCursorSummary, resolveCursorConfigPath,
  updateCursorConfig, writeCursorConfig, writeCursorFileAtomic, type CursorConfig,
} from "../../src/client/cursor/config.ts";

const KEY = "cot_" + "synthetic".repeat(4);
const INGEST = "https://ingest.example.invalid";
const NODE = { execPath: "/opt/fixture/node-v24/bin/node", commandPath: "/opt/fixture/bin/node" };
/** The mode line with both options on, and with both off. */
const MODE_ON = "Capture: prompt text, reply text and reasoning, tool commands, tool output, file paths, file content and workspace path (turn off: login --client cursor --no-enrich). Developer email: sent (turn off: login --client cursor --no-identity).";
const MODE_OFF = "Capture: metadata only (turn on prompt and reply text and tool details: login --client cursor --enrich). Developer email: not sent (turn on: login --client cursor --identity).";

function sandbox(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = cursorPaths(home);
  const write = (extra: Partial<Parameters<typeof writeCursorConfig>[0]> = {}) =>
    writeCursorConfig({ key: KEY, ingestEndpoint: INGEST, configPath: paths.config, home, node: NODE, ...extra });
  return { home, paths, write, read: () => readCursorConfig(paths.config) };
}

test("every default path derives from the home directory and none is inside Cursor's own directory except hooks.json", t => {
  const s = sandbox(t), p = s.paths;
  assert.deepEqual(p, {
    config: path.join(s.home, ".config/codetelemetry/cursor-hooks-v1.json"),
    shareDir: path.join(s.home, ".local/share/codetelemetry/cursor-hooks-v1"),
    stateDir: path.join(s.home, ".local/state/codetelemetry/cursor-hooks-v1"),
    hooksFile: path.join(s.home, ".cursor/hooks.json"),
    hooksBackup: path.join(s.home, ".cursor/hooks.json.codetelemetry-backup"),
    hook: path.join(s.home, ".local/share/codetelemetry/cursor-hooks-v1/hook.sh"),
    readHook: path.join(s.home, ".local/share/codetelemetry/cursor-hooks-v1/hook-read.sh"),
    hookProgram: path.join(s.home, ".local/share/codetelemetry/cursor-hooks-v1/hook.cjs"),
    collectorLauncher: path.join(s.home, ".local/share/codetelemetry/cursor-hooks-v1/collector.sh"),
  });
  assert.deepEqual(cursorShareFiles("/x"), { hook: "/x/hook.sh", readHook: "/x/hook-read.sh", hookProgram: "/x/hook.cjs", collectorLauncher: "/x/collector.sh" });
  // The command of a file read is the launcher beside the ordinary one; every other event runs the ordinary one.
  assert.equal(cursorHookCommand("beforeReadFile", "/x/hook.sh"), "/x/hook-read.sh");
  for (const event of ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "stop", "afterAgentThought", "afterShellExecution", "afterAgentResponse"]) {
    assert.equal(cursorHookCommand(event, "/x/hook.sh"), "/x/hook.sh", event);
  }
  assert.deepEqual(cursorStateFiles("/s"), { spool: "/s/spool", dropped: "/s/dropped", nodePath: "/s/node-path", nodeStale: "/s/node-stale",
    checkpoint: "/s/checkpoint.json", pending: "/s/pending.json", health: "/s/health.json", lock: "/s/collector.lock", rejected: "/s/rejected" });
  assert.ok(cursorPaths().config.startsWith(os.homedir() + path.sep), "the default home is the isolated test home");
  assert.equal(resolveCursorConfigPath({ home: s.home }), p.config);
  assert.equal(resolveCursorConfigPath({ path: "relative.json" }), path.resolve("relative.json"));
  for (const inside of [path.join(s.home, ".cursor", "codetelemetry.json"), path.join(s.home, ".cursor", "nested", "c.json")]) {
    assert.throws(() => resolveCursorConfigPath({ path: inside }), /outside Cursor's own configuration directory/);
    assert.throws(() => s.write({ configPath: inside }), /outside Cursor's own configuration directory/);
  }
  assert.equal(fs.existsSync(path.join(s.home, ".cursor")), false);
});

test("the safe-path grammar admits only characters no shell splits or expands", () => {
  for (const ok of ["/home/dev/.local/share/codetelemetry/cursor-hooks-v1/hook.sh", "/Users/a.b-c_d/x@y+z/hook.sh", "/"]) assert.equal(isSafeCursorPath(ok), true, ok);
  for (const bad of ["relative/hook.sh", "/home/first last/hook.sh", "/home/a$b/h", "/home/a'b/h", '/home/a"b/h', "/home/a`b/h", "/home/a;b/h", "/home/a&b/h",
    "/home/a(b/h", "/home/a*b/h", "/home/a~b/h", "/home/a\\b/h", "/home/a\nb/h", "/home/a\tb/h", "", `/${"x".repeat(4096)}`, 7, null, undefined]) {
    assert.equal(isSafeCursorPath(bad), false, String(bad));
  }
});

test("a first install captures prompts, tool details and the email, is private on disk, and reports no secret", t => {
  const s = sandbox(t);
  const result = s.write();
  assert.deepEqual(result, {
    path: s.paths.config, created: true, backupPath: null,
    wrote: ["key", "ingestEndpoint", "enabled", "stateDir", "content", "identity", "network", "node", "hooksFile"],
    reduced: { prompts: false, toolDetails: false, email: false },
  });
  assert.ok(!JSON.stringify(result).includes(KEY));
  const expected: CursorConfig = {
    kind: "codetelemetry-cursor-hooks-v1", version: 1, enabled: true, key: KEY, ingestEndpoint: INGEST, stateDir: s.paths.stateDir,
    content: { prompts: true, toolDetails: true }, identity: { email: true }, network: {}, node: NODE, hooksFile: s.paths.hooksFile, createdByConnect: false,
  };
  assert.deepEqual(s.read(), expected);
  assert.equal(fs.readFileSync(s.paths.config, "utf8"), JSON.stringify(expected, null, 2) + "\n");
  assert.equal(fs.statSync(s.paths.config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(s.paths.config)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(s.paths.config)), ["cursor-hooks-v1.json"], "no temporary is left behind");
  assert.deepEqual(writeCursorConfig({ key: KEY, ingestEndpoint: INGEST, configPath: path.join(s.home, "other.json"), home: s.home }).created, true);
  assert.equal(readCursorConfig(path.join(s.home, "other.json")).node.execPath, process.execPath, "the installing interpreter is recorded by default");
});

test("capture options are tri-state: a flag sets, its negation clears, no flag keeps", t => {
  const s = sandbox(t);
  const state = () => cursorPolicy(s.read());
  assert.deepEqual(s.write().reduced, { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(state(), { prompts: true, toolDetails: true, email: true }, "a new install has both options on");
  assert.deepEqual(s.write().reduced, { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(state(), { prompts: true, toolDetails: true, email: true }, "a rerun without a flag keeps the stored choice");
  assert.deepEqual(s.write({ enrich: false }).reduced, { prompts: true, toolDetails: true, email: false }, "a downgrade is reported so unsent records can be reduced");
  assert.deepEqual(state(), { prompts: false, toolDetails: false, email: true });
  assert.deepEqual(s.write({ identity: false }).reduced, { prompts: false, toolDetails: false, email: true });
  assert.deepEqual(state(), { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(s.write().reduced, { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(state(), { prompts: false, toolDetails: false, email: false }, "a stored off stays off without a flag");
  assert.deepEqual(s.write({ enrich: true }).reduced, { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(state(), { prompts: true, toolDetails: true, email: false });
  assert.deepEqual(s.write({ identity: true }).reduced, { prompts: false, toolDetails: false, email: false });
  assert.deepEqual(state(), { prompts: true, toolDetails: true, email: true });
});

test("a new install with one option turned off stores exactly that", t => {
  for (const [options, expected] of [
    [{ enrich: false }, { prompts: false, toolDetails: false, email: true }],
    [{ identity: false }, { prompts: true, toolDetails: true, email: false }],
    [{ enrich: false, identity: false }, { prompts: false, toolDetails: false, email: false }],
    [{ enrich: true, identity: true }, { prompts: true, toolDetails: true, email: true }],
  ] as const) {
    const s = sandbox(t);
    assert.deepEqual(s.write(options).reduced, { prompts: false, toolDetails: false, email: false });
    assert.deepEqual(cursorPolicy(s.read()), expected, JSON.stringify(options));
  }
});

test("a config stored before the options were on by default keeps its choices until a flag changes them", t => {
  const s = sandbox(t);
  s.write();
  const stored = { ...JSON.parse(fs.readFileSync(s.paths.config, "utf8")), content: { prompts: false, toolDetails: false }, identity: { email: false } };
  fs.writeFileSync(s.paths.config, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  s.write();
  assert.deepEqual(cursorPolicy(s.read()), { prompts: false, toolDetails: false, email: false });
  assert.equal(cursorCaptureSummary(s.read()), MODE_OFF, "the mode line names the flags that turn each on");
  s.write({ enrich: true });
  assert.deepEqual(cursorPolicy(s.read()), { prompts: true, toolDetails: true, email: false });
  s.write({ identity: true });
  assert.deepEqual(cursorPolicy(s.read()), { prompts: true, toolDetails: true, email: true });
  assert.equal(cursorCaptureSummary(s.read()), MODE_ON);
});

test("the mode line names exactly what is captured and the command that changes it", () => {
  const line = (prompts: boolean, toolDetails: boolean, email: boolean) => cursorCaptureSummary({ content: { prompts, toolDetails }, identity: { email } });
  assert.equal(line(false, false, false), MODE_OFF);
  assert.equal(line(true, true, true), MODE_ON);
  assert.equal(line(true, true, false), "Capture: prompt text, reply text and reasoning, tool commands, tool output, file paths, file content and workspace path (turn off: login --client cursor --no-enrich). Developer email: not sent (turn on: login --client cursor --identity).");
  assert.equal(line(false, false, true), "Capture: metadata only (turn on prompt and reply text and tool details: login --client cursor --enrich). Developer email: sent (turn off: login --client cursor --no-identity).");
  assert.equal(line(true, false, false), "Capture: prompt text, reply text and reasoning (turn off: login --client cursor --no-enrich). Developer email: not sent (turn on: login --client cursor --identity).");
  assert.equal(line(false, true, true), "Capture: tool commands, tool output, file paths, file content and workspace path (turn off: login --client cursor --no-enrich). Developer email: sent (turn off: login --client cursor --no-identity).");
});

test("a rerun keeps the stored network settings, new values replace them, and they can be cleared", t => {
  const s = sandbox(t);
  const proxy = "http://fixture-user:fixture-pass@proxy.example.test:3128";
  s.write({ network: cursorNetworkFromEnv({ HTTPS_PROXY: proxy, NO_PROXY: "localhost,.example.test", NODE_EXTRA_CA_CERTS: "/etc/fixture/ca.pem" }) });
  assert.deepEqual(s.read().network, { httpsProxy: proxy, noProxy: "localhost,.example.test", extraCaCerts: "/etc/fixture/ca.pem" });
  s.write({ network: cursorNetworkFromEnv({}) });
  s.write();
  s.write({ network: { httpsProxy: undefined } });
  assert.deepEqual(s.read().network, { httpsProxy: proxy, noProxy: "localhost,.example.test", extraCaCerts: "/etc/fixture/ca.pem" });
  s.write({ network: { noProxy: "localhost" } });
  assert.deepEqual(s.read().network, { httpsProxy: proxy, noProxy: "localhost", extraCaCerts: "/etc/fixture/ca.pem" });
  s.write({ clearNetwork: true, network: { extraCaCerts: "/etc/fixture/new-ca.pem" } });
  assert.deepEqual(s.read().network, { extraCaCerts: "/etc/fixture/new-ca.pem" });
  s.write({ clearNetwork: true });
  assert.deepEqual(s.read().network, {});
  assert.throws(() => s.write({ network: { httpsProxy: "http://proxy\nexport X=1" } }), /invalid Cursor collector network settings/);
  assert.deepEqual(s.read().network, {}, "a refused write changes nothing");

  assert.equal(cursorProxyDisplay({}), null);
  assert.equal(cursorProxyDisplay({ httpsProxy: proxy }), "proxy.example.test:3128");
  assert.equal(cursorProxyDisplay({ httpsProxy: "fixture-user:fixture-pass@proxy.example.test:8080" }), "proxy.example.test:8080");
  assert.equal(cursorProxyDisplay({ httpsProxy: "http://[not a url" }), "configured");
  for (const shown of [proxy, "fixture-user:fixture-pass@proxy.example.test:8080", "http://[not a url"]) {
    assert.ok(!/fixture-(user|pass)/.test(cursorProxyDisplay({ httpsProxy: shown })!));
  }
});

test("network settings come from the installing environment, and an unusable value is refused by name only", () => {
  assert.deepEqual(cursorNetworkFromEnv({}), {});
  assert.deepEqual(cursorNetworkFromEnv({ https_proxy: "http://lower.example.test:1", no_proxy: "lower", HTTP_PROXY: "http://plain.example.test:2" }),
    { httpsProxy: "http://lower.example.test:1", noProxy: "lower" });
  assert.deepEqual(cursorNetworkFromEnv({ HTTPS_PROXY: "http://upper.example.test:1", https_proxy: "http://lower.example.test:1", NO_PROXY: "", no_proxy: "lower" }),
    { httpsProxy: "http://upper.example.test:1", noProxy: "lower" });
  for (const [name, value] of [["HTTPS_PROXY", "http://fixture-pass@proxy\nexport X=1"], ["NO_PROXY", "a\0b"], ["NODE_EXTRA_CA_CERTS", "/x\r"], ["https_proxy", `http://${"h".repeat(2048)}`]]) {
    assert.throws(() => cursorNetworkFromEnv({ [name!]: value }), (error: Error) => error.message.startsWith(`${name} `) && !error.message.includes("fixture-pass"));
  }
});

test("the interpreter pair is the running binary and the first node a shell would find", t => {
  const s = sandbox(t), bin = (name: string) => path.join(s.home, name);
  const place = (directory: string, mode: number) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "node"), "#!/bin/sh\n", { mode });
    return path.join(directory, "node");
  };
  place(bin("not-executable"), 0o644);
  fs.mkdirSync(path.join(bin("directory"), "node"), { recursive: true });
  const first = place(bin("first"), 0o755), second = place(bin("second"), 0o755);
  const PATH = ["relative", bin("absent"), bin("not-executable"), bin("directory"), bin("first"), bin("second")].join(path.delimiter);
  assert.deepEqual(cursorNodePaths({ execPath: "/opt/fixture/node", env: { PATH } }), { execPath: "/opt/fixture/node", commandPath: first });
  assert.deepEqual(cursorNodePaths({ execPath: first, env: { PATH } }), { execPath: first }, "the same path is recorded once");
  assert.deepEqual(cursorNodePaths({ execPath: "/opt/fixture/node", env: { PATH: [bin("second"), bin("first")].join(path.delimiter) } }).commandPath, second);
  assert.deepEqual(cursorNodePaths({ execPath: "/opt/fixture/node", env: {} }), { execPath: "/opt/fixture/node" });
  assert.deepEqual(cursorNodePaths({ execPath: "/opt/fixture/node", env: { PATH: "" } }), { execPath: "/opt/fixture/node" });
  assert.equal(cursorNodePaths({ env: { PATH: "" } }).execPath, process.execPath);
});

test("a rerun backs up the prior config privately, keeps stored paths and refreshes the interpreter", t => {
  const s = sandbox(t), custom = path.join(s.home, "custom-state"), hooks = path.join(s.home, "elsewhere", "hooks.json");
  s.write({ stateDir: custom, hooksFile: hooks, createdByConnect: true });
  const before = fs.readFileSync(s.paths.config, "utf8");
  const result = s.write({ node: { execPath: "/opt/fixture/node-v25/bin/node" } });
  assert.equal(result.created, false);
  assert.equal(result.backupPath, `${s.paths.config}.previous`);
  assert.equal(fs.readFileSync(result.backupPath!, "utf8"), before);
  assert.equal(fs.statSync(result.backupPath!).mode & 0o777, 0o600);
  const config = s.read();
  assert.deepEqual([config.stateDir, config.hooksFile, config.createdByConnect], [custom, hooks, true]);
  assert.deepEqual(config.node, { execPath: "/opt/fixture/node-v25/bin/node" }, "a stale command path is not carried over");

  fs.rmSync(result.backupPath!);
  assert.equal(s.write({ backup: false }).backupPath, null);
  assert.equal(fs.existsSync(`${s.paths.config}.previous`), false);
  const victim = path.join(s.home, "victim.txt");
  fs.writeFileSync(victim, "untouched");
  fs.symlinkSync(victim, `${s.paths.config}.previous`);
  s.write();
  assert.equal(fs.readFileSync(victim, "utf8"), "untouched", "the backup replaces a planted link instead of writing through it");
  assert.equal(fs.lstatSync(`${s.paths.config}.previous`).isFile(), true);
  for (const bad of [{ stateDir: "relative/state" }, { hooksFile: "hooks.json" }, { stateDir: "/srv/state\nx" }, { node: { execPath: "node" } },
    { node: { execPath: "/opt/node", commandPath: "bin/node" } }, { ingestEndpoint: "http://ingest.example.invalid" }, { key: "not-a-key" }]) {
    assert.throws(() => s.write(bad as any), `accepted ${JSON.stringify(bad)}`);
  }
});

test("collector state changes without touching the key or the capture choices", t => {
  const s = sandbox(t);
  s.write({ enrich: true, identity: true });
  const before = s.read();
  assert.deepEqual(updateCursorConfig(s.paths.config, { enabled: false }), { ...before, enabled: false });
  assert.deepEqual(updateCursorConfig(s.paths.config, { createdByConnect: true }), { ...before, enabled: false, createdByConnect: true });
  assert.deepEqual(updateCursorConfig(s.paths.config, {}), { ...before, enabled: false, createdByConnect: true });
  assert.deepEqual(s.read(), { ...before, enabled: false, createdByConnect: true });
  assert.equal(fs.statSync(s.paths.config).mode & 0o777, 0o600);
  assert.equal(s.write().created, false);
  assert.equal(s.read().enabled, true, "login enables collection again");
  assert.throws(() => updateCursorConfig(path.join(s.home, "absent.json"), { enabled: true }));
});

test("the key is read back only by the reader meant for it", t => {
  const s = sandbox(t);
  assert.equal(readCursorKey(s.paths.config), null);
  assert.deepEqual(readCursorSummary(s.paths.config), { exists: false, otelKeys: [], hasKey: false, collectorEnabled: false });
  s.write();
  assert.equal(readCursorKey(s.paths.config), KEY);
  const summary = readCursorSummary(s.paths.config);
  assert.deepEqual(summary, { exists: true, otelKeys: ["ingestEndpoint", "content", "identity", "hooksFile"], hasKey: true, collectorEnabled: true });
  assert.ok(!JSON.stringify(summary).includes(KEY));
  fs.writeFileSync(s.paths.config, "{ not json");
  assert.equal(readCursorKey(s.paths.config), null);
  assert.deepEqual(readCursorSummary(s.paths.config), { exists: true, otelKeys: [], hasKey: false, collectorEnabled: false });
});

test("a config that is linked, oversized or outside the contract is refused", t => {
  const s = sandbox(t);
  s.write({ network: { httpsProxy: "http://proxy.example.test:3128" } });
  const good = JSON.parse(fs.readFileSync(s.paths.config, "utf8"));
  const put = (value: unknown) => fs.writeFileSync(s.paths.config, typeof value === "string" ? value : JSON.stringify(value));
  const mutations: Array<[RegExp, (config: any) => unknown]> = [
    [/not valid JSON/, () => "{"],
    [/unsupported Cursor collector config contract/, () => "[]"],
    [/unsupported Cursor collector config contract/, c => ({ ...c, kind: "codetelemetry-kiro-v3" })],
    [/unsupported Cursor collector config contract/, c => ({ ...c, version: 2 })],
    [/not a valid CodeTelemetry ingest key/, c => ({ ...c, key: "cot_short" })],
    [/invalid Cursor collector config fields/, c => ({ ...c, enabled: "true" })],
    [/invalid Cursor collector config fields/, c => ({ ...c, createdByConnect: undefined })],
    [/invalid Cursor collector config fields/, c => ({ ...c, stateDir: "state" })],
    [/invalid Cursor collector config fields/, c => ({ ...c, stateDir: `/${"s".repeat(4096)}` })],
    [/invalid Cursor collector config fields/, c => ({ ...c, hooksFile: "/home/dev/.cursor/hooks.json\n" })],
    [/invalid Cursor collector config fields/, c => ({ ...c, content: { prompts: true } })],
    [/invalid Cursor collector config fields/, c => ({ ...c, content: { prompts: 1, toolDetails: 0 } })],
    [/invalid Cursor collector config fields/, c => ({ ...c, identity: true })],
    [/invalid Cursor collector config fields/, c => ({ ...c, identity: { email: "yes" } })],
    [/invalid Cursor ingest endpoint/, c => ({ ...c, ingestEndpoint: "http://ingest.example.invalid" })],
    [/invalid Cursor ingest endpoint/, c => ({ ...c, ingestEndpoint: "https://user:pass@ingest.example.invalid" })],
    [/invalid Cursor ingest endpoint/, c => ({ ...c, ingestEndpoint: "https://ingest.example.invalid/?x=1" })],
    [/invalid Cursor ingest endpoint/, c => ({ ...c, ingestEndpoint: 7 })],
    [/invalid Cursor collector network settings/, c => ({ ...c, network: null })],
    [/invalid Cursor collector network settings/, c => ({ ...c, network: { httpsProxy: "" } })],
    [/invalid Cursor collector network settings/, c => ({ ...c, network: { noProxy: "a\nb" } })],
    [/invalid Cursor collector network settings/, c => ({ ...c, network: { extraCaCerts: 7 } })],
    [/invalid Cursor collector Node.js path/, c => ({ ...c, node: { execPath: "node" } })],
    [/invalid Cursor collector Node.js path/, c => ({ ...c, node: { execPath: "/opt/node", commandPath: "/opt/no\0de" } })],
    [/invalid Cursor collector Node.js path/, c => ({ ...c, node: undefined })],
    [/unreadable or exceeds bound/, c => JSON.stringify(c).padEnd(CURSOR_CONFIG_BYTES + 1, " ")],
  ];
  for (const [message, mutate] of mutations) {
    put(mutate(structuredClone(good)));
    assert.throws(() => readCursorConfig(s.paths.config), message);
    assert.throws(() => s.write(), message, "a config that cannot be read is not overwritten");
  }
  put({ ...good, extra: "ignored", network: { ...good.network, unknown: "dropped" } });
  assert.deepEqual(readCursorConfig(s.paths.config), good, "unknown fields are not carried into the collector");

  const target = path.join(s.home, "real-config.json");
  fs.renameSync(s.paths.config, target);
  fs.symlinkSync(target, s.paths.config);
  assert.throws(() => readCursorConfig(s.paths.config), /unreadable or exceeds bound/);
  assert.equal(readCursorKey(s.paths.config), null);
});

test("an owned file is replaced in one rename, with the requested mode and without following a planted temporary", t => {
  const s = sandbox(t), file = path.join(s.home, "owned.txt"), victim = path.join(s.home, "victim.txt");
  fs.writeFileSync(victim, "untouched");
  fs.symlinkSync(victim, `${file}.tmp`);
  const mask = process.umask(0o077);
  try {
    writeCursorFileAtomic(file, "first", 0o755);
  } finally {
    process.umask(mask);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "first");
  assert.equal(fs.statSync(file).mode & 0o777, 0o755, "the mode does not depend on the umask");
  assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
  const inode = fs.statSync(file).ino;
  writeCursorFileAtomic(file, Buffer.from("second"), 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(fs.statSync(file).ino, inode, "a reader sees the old file or the new one, never a partial write");
  assert.deepEqual(fs.readdirSync(s.home).sort(), ["owned.txt", "victim.txt"]);
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => writeCursorFileAtomic(file, "third", 0o600), /cannot replace/);
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  assert.throws(() => writeCursorFileAtomic(path.join(s.home, "absent-directory", "f"), "x", 0o600));
});
