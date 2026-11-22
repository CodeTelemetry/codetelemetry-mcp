// Loaded here as well as by the test scripts, so this file cannot reach the
// real home directory however it is run. Nothing below calls a real service
// manager: every start, stop and probe goes through a recording fake.
import "../support/isolateHome.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { collectorServiceManager, collectorUnitPath, installCollectorRuntime, ownedCollectorUnit, removeCollectorUnit, renderCollectorService,
  startCollectorService, stopCollectorService, writeCollectorUnit, type CollectorServiceHost, type CollectorServiceSpec } from "../../src/client/collector/service.ts";
import { CURSOR_EARLY_EXIT_SECONDS, cursorCollectorLauncher } from "../../src/client/cursor/hookProgram.ts";
import { CURSOR_SERVICE } from "../../src/client/cursor/preflight.ts";
import { spawn } from "node:child_process";
import { writeKiroConfig } from "../../src/client/kiro/config.ts";
import { disableKiroService, enableKiroService, renderKiroService, uninstallKiroService } from "../../src/client/kiro/service.ts";

const CURSOR: CollectorServiceSpec = {marker: "CodeTelemetry Cursor hooks collector v1", linuxName: "codetelemetry-cursor-hooks.service",
  macName: "com.codetelemetry.cursor-hooks", description: "CodeTelemetry Cursor hooks telemetry", label: "Cursor"};
const share = "/home/dev/.local/share/codetelemetry/cursor-hooks-v1";
const launcher = {program: "/bin/sh", args: [`${share}/collector.sh`]};
function scratch(t: TestContext, name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
function recorder(home: string, platform: NodeJS.Platform, fails: (line: string) => boolean = () => false) {
  const calls: string[] = [];
  const host: CollectorServiceHost = {home, platform, uid: 501, execute: (command, args) => {
    const line = [command, ...args].join(" ").replaceAll(home, "<home>");
    calls.push(line);
    if (fails(line)) throw new Error("service manager refused");
    return "";
  }};
  return {calls, host};
}
const mode = (file: string) => fs.lstatSync(file).mode & 0o777;

test("the unit and the plist run /bin/sh on the launcher and name no Node.js binary", () => {
  const unit = renderCollectorService(CURSOR, "linux", launcher);
  assert.equal(unit, `# CodeTelemetry Cursor hooks collector v1
[Unit]
Description=CodeTelemetry Cursor hooks telemetry
After=network.target

[Service]
Type=simple
ExecStart="/bin/sh" "/home/dev/.local/share/codetelemetry/cursor-hooks-v1/collector.sh"
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`);
  const plist = renderCollectorService(CURSOR, "darwin", launcher);
  assert.equal(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- CodeTelemetry Cursor hooks collector v1 -->
<plist version="1.0"><dict><key>Label</key><string>com.codetelemetry.cursor-hooks</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>/home/dev/.local/share/codetelemetry/cursor-hooks-v1/collector.sh</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer></dict></plist>
`);
  for (const text of [unit, plist]) {
    assert.doesNotMatch(text, /node/i);
    assert.equal(text.includes(process.execPath), false);
    assert.equal(text.includes(path.dirname(process.execPath)), false);
  }
});

test("the Cursor service waits a minute before a failed collector is started again; the default stays five seconds", () => {
  // Most failed starts stay failed until someone acts: a state file from a
  // newer release, settings that are gone, a second collector holding the lock.
  const unit = renderCollectorService(CURSOR_SERVICE, "linux", launcher), plist = renderCollectorService(CURSOR_SERVICE, "darwin", launcher);
  assert.match(unit, /^Restart=on-failure\nRestartSec=60\n/m);
  assert.doesNotMatch(unit, /RestartSteps|RestartMaxDelaySec/, "only options every systemd release knows");
  assert.ok(plist.includes("<key>ThrottleInterval</key><integer>60</integer>"));
  // Everything else is the definition the generic spec renders.
  assert.equal(unit, renderCollectorService(CURSOR, "linux", launcher).replace("RestartSec=5\n", "RestartSec=60\n"));
  assert.equal(plist, renderCollectorService(CURSOR, "darwin", launcher).replace("<integer>5</integer>", "<integer>60</integer>"));
  assert.deepEqual({...CURSOR_SERVICE, restartSeconds: undefined}, {...CURSOR, restartSeconds: undefined});
  for (const restartSeconds of [0, -1, 1.5, 3601, Number.NaN]) {
    assert.throws(() => renderCollectorService({...CURSOR, restartSeconds}, "linux", launcher), {message: "invalid Cursor service definition"});
  }
});

test("paths are quoted and escaped for each service manager; anything else is refused", () => {
  const awkward = {program: "/bin/sh", args: ["/home/a\"b\\c/100%/$HOME/it's <x>&y/collector.sh"]};
  assert.match(renderCollectorService(CURSOR, "linux", awkward), /^ExecStart="\/bin\/sh" "\/home\/a\\"b\\\\c\/100%%\/\$\$HOME\/it's <x>&y\/collector\.sh"$/m);
  assert.ok(renderCollectorService(CURSOR, "darwin", awkward).includes("<string>/home/a&quot;b\\c/100%/$HOME/it&apos;s &lt;x&gt;&amp;y/collector.sh</string>"));
  assert.match(renderCollectorService(CURSOR, "linux", {program: "/bin/sh", args: ["/x/run.sh", {literal: "collect"}, {literal: "--once"}]}), /^ExecStart="\/bin\/sh" "\/x\/run\.sh" collect --once$/m);
  for (const command of [{program: "sh", args: ["/x/collector.sh"]}, {program: "/bin/sh", args: ["collector.sh"]}, {program: "/bin/sh", args: ["/x/col\nlector.sh"]},
    {program: "/bin/sh", args: ["/x/" + "y".repeat(4096)]}, {program: "/bin/sh", args: [{literal: "two words"}]}, {program: "/bin/sh", args: [{literal: "$(id)"}]},
    {program: "/bin/sh", args: [{literal: ""}]}, {program: "/bin/sh", args: Array.from({length: 16}, () => "/x")}]) {
    assert.throws(() => renderCollectorService(CURSOR, "linux", command), /invalid Cursor service (path|argument)/);
    assert.throws(() => renderCollectorService(CURSOR, "darwin", command), /invalid Cursor service (path|argument)/);
  }
  assert.throws(() => renderCollectorService(CURSOR, "win32", launcher), /Cursor background installation currently supports Linux and macOS/);
  for (const broken of [{marker: "two\nlines"}, {marker: "ends -- comment"}, {description: "x\n[Service]"}, {linuxName: "../escape.service"}, {linuxName: "name.timer"}, {macName: "com/escape"}]) {
    assert.throws(() => renderCollectorService({...CURSOR, ...broken}, "linux", launcher), /invalid Cursor service definition/);
    assert.throws(() => collectorUnitPath({...CURSOR, ...broken}, {home: "/home/dev", platform: "linux"}), /invalid Cursor service definition/);
  }
});

test("Kiro's unit and plist text are byte-identical to the released ones", () => {
  const node = "/opt/node dir/bin/node", entry = "/home/a\"b/.local/share/codetelemetry/kiro-v3/runtime-0123456789abcdef/bin.js";
  const config = "/home/a&b/100%/it's <x>/$HOME/kiro-v3.json";
  assert.equal(renderKiroService("linux", node, entry, config),
    "# CodeTelemetry Kiro V3 collector v1\n[Unit]\nDescription=CodeTelemetry Kiro V3 telemetry\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=\"/opt/node dir/bin/node\" \"/home/a\\\"b/.local/share/codetelemetry/kiro-v3/runtime-0123456789abcdef/bin.js\" kiro collect --settings \"/home/a&b/100%%/it's <x>/$HOME/kiro-v3.json\"\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n");
  assert.equal(renderKiroService("darwin", node, entry, config),
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<!-- CodeTelemetry Kiro V3 collector v1 -->\n<plist version=\"1.0\"><dict><key>Label</key><string>com.codetelemetry.kiro-v3</string><key>ProgramArguments</key><array><string>/opt/node dir/bin/node</string><string>/home/a&quot;b/.local/share/codetelemetry/kiro-v3/runtime-0123456789abcdef/bin.js</string><string>kiro</string><string>collect</string><string>--settings</string><string>/home/a&amp;b/100%/it&apos;s &lt;x&gt;/$HOME/kiro-v3.json</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer></dict></plist>\n");
  assert.throws(() => renderKiroService("win32", node, entry, config), {message: "Kiro background installation currently supports Linux and macOS; foreground collection remains available"});
  for (const [n, e, c] of [["node", entry, config], [node, "bin.js", config], [node, entry, "kiro-v3.json"], [node, entry + "\n", config]]) {
    assert.throws(() => renderKiroService("linux", n, e, c), {message: "invalid Kiro service path"});
  }
});

test("Kiro's service calls, results and files are what they were", async t => {
  const home = scratch(t, "kiro-service-pin"), file = path.join(home, "kiro.json"), source = path.join(home, "runtime-source");
  writeKiroConfig({configPath: file, key: "cot_synthetic_service_test_0000000000", ingestEndpoint: "https://ingest.example.test"});
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "bin.ts"), "export {};\n");
  const options = (platform: NodeJS.Platform, fails?: (line: string) => boolean) => {
    const {calls, host} = recorder(home, platform, fails);
    return {calls, opts: {home, platform, runtimeSource: source, node: "/usr/local/bin/node", execute: host.execute}};
  };
  const linux = options("linux");
  assert.deepEqual(await enableKiroService(file, linux.opts), {ok: true, detail: "Kiro background collector service enabled. Check kiro status for source coverage and delivery health."});
  assert.deepEqual(linux.calls, ["systemctl --user daemon-reload", "systemctl --user enable codetelemetry-kiro-v3.service", "systemctl --user restart codetelemetry-kiro-v3.service"]);
  const unit = path.join(home, ".config/systemd/user/codetelemetry-kiro-v3.service");
  const runtime = fs.readdirSync(path.join(home, ".local/share/codetelemetry/kiro-v3"));
  assert.equal(runtime.length, 1); assert.match(runtime[0], /^runtime-[a-f0-9]{16}$/);
  assert.equal(fs.readFileSync(unit, "utf8"), renderKiroService("linux", "/usr/local/bin/node", path.join(home, ".local/share/codetelemetry/kiro-v3", runtime[0], "bin.ts"), file));
  assert.equal(mode(unit), 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(unit)), ["codetelemetry-kiro-v3.service"]);
  const refused = options("linux", line => line.includes("disable"));
  assert.deepEqual(disableKiroService(file, refused.opts), {ok: false, detail: "Collection disabled in config; service manager stop could not be confirmed."});
  assert.deepEqual(uninstallKiroService(file, refused.opts), {ok: false, detail: "Collection disabled in config; service manager stop could not be confirmed."});
  assert.equal(fs.existsSync(unit), true);
  const removal = options("linux");
  assert.deepEqual(uninstallKiroService(file, removal.opts), {ok: true, detail: "Kiro service uninstalled. Private config, bounded runtime and recovery state are preserved for deliberate recovery or removal."});
  assert.deepEqual(removal.calls, ["systemctl --user disable --now codetelemetry-kiro-v3.service", "systemctl --user daemon-reload"]);
  assert.equal(fs.existsSync(unit), false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).enabled, false);
  // macOS: a failed bootout stays an error for Kiro, loaded or not.
  const mac = options("darwin");
  assert.equal((await enableKiroService(file, mac.opts)).ok, true);
  const uid = process.getuid?.() ?? 0, plist = path.join(home, "Library/LaunchAgents/com.codetelemetry.kiro-v3.plist");
  assert.deepEqual(mac.calls, [`launchctl bootout gui/${uid}/com.codetelemetry.kiro-v3`, `launchctl enable gui/${uid}/com.codetelemetry.kiro-v3`,
    `launchctl bootstrap gui/${uid} <home>/Library/LaunchAgents/com.codetelemetry.kiro-v3.plist`]);
  assert.equal(mode(plist), 0o600);
  const stuck = options("darwin", line => line.includes("bootout") || line.includes("print"));
  assert.equal(disableKiroService(file, stuck.opts).ok, false);
  assert.deepEqual(stuck.calls, [`launchctl bootout gui/${uid}/com.codetelemetry.kiro-v3`]);
  // An unrecognized definition is never replaced, stopped or removed.
  fs.writeFileSync(plist, "<plist><dict><key>Label</key><string>mine</string></dict></plist>\n");
  await assert.rejects(enableKiroService(file, options("darwin").opts), {message: "refusing to replace an unrecognized Kiro service definition"});
  assert.throws(() => disableKiroService(file, options("darwin").opts), {message: "refusing to replace an unrecognized Kiro service definition"});
  assert.equal(fs.readFileSync(plist, "utf8"), "<plist><dict><key>Label</key><string>mine</string></dict></plist>\n");
  // Kiro keeps its bounded retention: it refuses instead of pruning.
  const runtimeDir = path.join(home, ".local/share/codetelemetry/kiro-v3");
  for (let i = 0; i < 8; i++) fs.mkdirSync(path.join(runtimeDir, `runtime-${String(i).repeat(16)}`));
  await assert.rejects(enableKiroService(file, options("linux").opts), {message: "Kiro runtime retention capacity exceeded"});
  assert.equal(fs.readdirSync(runtimeDir).length, 9);
});

test("install, start, stop and remove go through the injected runner and touch only our definition", t => {
  const home = scratch(t, "collector-service"), body = renderCollectorService(CURSOR, "linux", launcher);
  const linux = recorder(home, "linux");
  const unit = path.join(home, ".config/systemd/user/codetelemetry-cursor-hooks.service");
  assert.equal(collectorUnitPath(CURSOR, linux.host), unit);
  assert.equal(ownedCollectorUnit(CURSOR, unit), false);
  assert.equal(writeCollectorUnit(CURSOR, linux.host, body), unit);
  assert.equal(fs.readFileSync(unit, "utf8"), body);
  assert.equal(mode(unit), 0o600); assert.equal(mode(path.dirname(unit)), 0o700);
  assert.equal(ownedCollectorUnit(CURSOR, unit), true);
  assert.deepEqual(linux.calls, [], "writing the definition starts nothing");
  startCollectorService(CURSOR, linux.host);
  stopCollectorService(CURSOR, linux.host);
  assert.equal(removeCollectorUnit(CURSOR, linux.host), true);
  assert.equal(removeCollectorUnit(CURSOR, linux.host), false);
  assert.deepEqual(linux.calls, ["systemctl --user daemon-reload", "systemctl --user enable codetelemetry-cursor-hooks.service", "systemctl --user restart codetelemetry-cursor-hooks.service",
    "systemctl --user disable --now codetelemetry-cursor-hooks.service", "systemctl --user daemon-reload", "systemctl --user daemon-reload"]);
  assert.equal(fs.existsSync(unit), false);
  // A crash leftover is replaced and a loose mode is tightened.
  fs.writeFileSync(`${unit}.tmp`, "partial"); fs.writeFileSync(unit, `# ${CURSOR.marker}\nold\n`, {mode: 0o644});
  writeCollectorUnit(CURSOR, linux.host, body);
  assert.equal(fs.readFileSync(unit, "utf8"), body); assert.equal(mode(unit), 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(unit)), ["codetelemetry-cursor-hooks.service"]);
  const failing = recorder(home, "linux", line => line.includes("restart"));
  assert.throws(() => startCollectorService(CURSOR, failing.host), /service manager refused/);
  assert.equal(fs.readFileSync(unit, "utf8"), body, "a refused start leaves the definition in place");
  fs.unlinkSync(unit);

  const mac = recorder(home, "darwin");
  const plist = path.join(home, "Library/LaunchAgents/com.codetelemetry.cursor-hooks.plist");
  assert.equal(writeCollectorUnit(CURSOR, mac.host, renderCollectorService(CURSOR, "darwin", launcher)), plist);
  assert.equal(mode(plist), 0o600);
  startCollectorService(CURSOR, mac.host);
  stopCollectorService(CURSOR, mac.host);
  assert.equal(removeCollectorUnit(CURSOR, mac.host), true);
  assert.deepEqual(mac.calls, ["launchctl bootout gui/501/com.codetelemetry.cursor-hooks", "launchctl enable gui/501/com.codetelemetry.cursor-hooks",
    "launchctl bootstrap gui/501 <home>/Library/LaunchAgents/com.codetelemetry.cursor-hooks.plist", "launchctl bootout gui/501/com.codetelemetry.cursor-hooks"]);
  const first = recorder(home, "darwin", line => line.includes("bootout"));
  assert.doesNotThrow(() => startCollectorService(CURSOR, first.host), "nothing is loaded on a first start");
  // bootout also fails for an agent that is not loaded: that is a completed stop.
  const idle = recorder(home, "darwin", line => line.includes("bootout") || line.includes("print"));
  assert.doesNotThrow(() => stopCollectorService(CURSOR, idle.host));
  assert.deepEqual(idle.calls, ["launchctl bootout gui/501/com.codetelemetry.cursor-hooks", "launchctl print gui/501/com.codetelemetry.cursor-hooks"]);
  const loaded = recorder(home, "darwin", line => line.includes("bootout"));
  assert.throws(() => stopCollectorService(CURSOR, loaded.host), /service manager refused/);
  assert.throws(() => stopCollectorService({...CURSOR, legacy: true}, idle.host), /service manager refused/);

  const windows = recorder(home, "win32");
  assert.throws(() => startCollectorService(CURSOR, windows.host), /Cursor background installation currently supports Linux and macOS/);
  stopCollectorService(CURSOR, windows.host);
  assert.deepEqual(windows.calls, []);
});

test("a definition that is not ours is refused and left exactly as it was", t => {
  const home = scratch(t, "collector-foreign"), {calls, host} = recorder(home, "linux");
  const unit = collectorUnitPath(CURSOR, host), body = renderCollectorService(CURSOR, "linux", launcher);
  const refusal = {message: "refusing to replace an unrecognized Cursor service definition"};
  fs.mkdirSync(path.dirname(unit), {recursive: true});
  fs.writeFileSync(unit, "[Unit]\nDescription=someone else's unit\n");
  for (const act of [() => writeCollectorUnit(CURSOR, host, body), () => removeCollectorUnit(CURSOR, host), () => ownedCollectorUnit(CURSOR, unit)]) assert.throws(act, refusal);
  assert.equal(fs.readFileSync(unit, "utf8"), "[Unit]\nDescription=someone else's unit\n");
  fs.unlinkSync(unit);
  // A symlink is refused even when its target carries the marker, and stays a link.
  const elsewhere = path.join(home, "dotfiles-unit");
  fs.writeFileSync(elsewhere, `# ${CURSOR.marker}\n`); fs.symlinkSync(elsewhere, unit);
  assert.throws(() => writeCollectorUnit(CURSOR, host, body), refusal);
  assert.equal(fs.lstatSync(unit).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(elsewhere, "utf8"), `# ${CURSOR.marker}\n`);
  fs.unlinkSync(unit); fs.symlinkSync(path.join(home, "missing-target"), unit);
  assert.throws(() => writeCollectorUnit(CURSOR, host, body), refusal);
  assert.equal(fs.existsSync(path.join(home, "missing-target")), false, "a dangling link is not written through");
  fs.unlinkSync(unit);
  fs.writeFileSync(unit, `# ${CURSOR.marker}\n` + "#".repeat(16 * 1024));
  assert.throws(() => writeCollectorUnit(CURSOR, host, body), refusal);
  fs.unlinkSync(unit); fs.mkdirSync(unit);
  assert.throws(() => writeCollectorUnit(CURSOR, host, body), refusal);
  assert.deepEqual(calls, []);
});

test("the service manager probe uses the injected runner and never guesses", () => {
  const linux = recorder("/home/dev", "linux");
  assert.deepEqual(collectorServiceManager(linux.host), {available: true, manager: "systemd"});
  assert.deepEqual(linux.calls, ["systemctl --user show-environment"]);
  assert.deepEqual(collectorServiceManager(recorder("/home/dev", "linux", () => true).host), {available: false, manager: "systemd"});
  const mac = recorder("/home/dev", "darwin");
  assert.deepEqual(collectorServiceManager(mac.host), {available: true, manager: "launchd"});
  assert.deepEqual(mac.calls, ["launchctl version"]);
  assert.deepEqual(collectorServiceManager(recorder("/home/dev", "darwin", () => true).host), {available: false, manager: "launchd"});
  const windows = recorder("/home/dev", "win32");
  assert.deepEqual(collectorServiceManager(windows.host), {available: false, manager: null});
  assert.deepEqual(windows.calls, []);
});

test("the runtime copy is atomic, verified, and keeps only the current and the previous install", t => {
  const root = scratch(t, "collector-runtime"), source = path.join(root, "source"), runtimeDir = path.join(root, "share");
  fs.mkdirSync(path.join(source, "cursor"), {recursive: true});
  const version = (text: string) => fs.writeFileSync(path.join(source, "bin.ts"), `export const version = ${JSON.stringify(text)};\n`);
  version("one");
  fs.writeFileSync(path.join(source, "cursor", "command.ts"), "export {};\n");
  fs.writeFileSync(path.join(source, "cursor", "types.d.ts"), "export {};\n");
  fs.writeFileSync(path.join(source, "README.md"), "not runtime\n");
  let now = Date.parse("2026-11-21T10:00:00Z");
  const install = () => installCollectorRuntime(CURSOR, {runtimeDir, runtimeSource: source, extension: ".ts", now: () => now});
  const runtimes = () => fs.readdirSync(runtimeDir).filter(name => name.startsWith("runtime-")).sort();
  const one = install();
  assert.match(path.basename(one.root), /^runtime-[a-f0-9]{16}$/);
  assert.equal(one.entry, path.join(one.root, "bin.ts"));
  assert.deepEqual(fs.readdirSync(one.root, {recursive: true}).map(String).sort(), ["bin.ts", "cursor", "cursor/command.ts", "package.json"]);
  assert.equal(fs.readFileSync(path.join(one.root, "package.json"), "utf8"), '{"type":"module"}\n');
  assert.equal(mode(runtimeDir), 0o700); assert.equal(mode(one.root), 0o700); assert.equal(mode(one.entry), 0o600);
  const inode = fs.statSync(one.entry).ino;
  assert.deepEqual(install(), one); assert.equal(fs.statSync(one.entry).ino, inode, "an intact runtime is not rewritten");
  // The launcher files, a lock and an unrelated directory live beside the runtimes and are never pruned.
  for (const name of ["hook.sh", "hook.cjs", "collector.sh", "collector.lock"]) fs.writeFileSync(path.join(runtimeDir, name), name);
  fs.mkdirSync(path.join(runtimeDir, "runtime-notes"));
  now += 60_000; version("two"); const two = install();
  assert.deepEqual(runtimes(), [one.root, two.root].map(file => path.basename(file)).concat("runtime-notes").sort());
  now += 60_000; version("three"); const three = install();
  assert.equal(fs.existsSync(one.root), false, "the oldest runtime is removed");
  assert.equal(fs.existsSync(two.root), true); assert.equal(fs.existsSync(three.root), true);
  // "Previous" is the latest install, not the newest directory: reinstalling
  // version two makes it current, so version three is the one to keep.
  now += 60_000; version("two"); assert.deepEqual(install(), two);
  now += 60_000; version("four"); const four = install();
  assert.equal(fs.existsSync(two.root), true); assert.equal(fs.existsSync(three.root), false); assert.equal(fs.existsSync(four.root), true);
  for (const name of ["hook.sh", "hook.cjs", "collector.sh", "collector.lock"]) assert.equal(fs.readFileSync(path.join(runtimeDir, name), "utf8"), name);
  assert.equal(fs.existsSync(path.join(runtimeDir, "runtime-notes")), true);
  // Leftovers of an interrupted build, the current one included, are cleared.
  fs.mkdirSync(`${four.root}.tmp`); fs.writeFileSync(path.join(`${four.root}.tmp`, "bin.ts"), "partial");
  fs.mkdirSync(path.join(runtimeDir, "runtime-00000000000000aa.tmp"));
  now += 60_000; install();
  assert.deepEqual(fs.readdirSync(runtimeDir).filter(name => name.endsWith(".tmp")), []);
  // A damaged copy is rebuilt for a new collector and refused for Kiro.
  fs.writeFileSync(four.entry, "tampered");
  assert.throws(() => installCollectorRuntime({label: "Kiro", legacy: true}, {runtimeDir, runtimeSource: source, extension: ".ts"}), {message: "Kiro runtime integrity mismatch"});
  assert.equal(fs.readFileSync(four.entry, "utf8"), "tampered");
  now += 60_000; install();
  assert.equal(fs.readFileSync(four.entry, "utf8"), 'export const version = "four";\n');
  fs.rmSync(path.join(four.root, "cursor"), {recursive: true}); install();
  assert.equal(fs.existsSync(path.join(four.root, "cursor", "command.ts")), true);
});

test("the runtime source is bounded and may hold no symlink", t => {
  const root = scratch(t, "collector-runtime-bounds"), source = path.join(root, "source"), runtimeDir = path.join(root, "share");
  const install = () => installCollectorRuntime(CURSOR, {runtimeDir, runtimeSource: source, extension: ".ts"});
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "other.ts"), "export {};\n");
  assert.throws(install, {message: "Cursor runtime entry is missing"});
  fs.writeFileSync(path.join(source, "bin.ts"), "export {};\n"); fs.symlinkSync("bin.ts", path.join(source, "link.ts"));
  assert.throws(install, {message: "Cursor runtime cannot contain symlinks"});
  fs.unlinkSync(path.join(source, "link.ts")); fs.writeFileSync(path.join(source, "large.ts"), "x".repeat(256 * 1024 + 1));
  assert.throws(install, {message: "Cursor runtime file exceeds bound"});
  fs.unlinkSync(path.join(source, "large.ts")); fs.mkdirSync(path.join(source, "a/b/c/d/e/f"), {recursive: true});
  assert.throws(install, {message: "Cursor runtime directory depth exceeds bound"});
  assert.equal(fs.existsSync(runtimeDir), false, "nothing is written when the source is refused");
});

// collector.sh, the command the unit above runs, is rendered by the Cursor
// modules. It is run here by /bin/sh against scratch directories. Its
// interpreters are this Node.js binary, the same binary reporting an older
// version, and paths that do not exist; its "runtime entry" records how it was
// started instead of collecting anything.
type Launch = {execPath: string; commandPath?: string; network?: {httpsProxy?: string; noProxy?: string; extraCaCerts?: string}};
function launcherFixture(t: TestContext) {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const root = scratch(t, "collector launcher it's"), state = path.join(root, "state dir"), entry = path.join(root, "runtime", "bin.cjs");
  fs.mkdirSync(state); fs.mkdirSync(path.dirname(entry));
  fs.writeFileSync(entry, `require("node:fs").writeFileSync(require("node:path").join(__dirname, "started.json"), JSON.stringify({args: process.argv.slice(2), node: process.versions.node,
  env: Object.fromEntries(["HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"].map(name => [name, process.env[name] ?? null])),
  proxy: Object.fromEntries(Object.entries(process.env).filter(([name]) => /proxy/i.test(name)))}));\n`);
  const preload = path.join(root, "old.cjs"), old = path.join(root, "old-node");
  fs.writeFileSync(preload, 'Object.defineProperty(process.versions, "node", {value: "22.11.0"});\n');
  fs.writeFileSync(old, `#!/bin/sh\nexec ${quote(process.execPath)} -r ${quote(preload)} "$@"\n`, {mode: 0o700});
  const config = path.join(root, "cursor-hooks-v1.json"), record = path.join(path.dirname(entry), "started.json");
  const run = (launch: Launch, inherited: Record<string, string> = {}) => {
    const script = path.join(root, "collector.sh");
    fs.writeFileSync(script, cursorCollectorLauncher({stateDir: state, node: {execPath: launch.execPath, commandPath: launch.commandPath},
      entry, configPath: config, network: launch.network, retrySeconds: 1, failureSeconds: 1}), {mode: 0o700});
    fs.rmSync(record, {force: true});
    const started = Date.now();
    const result = spawnSync("/bin/sh", [script], {encoding: "utf8", timeout: 60_000, env: {PATH: "/usr/bin:/bin", HOME: os.homedir(), ...inherited}});
    return {status: result.status, stdout: result.stdout, elapsedMs: Date.now() - started,
      started: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : null, stale: fs.existsSync(path.join(state, "node-stale"))};
  };
  return {root, state, entry, old, config, run, missing: path.join(root, "removed", "bin", "node"), expected: ["cursor", "collect", "--settings", config]};
}

test("with every interpreter missing the launcher marks the state stale, waits, and exits 1", t => {
  const f = launcherFixture(t);
  const text = cursorCollectorLauncher({stateDir: f.state, node: {execPath: f.missing}, entry: f.entry, configPath: f.config});
  assert.ok(text.startsWith(`#!/bin/sh\n# ${CURSOR.marker}\n`));
  assert.match(text, /^sleep 300$/m, "five minutes between attempts unless a shorter wait is injected");
  const none = f.run({execPath: f.missing, commandPath: path.join(f.root, "also-removed", "node")});
  assert.equal(none.status, 1); assert.equal(none.started, null); assert.equal(none.stale, true); assert.equal(none.stdout, "");
  assert.ok(none.elapsedMs >= 900, `the wait was ${none.elapsedMs} ms`);
  // A state directory that is gone must not cut the wait short or change the
  // status: the service manager would otherwise restart the launcher at once.
  fs.rmSync(f.state, {recursive: true});
  const gone = f.run({execPath: f.missing});
  assert.equal(gone.status, 1); assert.equal(gone.started, null);
  assert.ok(gone.elapsedMs >= 900, `the wait was ${gone.elapsedMs} ms`);
});

test("a collector that fails at start is passed on only after a wait; a clean exit and a requested stop are passed on at once", async t => {
  const f = launcherFixture(t), marker = path.join(f.root, "stopped");
  const text = cursorCollectorLauncher({stateDir: f.state, node: {execPath: process.execPath}, entry: f.entry, configPath: f.config});
  assert.match(text, new RegExp(`-lt ${CURSOR_EARLY_EXIT_SECONDS} \\]; then sleep 60; fi$`, "m"), "a minute unless a shorter wait is injected");
  assert.equal(CURSOR_EARLY_EXIT_SECONDS, 10);
  assert.doesNotMatch(text, /^\s*exec /m, "the shell stays to hold a failed start back");
  for (const failureSeconds of [0, 3601, 1.5]) {
    assert.throws(() => cursorCollectorLauncher({stateDir: f.state, node: {execPath: process.execPath}, entry: f.entry, configPath: f.config, failureSeconds}), /retry wait/);
  }
  const collector = (body: string) => fs.writeFileSync(f.entry, body);
  // What a newer checkpoint, missing settings or a held lock end in: an exit of 1 within moments.
  for (const [body, status] of [["process.exit(1)", 1], ["throw new Error('unsupported Cursor checkpoint contract')", 1], ["process.exit(2)", 1], ["process.exit(7)", 7]] as const) {
    collector(body);
    const failed = f.run({execPath: process.execPath});
    assert.equal(failed.status, status, body);
    assert.ok(failed.elapsedMs >= 900, `${body}: restarted after only ${failed.elapsedMs} ms`);
    assert.equal(failed.stale, false);
  }
  collector("process.exit(0)");
  const clean = f.run({execPath: process.execPath});
  assert.equal(clean.status, 0);
  assert.ok(clean.elapsedMs < 900, `a clean exit waited ${clean.elapsedMs} ms`);

  // A stop request reaches the collector, and its exit is passed on without the wait, whatever its status.
  const script = path.join(f.root, "collector.sh");
  for (const status of [0, 1]) {
    collector(`process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => process.exit(${status}), 50); });
setInterval(() => {}, 1000); process.stdout.write("up\\n");`);
    fs.writeFileSync(script, cursorCollectorLauncher({stateDir: f.state, node: {execPath: process.execPath}, entry: f.entry, configPath: f.config, failureSeconds: 30}), {mode: 0o700});
    fs.rmSync(marker, {force: true});
    const child = spawn("/bin/sh", [script], {env: {PATH: "/usr/bin:/bin", HOME: os.homedir()}, stdio: ["ignore", "pipe", "ignore"]});
    const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await new Promise(resolve => child.stdout.once("data", resolve));
    const asked = Date.now();
    child.kill("SIGTERM");
    const exit = await new Promise<{code: number | null; signal: string | null}>(resolve => child.on("exit", (code, signal) => resolve({code, signal})));
    clearTimeout(guard);
    assert.deepEqual(exit, {code: status, signal: null}, `the collector's own status ${status} is the launcher's`);
    assert.ok(fs.existsSync(marker), "the collector was asked to stop, not killed with the shell");
    assert.ok(Date.now() - asked < 5000, "no wait after a requested stop");
  }
});

test("the launcher starts the collector on the first usable interpreter, in order", t => {
  const f = launcherFixture(t);
  const recorded = f.run({execPath: process.execPath, commandPath: f.missing});
  assert.equal(recorded.status, 0); assert.deepEqual(recorded.started.args, f.expected);
  assert.equal(recorded.started.node, process.versions.node); assert.equal(recorded.stale, false);
  const second = f.run({execPath: f.missing, commandPath: process.execPath});
  assert.equal(second.status, 0); assert.deepEqual(second.started.args, f.expected); assert.equal(second.stale, false);
  // Only the path a hook discovered is valid.
  fs.writeFileSync(path.join(f.state, "node-path"), `${process.execPath}\n`);
  const discovered = f.run({execPath: f.missing});
  assert.equal(discovered.status, 0); assert.deepEqual(discovered.started.args, f.expected); assert.equal(discovered.stale, false);
  // Only an absolute path is ever run from that file.
  fs.writeFileSync(path.join(f.state, "node-path"), "node\n");
  const relative = f.run({execPath: f.missing});
  assert.equal(relative.status, 1); assert.equal(relative.started, null); assert.equal(relative.stale, true);
});

test("an interpreter older than the minimum is skipped", t => {
  const f = launcherFixture(t);
  const check = spawnSync(f.old, ["-p", "process.versions.node"], {encoding: "utf8", env: {PATH: "/usr/bin:/bin", HOME: os.homedir()}});
  assert.equal(check.stdout.trim(), "22.11.0", "the stand-in reports the older version");
  const skipped = f.run({execPath: f.old, commandPath: process.execPath});
  assert.equal(skipped.status, 0); assert.equal(skipped.started.node, process.versions.node); assert.equal(skipped.stale, false);
  fs.writeFileSync(path.join(f.state, "node-path"), `${f.old}\n`);
  const only = f.run({execPath: f.old});
  assert.equal(only.status, 1, "a recorded and a discovered interpreter are both checked"); assert.equal(only.started, null); assert.equal(only.stale, true);
});

test("recorded network settings are exported single-quoted and reach the collector unchanged", t => {
  const f = launcherFixture(t), ca = path.join(f.root, "corp ca.pem");
  fs.writeFileSync(ca, "");
  const network = {httpsProxy: "http://user:it's $HOME `id` \"x\"@proxy.example.test:3128", noProxy: "localhost,.example.test", extraCaCerts: ca};
  const text = cursorCollectorLauncher({stateDir: f.state, node: {execPath: process.execPath}, entry: f.entry, configPath: f.config, network});
  assert.ok(text.includes(`\nexport HTTPS_PROXY='http://user:it'\\''s $HOME \`id\` "x"@proxy.example.test:3128'\n`));
  assert.ok(text.includes("\nexport NO_PROXY='localhost,.example.test'\n"));
  assert.ok(text.includes(`\nexport NODE_EXTRA_CA_CERTS='${ca.replace(/'/g, "'\\''")}'\n`));
  assert.ok(text.includes("\nexport NODE_USE_ENV_PROXY=1\n"));
  const run = f.run({execPath: process.execPath, network});
  assert.equal(run.status, 0);
  assert.deepEqual(run.started.env, {HTTPS_PROXY: network.httpsProxy, NO_PROXY: network.noProxy, NODE_EXTRA_CA_CERTS: ca, NODE_USE_ENV_PROXY: "1"});
  // Without a recorded proxy the launcher does not switch proxy support on.
  const plain = f.run({execPath: process.execPath, network: {noProxy: "localhost", extraCaCerts: ca}});
  assert.deepEqual(plain.started.env, {HTTPS_PROXY: null, NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: ca, NODE_USE_ENV_PROXY: null});
  assert.deepEqual(f.run({execPath: process.execPath}).started.env, {HTTPS_PROXY: null, NO_PROXY: null, NODE_EXTRA_CA_CERTS: null, NODE_USE_ENV_PROXY: null});
  const base = {stateDir: f.state, node: {execPath: process.execPath}, entry: f.entry, configPath: f.config};
  for (const bad of [{httpsProxy: "http://proxy.example.test:3128\nrm -rf /"}, {noProxy: "a\0b"}, {extraCaCerts: "/etc/ssl/corp\r.pem"}]) {
    assert.throws(() => cursorCollectorLauncher({...base, network: bad}), /line break or NUL/);
  }
  assert.throws(() => cursorCollectorLauncher({...base, entry: f.entry + "\nexit 0"}), /line break or NUL/);
});

test("proxy variables inherited from the service manager neither override nor add to the recorded ones", t => {
  // Node.js prefers the lower-case spelling and lets https fall back to the
  // http proxy, so each of these would otherwise change where the collector sends.
  const f = launcherFixture(t), recorded = "http://recorded.example.test:3128";
  const inherited = {HTTPS_PROXY: "http://inherited.example.test:1", https_proxy: "http://inherited.example.test:2",
    HTTP_PROXY: "http://inherited.example.test:3", http_proxy: "http://inherited.example.test:4",
    NO_PROXY: "inherited.example.test", no_proxy: "*", NODE_USE_ENV_PROXY: "1"};
  const text = cursorCollectorLauncher({stateDir: f.state, node: {execPath: process.execPath}, entry: f.entry, configPath: f.config, network: {httpsProxy: recorded}});
  assert.ok(text.includes("\nunset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy NODE_USE_ENV_PROXY\n"));
  assert.ok(text.indexOf("\nunset ") < text.indexOf("\nexport "), "the recorded values are exported after the inherited ones are cleared");
  const proxied = f.run({execPath: process.execPath, network: {httpsProxy: recorded}}, inherited);
  assert.equal(proxied.status, 0);
  assert.deepEqual(proxied.started.proxy, {HTTPS_PROXY: recorded, NODE_USE_ENV_PROXY: "1"});
  const both = f.run({execPath: process.execPath, network: {httpsProxy: recorded, noProxy: "localhost"}}, inherited);
  assert.deepEqual(both.started.proxy, {HTTPS_PROXY: recorded, NO_PROXY: "localhost", NODE_USE_ENV_PROXY: "1"});
  // With nothing recorded the collector connects directly, whatever it inherits.
  const direct = f.run({execPath: process.execPath}, inherited);
  assert.equal(direct.status, 0);
  assert.deepEqual(direct.started.proxy, {});
});
