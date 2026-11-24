// hooks.json merge, verify and uninstall. Every file lives in a temporary
// directory; the import below also moves the home directory there, so a default
// path could not reach a real ~/.cursor even if a test forgot to pass one.
import "../support/isolateHome.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cursorHookCommand, cursorPaths } from "../../src/client/cursor/config.ts";
import { CURSOR_HOOK_EVENTS } from "../../src/client/cursor/hookProgram.ts";
import {
  CURSOR_HOOK_MARKER, CURSOR_HOOKS_FILE_BYTES, CursorHooksRefusal, checkCursorHooksFile, cursorHooksManualBlock,
  cursorHooksState, installCursorHooks, removeCursorHooks,
} from "../../src/client/cursor/hooksFile.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const PRETTY = fixture("hooks-user-pretty.json");
const BACKSLASH = "\\";

type Doc = { version: number; hooks: Record<string, any[]> } & Record<string, unknown>;

function sandbox(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-hooks-"));
  const paths = cursorPaths(root);
  fs.mkdirSync(path.dirname(paths.hooksFile), { recursive: true });
  t.after(() => {
    // A test that fails while the directory is read-only must still be cleaned up.
    if (fs.existsSync(path.dirname(paths.hooksFile))) fs.chmodSync(path.dirname(paths.hooksFile), 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, hooksFile: paths.hooksFile, command: paths.hook, backup: paths.hooksBackup, directory: path.dirname(paths.hooksFile) };
}

const ours = (entry: any) => typeof entry?.command === "string" && entry.command.includes(CURSOR_HOOK_MARKER);

/** The merge as a plain value change, written independently of the module. */
function merged(text: string, command: string): Doc {
  const doc = JSON.parse(text) as Doc;
  for (const event of CURSOR_HOOK_EVENTS) {
    doc.hooks[event] = [...(doc.hooks[event] ?? []).filter(entry => !ours(entry)), { command: cursorHookCommand(event, command), timeout: 5 }];
  }
  return doc;
}

/** Every entry in a directory with its bytes, mode and link target. */
function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}`
      : `${(stat.mode & 0o777).toString(8)}:${stat.mtimeMs}:${stat.ino}:${fs.readFileSync(file).toString("hex")}`];
  }));
}

function refusal(action: () => unknown): CursorHooksRefusal {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CursorHooksRefusal, `expected a refusal, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

function assertManualBlock(message: string, command: string): void {
  for (const event of CURSOR_HOOK_EVENTS) {
    assert.ok(message.includes(`"${event}": [{ "command": "${cursorHookCommand(event, command)}", "timeout": 5 }]`), `refusal lacks the ${event} entry`);
  }
  assert.match(message, /--hooks-manual/);
}

const CORPUS: Array<{ name: string; text: string }> = [
  { name: "two-space file with inline and block entries", text: PRETTY },
  { name: "tab-indented file", text: fixture("hooks-user-tabs.json") },
  { name: "minified file without a final newline", text: fixture("hooks-user-minified.json") },
  { name: "four-space file", text: JSON.stringify(JSON.parse(PRETTY), null, 4) + "\n" },
  { name: "CRLF file", text: PRETTY.replace(/\n/g, "\r\n") },
  { name: "file without a final newline", text: PRETTY.trimEnd() },
  { name: "one spaced line", text: '{ "version": 1, "hooks": { "stop": [{ "command": "/opt/fixture/bin/notify.sh" }] } }\n' },
  { name: "empty hooks object", text: '{\n  "version": 1,\n  "hooks": {}\n}\n' },
  { name: "empty minified hooks object", text: '{"version":1,"hooks":{}}' },
  { name: "hooks before version with irregular spacing",
    text: '{"hooks" :  {\n      "stop":[ {"command":"/opt/fixture/bin/notify.sh"} ,\n  {"command":"x y"}\n ]}\n ,"version":1}' },
  { name: "escapes, brackets inside strings and number spellings",
    text: `{\n  "version": 1,\n  "label": "caf${BACKSLASH}u00e9 ${BACKSLASH}"quoted${BACKSLASH}" ${BACKSLASH}${BACKSLASH} ${BACKSLASH}/ {[,]}",\n  "hooks": {\n    "stop": [\n      {\n        "command": "/opt/fixture/bin/n${BACKSLASH}u006ftify.sh",\n        "env": {"A": [1, 2.50, 1e3, -0, true, null], "}": "]"}\n      }\n    ]\n  }\n}\n` },
  { name: "every managed event already holding a user entry",
    text: JSON.stringify({ version: 1, hooks: Object.fromEntries(CURSOR_HOOK_EVENTS.map(event => [event, [{ command: `/opt/fixture/bin/${event}.sh` }]])) }, null, 2) + "\n" },
];

test("default paths resolve inside the isolated test home", () => {
  const paths = cursorPaths();
  for (const file of [paths.config, paths.shareDir, paths.stateDir, paths.hooksFile]) {
    assert.ok(file.startsWith(os.homedir() + path.sep));
  }
  assert.ok(os.homedir().startsWith(fs.realpathSync(os.tmpdir())) || os.homedir().startsWith(os.tmpdir()));
  assert.ok(paths.hook.includes(CURSOR_HOOK_MARKER));
});

test("a missing hooks.json is created with one entry per event, private, and never fail-closed", t => {
  const s = sandbox(t);
  fs.rmSync(s.directory, { recursive: true });
  assert.deepEqual(checkCursorHooksFile(s), { exists: false });
  assert.equal(fs.existsSync(s.directory), false, "the preflight check writes nothing");
  const result = installCursorHooks(s);
  assert.deepEqual(result, { path: s.hooksFile, status: "created", createdByConnect: true, backupPath: null, createdKeys: [...CURSOR_HOOK_EVENTS] });
  const text = fs.readFileSync(s.hooksFile, "utf8");
  const expected = { version: 1, hooks: Object.fromEntries(CURSOR_HOOK_EVENTS.map(event => [event, [{ command: cursorHookCommand(event, s.command), timeout: 5 }]])) };
  assert.equal(text, JSON.stringify(expected, null, 2) + "\n");
  assert.deepEqual(Object.keys(JSON.parse(text).hooks), [...CURSOR_HOOK_EVENTS]);
  assert.equal(fs.statSync(s.hooksFile).mode & 0o777, 0o600);
  assert.ok(!text.includes("failClosed"));
  assert.deepEqual(fs.readdirSync(s.directory), ["hooks.json"]);
  assert.equal(cursorHooksState(s), "installed");
  assert.equal(installCursorHooks(s).status, "unchanged");
});

for (const { name, text } of CORPUS) {
  test(`merge keeps every other byte, reinstall writes nothing, uninstall restores the file: ${name}`, t => {
    const s = sandbox(t);
    fs.writeFileSync(s.hooksFile, text, { mode: 0o644 });
    fs.chmodSync(s.hooksFile, 0o644);
    assert.deepEqual(checkCursorHooksFile(s), { exists: true });
    assert.deepEqual(Object.keys(snapshot(s.directory)), ["hooks.json"], "the preflight check writes nothing");

    const result = installCursorHooks(s);
    assert.equal(result.status, "updated");
    assert.equal(result.createdByConnect, false);
    assert.equal(result.backupPath, s.backup);
    assert.equal(fs.readFileSync(s.backup, "utf8"), text);
    assert.equal(fs.statSync(s.backup).mode & 0o777, 0o600);

    const installed = fs.readFileSync(s.hooksFile, "utf8"), doc = JSON.parse(installed) as Doc, before = JSON.parse(text) as Doc;
    assert.deepEqual(doc, merged(text, s.command));
    assert.deepEqual(Object.keys(doc), Object.keys(before), "top-level keys and their order are kept");
    assert.deepEqual(Object.keys(doc.hooks), [...Object.keys(before.hooks), ...CURSOR_HOOK_EVENTS.filter(event => !(event in before.hooks))]);
    for (const event of CURSOR_HOOK_EVENTS) {
      const mine = doc.hooks[event]!.filter(ours);
      assert.deepEqual(mine, [{ command: cursorHookCommand(event, s.command), timeout: 5 }], "exactly one entry, with no failClosed");
      assert.ok(ours(doc.hooks[event]!.at(-1)), "appended after the user's entries");
    }
    assert.equal(fs.statSync(s.hooksFile).mode & 0o777, 0o644, "file mode is kept");
    assert.equal(installed.includes("\r\n"), text.includes("\r\n"));
    assert.equal(/\r(?!\n)/.test(installed), false);
    if (text.includes("\r\n")) assert.equal(/(?<!\r)\n/.test(installed), false, "a CRLF file gains no bare line feed");
    assert.equal(/\n$/.test(installed), /\n$/.test(text), "final newline is neither added nor removed");
    if (!text.includes("\n")) assert.ok(!installed.includes("\n"), "a one-line file stays one line");
    // The original survives as an ordered subsequence: the merge only inserts.
    let at = 0;
    for (const char of installed) if (char === text[at]) at++;
    assert.equal(at, text.length);
    assert.equal(cursorHooksState(s), "installed");

    const settled = snapshot(s.directory);
    const again = installCursorHooks(s);
    assert.deepEqual(again, { path: s.hooksFile, status: "unchanged", createdByConnect: false, backupPath: null, createdKeys: again.createdKeys });
    assert.deepEqual(snapshot(s.directory), settled, "an idempotent reinstall writes nothing");

    assert.deepEqual(removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: false }), { path: s.hooksFile, status: "updated" });
    assert.equal(fs.readFileSync(s.hooksFile, "utf8"), text, "uninstall is byte-identical to the file before Connect");
    assert.equal(fs.statSync(s.hooksFile).mode & 0o777, 0o644);
    assert.equal(cursorHooksState(s), "missing");
    assert.deepEqual(fs.readdirSync(s.directory).sort(), ["hooks.json", "hooks.json.codetelemetry-backup"]);
  });
}

test("a file written by JSON.stringify gains entries in the same layout", t => {
  const s = sandbox(t);
  for (const indent of [2, 4, "\t"]) {
    const text = JSON.stringify(JSON.parse(PRETTY), null, indent) + "\n";
    fs.writeFileSync(s.hooksFile, text);
    installCursorHooks(s);
    assert.equal(fs.readFileSync(s.hooksFile, "utf8"), JSON.stringify(merged(text, s.command), null, indent) + "\n");
  }
  const minified = JSON.stringify(JSON.parse(PRETTY));
  fs.writeFileSync(s.hooksFile, minified);
  installCursorHooks(s);
  assert.equal(fs.readFileSync(s.hooksFile, "utf8"), JSON.stringify(merged(minified, s.command)));
});

test("the one-time backup holds the user's original and is never overwritten or written through a link", t => {
  const s = sandbox(t);
  fs.writeFileSync(s.hooksFile, PRETTY);
  assert.equal(installCursorHooks(s).backupPath, s.backup);
  removeCursorHooks(s);
  fs.writeFileSync(s.hooksFile, fixture("hooks-user-tabs.json"));
  assert.equal(installCursorHooks(s).backupPath, null);
  assert.equal(fs.readFileSync(s.backup, "utf8"), PRETTY);

  const other = sandbox(t), victim = path.join(other.root, "victim.txt");
  fs.writeFileSync(victim, "untouched");
  fs.writeFileSync(other.hooksFile, PRETTY);
  fs.symlinkSync(victim, other.backup);
  fs.symlinkSync(victim, `${other.hooksFile}.codetelemetry-tmp`);
  const result = installCursorHooks(other);
  assert.equal(result.status, "updated");
  assert.equal(result.backupPath, null);
  assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
  assert.equal(fs.lstatSync(other.backup).isSymbolicLink(), true);
  assert.equal(fs.existsSync(`${other.hooksFile}.codetelemetry-tmp`), false, "a leftover temporary is cleared, not followed");
});

test("a symbolic link is refused and left a link, with the eight entries to paste", t => {
  const s = sandbox(t), target = path.join(s.root, "dotfiles-hooks.json");
  fs.writeFileSync(target, PRETTY);
  fs.symlinkSync(target, s.hooksFile);
  const before = snapshot(s.directory);
  for (const action of [() => checkCursorHooksFile(s), () => installCursorHooks(s)]) {
    const error = refusal(action);
    assert.equal(error.reason, "symlink");
    assert.match(error.message, /symbolic link/);
    assertManualBlock(error.message, s.command);
  }
  assert.deepEqual(snapshot(s.directory), before);
  assert.equal(fs.lstatSync(s.hooksFile).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), PRETTY);
});

test("comments or a trailing comma are refused, the file is unchanged and the refusal carries the entries", t => {
  const s = sandbox(t);
  const cases = [
    fixture("hooks-user-commented.jsonc"),
    '{\n  "version": 1,\n  "hooks": {\n    "stop": [],\n  }\n}\n',
    '{\n  "version": 1, // mine\n  "hooks": {}\n}\n',
  ];
  for (const text of cases) {
    fs.writeFileSync(s.hooksFile, text);
    const before = snapshot(s.directory);
    for (const action of [() => checkCursorHooksFile(s), () => installCursorHooks(s)]) {
      const error = refusal(action);
      assert.equal(error.reason, "comments");
      assert.match(error.message, /comments or trailing commas/);
      assertManualBlock(error.message, s.command);
    }
    assert.deepEqual(snapshot(s.directory), before);
  }
});

test("malformed, oversized and unexpectedly shaped files are refused unchanged", t => {
  const s = sandbox(t);
  const padded = '{"version":1,"hooks":{}}'.padEnd(CURSOR_HOOKS_FILE_BYTES + 1, " ");
  const cases: Array<[string, string | Buffer]> = [
    ["invalid_json", '{"version": 1, "hooks": {'],
    ["invalid_json", ""],
    ["invalid_json", "not json at all"],
    ["invalid_json", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["invalid_json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":1,"hooks":{}}')])],
    ["shape", '{"version": 2, "hooks": {}}'],
    ["shape", '{"hooks": {}}'],
    ["shape", '{"version": 1}'],
    ["shape", '{"version": 1, "hooks": []}'],
    ["shape", '{"version": 1, "hooks": {"stop": {"command": "x"}}}'],
    ["shape", '{"version": 1, "hooks": {"stop": "x"}}'],
    ["shape", '[{"version": 1, "hooks": {}}]'],
    ["shape", "null"],
    ["too_large", padded],
    ["merge", '{"version": 1, "hooks": {"stop": []}, "hooks": {"stop": []}}'],
    ["merge", '{"version": 1, "hooks": {"stop": [], "stop": []}}'],
  ];
  for (const [reason, body] of cases) {
    fs.writeFileSync(s.hooksFile, body);
    const before = snapshot(s.directory);
    for (const action of [() => checkCursorHooksFile(s), () => installCursorHooks(s)]) {
      const error = refusal(action);
      assert.equal(error.reason, reason, String(body).slice(0, 60));
      assert.ok(error.message.startsWith(`${s.hooksFile} was not changed: `));
      assertManualBlock(error.message, s.command);
    }
    assert.deepEqual(snapshot(s.directory), before);
  }
  fs.rmSync(s.hooksFile);
  fs.mkdirSync(s.hooksFile);
  assert.equal(refusal(() => installCursorHooks(s)).reason, "not_a_file");
});

test("a directory that cannot be written is a refusal with the entries, not a crash", t => {
  if (process.getuid?.() === 0) return t.skip("the superuser ignores directory permissions");
  const s = sandbox(t);
  fs.writeFileSync(s.hooksFile, PRETTY);
  fs.chmodSync(s.directory, 0o500);
  const before = snapshot(s.directory);
  const error = refusal(() => installCursorHooks(s));
  assert.equal(error.reason, "unwritable");
  assert.match(error.message, /could not be written \(EACCES\)/);
  assertManualBlock(error.message, s.command);
  assert.deepEqual(snapshot(s.directory), before);

  fs.chmodSync(s.directory, 0o700);
  installCursorHooks(s);
  fs.chmodSync(s.directory, 0o500);
  const installed = snapshot(s.directory);
  const result = removeCursorHooks(s);
  assert.equal(result.status, "skipped");
  assert.match(result.detail!, /could not be written \(EACCES\)/);
  assert.deepEqual(snapshot(s.directory), installed);

  fs.chmodSync(s.directory, 0o700);
  fs.rmSync(s.hooksFile);
  fs.rmSync(s.backup);
  fs.chmodSync(s.directory, 0o500);
  assert.equal(refusal(() => installCursorHooks(s)).reason, "unwritable");
  assert.deepEqual(fs.readdirSync(s.directory), []);
});

test("a file saved by someone else during the update is left exactly as they saved it", t => {
  const s = sandbox(t), real = fs.lstatSync;
  // The module checks the file a second time just before its rename; that is where the other save lands.
  const interrupt = (edit: () => void) => {
    let seen = 0;
    t.mock.method(fs, "lstatSync", (file: fs.PathLike, ...rest: unknown[]) => {
      if (file === s.hooksFile && ++seen === 2) edit();
      return (real as (...args: unknown[]) => fs.Stats)(file, ...rest);
    });
  };
  fs.writeFileSync(s.hooksFile, PRETTY);
  interrupt(() => fs.appendFileSync(s.hooksFile, "\n"));
  const error = refusal(() => installCursorHooks(s));
  t.mock.restoreAll();
  assert.equal(error.reason, "changed");
  assert.match(error.message, /Run the command again/);
  assert.equal(fs.readFileSync(s.hooksFile, "utf8"), PRETTY + "\n");
  assert.deepEqual(fs.readdirSync(s.directory).sort(), ["hooks.json", "hooks.json.codetelemetry-backup"]);
  assert.equal(installCursorHooks(s).status, "updated");

  const edited = fs.readFileSync(s.hooksFile, "utf8").replace("greet.sh", "hello.sh");
  interrupt(() => fs.writeFileSync(s.hooksFile, edited));
  const removed = removeCursorHooks(s);
  t.mock.restoreAll();
  assert.equal(removed.status, "skipped");
  assert.match(removed.detail!, /Run the command again\.$/);
  assert.equal(fs.readFileSync(s.hooksFile, "utf8"), edited);

  const own = sandbox(t);
  installCursorHooks(own);
  const added = fs.readFileSync(own.hooksFile, "utf8").replace('"version": 1,', '"version": 1, "note": "mine",');
  t.mock.method(fs, "lstatSync", (() => {
    let seen = 0;
    return (file: fs.PathLike, ...rest: unknown[]) => {
      if (file === own.hooksFile && ++seen === 2) fs.writeFileSync(own.hooksFile, added);
      return (real as (...args: unknown[]) => fs.Stats)(file, ...rest);
    };
  })());
  assert.equal(removeCursorHooks({ hooksFile: own.hooksFile, createdByConnect: true }).status, "skipped");
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(own.hooksFile, "utf8"), added, "a file Connect created is not deleted over a newer save");
});

test("a hook path a shell would split is refused before anything is read or written", t => {
  const s = sandbox(t);
  fs.rmSync(s.directory, { recursive: true });
  const unsafe = [
    path.join(s.root, "home dir", ".local/share/codetelemetry/cursor-hooks-v1/hook.sh"),
    path.join(s.root, "a$b", ".local/share/codetelemetry/cursor-hooks-v1/hook.sh"),
    path.join(s.root, "it's", ".local/share/codetelemetry/cursor-hooks-v1/hook.sh"),
    "relative/.local/share/codetelemetry/cursor-hooks-v1/hook.sh",
    path.join(s.root, "elsewhere/hook.sh"),
  ];
  for (const command of unsafe) {
    for (const action of [() => checkCursorHooksFile({ hooksFile: s.hooksFile, command }), () => installCursorHooks({ hooksFile: s.hooksFile, command })]) {
      const error = refusal(action);
      assert.equal(error.reason, "unsafe_command");
      assert.ok(!error.message.includes("--hooks-manual"), "an unusable command is not offered for pasting");
    }
  }
  assert.equal(fs.existsSync(s.directory), false);
});

test("entries left by another installation are replaced, duplicates collapse and entries under other events stay", t => {
  const s = sandbox(t);
  const stale = "/home/other/.local/share/codetelemetry/cursor-hooks-v1/hook.sh";
  const doc = {
    version: 1,
    hooks: {
      stop: [{ command: stale, timeout: 5 }, { command: "/opt/fixture/bin/notify.sh" }, { command: stale, timeout: 5, failClosed: true }],
      postToolUse: [{ command: stale }],
      sessionStart: [{ command: stale }, { command: "/opt/fixture/bin/greet.sh" }],
    },
  };
  const text = JSON.stringify(doc, null, 2) + "\n";
  fs.writeFileSync(s.hooksFile, text);
  assert.equal(cursorHooksState({ hooksFile: s.hooksFile }), "partial");
  assert.equal(cursorHooksState(s), "missing", "another installation's command will not run this hook");
  assert.equal(installCursorHooks(s).status, "updated");
  const installed = JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc;
  assert.deepEqual(installed, merged(text, s.command));
  assert.deepEqual(installed.hooks.stop, [{ command: "/opt/fixture/bin/notify.sh" }, { command: s.command, timeout: 5 }]);
  assert.deepEqual(installed.hooks.sessionStart, doc.hooks.sessionStart, "install touches only its own events");
  assert.ok(!JSON.stringify(installed.hooks.stop).includes("failClosed"));

  // The user adds an entry after ours; the next install moves ours back to the end, once.
  installed.hooks.stop!.push({ command: "/opt/fixture/bin/later.sh" });
  fs.writeFileSync(s.hooksFile, JSON.stringify(installed, null, 2) + "\n");
  assert.equal(installCursorHooks(s).status, "updated");
  assert.deepEqual((JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc).hooks.stop!.map(entry => entry.command),
    ["/opt/fixture/bin/notify.sh", "/opt/fixture/bin/later.sh", s.command]);
  assert.equal(installCursorHooks(s).status, "unchanged");

  // Uninstall removes ours wherever it is, including the pasted one under sessionStart.
  assert.equal(removeCursorHooks(s).status, "updated");
  const left = JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc;
  assert.deepEqual(left, { version: 1, hooks: { stop: [{ command: "/opt/fixture/bin/notify.sh" }, { command: "/opt/fixture/bin/later.sh" }], sessionStart: [{ command: "/opt/fixture/bin/greet.sh" }] } });
});

test("uninstall deletes only a file Connect created, and only once nothing else is in it", t => {
  const s = sandbox(t);
  fs.rmSync(s.directory, { recursive: true });
  assert.deepEqual(removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: true }), { path: s.hooksFile, status: "absent" });

  assert.equal(installCursorHooks(s).createdByConnect, true);
  assert.deepEqual(removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: true }), { path: s.hooksFile, status: "deleted" });
  assert.deepEqual(fs.readdirSync(s.directory), []);

  installCursorHooks(s);
  assert.equal(removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: false }).status, "updated");
  assert.equal(fs.readFileSync(s.hooksFile, "utf8"), '{\n  "version": 1,\n  "hooks": {}\n}\n');

  fs.rmSync(s.hooksFile);
  installCursorHooks(s);
  const doc = JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc;
  doc.hooks.stop!.unshift({ command: "/opt/fixture/bin/notify.sh" });
  doc.note = "added by the user";
  fs.writeFileSync(s.hooksFile, JSON.stringify(doc, null, 2) + "\n");
  assert.equal(removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: true }).status, "updated");
  assert.deepEqual(JSON.parse(fs.readFileSync(s.hooksFile, "utf8")), { version: 1, hooks: { stop: [{ command: "/opt/fixture/bin/notify.sh" }] }, note: "added by the user" });
});

test("uninstall never rewrites a file that holds no entry of ours", t => {
  const s = sandbox(t);
  for (const text of [PRETTY, fixture("hooks-user-commented.jsonc"), "not json", '{"version": 2, "hooks": {}}']) {
    fs.writeFileSync(s.hooksFile, text);
    const before = snapshot(s.directory);
    assert.deepEqual(removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: true }), { path: s.hooksFile, status: "unchanged" });
    assert.deepEqual(snapshot(s.directory), before);
  }
});

test("a list the user left empty is filled in place, a repeated install changes nothing, and uninstall puts the empty list back", t => {
  const user = { version: 1, hooks: { stop: [{ command: "/opt/fixture/bin/notify.sh" }], preToolUse: [{ command: "/opt/fixture/bin/audit.sh", matcher: "Shell" }], postToolUse: [], sessionStart: [] } };
  const texts: Record<string, string> = {
    "two spaces": JSON.stringify(user, null, 2) + "\n", "four spaces": JSON.stringify(user, null, 4), tabs: JSON.stringify(user, null, "\t") + "\n",
    minified: JSON.stringify(user), CRLF: JSON.stringify(user, null, 2).replace(/\n/g, "\r\n"),
    "compact lists": '{\n  "version": 1,\n  "hooks": {\n    "stop": [{ "command": "/opt/fixture/bin/notify.sh" }],\n    "postToolUse": []\n  }\n}\n',
    "only empty lists": '{\n  "version": 1,\n  "hooks": {\n    "postToolUse": [],\n    "stop": []\n  }\n}\n',
  };
  for (const [name, text] of Object.entries(texts)) {
    const s = sandbox(t);
    fs.writeFileSync(s.hooksFile, text);
    const first = installCursorHooks(s);
    assert.equal(first.status, "updated", name);
    const had = Object.keys(JSON.parse(text).hooks);
    assert.deepEqual(first.createdKeys, CURSOR_HOOK_EVENTS.filter(event => !had.includes(event)), `${name}: only the keys the file lacked are Connect's`);
    const installed = fs.readFileSync(s.hooksFile, "utf8");
    assert.deepEqual(JSON.parse(installed), merged(text, s.command), name);
    assert.deepEqual(Object.keys(JSON.parse(installed).hooks).slice(0, had.length), had, `${name}: the user's keys stay where they were`);
    // The second login: nothing is written, and the record of whose keys they are is the same.
    const before = snapshot(s.directory);
    const second = installCursorHooks({ ...s, createdKeys: first.createdKeys });
    assert.deepEqual([second.status, second.createdKeys, second.backupPath], ["unchanged", first.createdKeys, null], name);
    assert.deepEqual(snapshot(s.directory), before, name);
    assert.equal(removeCursorHooks({ hooksFile: s.hooksFile, createdKeys: first.createdKeys }).status, "updated", name);
    assert.equal(fs.readFileSync(s.hooksFile, "utf8"), text, `${name}: the file is byte-identical to the user's, empty lists included`);
    // And again from there: disable followed by enable.
    assert.deepEqual(installCursorHooks({ ...s, createdKeys: first.createdKeys }).createdKeys, first.createdKeys, name);
    assert.equal(fs.readFileSync(s.hooksFile, "utf8"), installed, name);
  }
  // A file Connect created holds only keys Connect added, and is deleted when they go.
  const own = sandbox(t);
  fs.rmSync(own.directory, { recursive: true });
  const created = installCursorHooks(own);
  assert.deepEqual(created.createdKeys, [...CURSOR_HOOK_EVENTS]);
  assert.equal(removeCursorHooks({ hooksFile: own.hooksFile, createdByConnect: true, createdKeys: created.createdKeys }).status, "deleted");
});

test("without a record of whose key it was, a list holding only Connect's entry loses its key on uninstall, with nothing else changed", t => {
  const s = sandbox(t);
  const text = '{\n  "version": 1,\n  "hooks": {\n    "stop": [],\n    "sessionStart": []\n  }\n}\n';
  fs.writeFileSync(s.hooksFile, text);
  installCursorHooks(s);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.hooksFile, "utf8")), merged(text, s.command));
  removeCursorHooks(s);
  assert.equal(fs.readFileSync(s.hooksFile, "utf8"), '{\n  "version": 1,\n  "hooks": {\n    "sessionStart": []\n  }\n}\n');
});

test("entries Connect cannot remove safely are reported, and the file stays as it is", t => {
  const s = sandbox(t);
  const commented = fixture("hooks-user-commented.jsonc").replace('"stop": [', `"stop": [\n      { "command": "${s.command}", "timeout": 5 },`);
  fs.writeFileSync(s.hooksFile, commented);
  let before = snapshot(s.directory);
  let result = removeCursorHooks({ hooksFile: s.hooksFile, createdByConnect: true });
  assert.equal(result.status, "skipped");
  assert.match(result.detail!, /comments or trailing commas/);
  assert.ok(result.detail!.includes(CURSOR_HOOK_MARKER));
  assert.ok(!result.detail!.includes("--hooks-manual"));
  assert.deepEqual(snapshot(s.directory), before);

  const target = path.join(s.root, "dotfiles-hooks.json");
  fs.rmSync(s.hooksFile);
  fs.writeFileSync(target, JSON.stringify(merged(PRETTY, s.command), null, 2));
  fs.symlinkSync(target, s.hooksFile);
  before = snapshot(s.directory);
  result = removeCursorHooks({ hooksFile: s.hooksFile });
  assert.equal(result.status, "skipped");
  assert.match(result.detail!, /symbolic link/);
  assert.deepEqual(snapshot(s.directory), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), merged(PRETTY, s.command));
});

test("state is installed, partial or missing, and a hand-pasted block in a commented or linked file counts", t => {
  const s = sandbox(t);
  fs.rmSync(s.directory, { recursive: true });
  assert.equal(cursorHooksState(s), "missing");
  fs.mkdirSync(s.directory, { recursive: true });
  for (const garbage of ["", "not json", "[]", '{"hooks": 3}', '{"hooks": {"stop": {}}}']) {
    fs.writeFileSync(s.hooksFile, garbage);
    assert.equal(cursorHooksState(s), "missing");
  }

  fs.writeFileSync(s.hooksFile, PRETTY);
  installCursorHooks(s);
  assert.equal(cursorHooksState(s), "installed");
  const doc = JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc;
  delete doc.hooks.afterShellExecution;
  doc.hooks.stop = doc.hooks.stop!.filter(entry => !ours(entry));
  fs.writeFileSync(s.hooksFile, JSON.stringify(doc));
  assert.equal(cursorHooksState(s), "partial", "another tool rewrote the file and dropped two of ours");

  const pasted = `{\n  // pasted by hand\n  "version": 1,\n  ${cursorHooksManualBlock(s.command).replace(/\n/g, "\n  ")},\n}\n`;
  assert.throws(() => JSON.parse(pasted));
  fs.writeFileSync(s.hooksFile, pasted);
  assert.equal(cursorHooksState(s), "installed");
  assert.equal(cursorHooksState({ hooksFile: s.hooksFile }), "installed");
  assert.equal(cursorHooksState({ hooksFile: s.hooksFile, command: "/home/other/.local/share/codetelemetry/cursor-hooks-v1/hook.sh" }), "missing");
  assert.equal(refusal(() => installCursorHooks(s)).reason, "comments");

  const target = path.join(s.root, "dotfiles-hooks.json");
  fs.renameSync(s.hooksFile, target);
  fs.symlinkSync(target, s.hooksFile);
  assert.equal(cursorHooksState(s), "installed");

  fs.rmSync(s.hooksFile);
  fs.writeFileSync(s.hooksFile, '{"version":1,"hooks":{}}'.padEnd(CURSOR_HOOKS_FILE_BYTES + 1, " "));
  assert.equal(cursorHooksState(s), "missing");
});

test("the pasted block is exactly what the merge writes", t => {
  const s = sandbox(t);
  const block = cursorHooksManualBlock(s.command);
  assert.equal(block.split("\n").length, CURSOR_HOOK_EVENTS.length + 2);
  assert.ok(!block.includes("failClosed"));
  installCursorHooks(s);
  assert.deepEqual(JSON.parse(`{"version": 1, ${block}}`), JSON.parse(fs.readFileSync(s.hooksFile, "utf8")));
});

test("the two content events: a reply runs the ordinary launcher, a file read runs the one that answers Cursor", t => {
  const s = sandbox(t);
  assert.deepEqual([...CURSOR_HOOK_EVENTS], ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "stop", "afterAgentThought", "afterShellExecution",
    "afterAgentResponse", "beforeReadFile"]);
  const read = path.join(path.dirname(s.command), "hook-read.sh");
  installCursorHooks(s);
  const doc = JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc;
  assert.deepEqual(doc.hooks.afterAgentResponse, [{ command: s.command, timeout: 5 }]);
  assert.deepEqual(doc.hooks.beforeReadFile, [{ command: read, timeout: 5 }]);
  assert.ok(read.includes(CURSOR_HOOK_MARKER), "the entry is recognized as Connect's and removed with the others");
  for (const event of CURSOR_HOOK_EVENTS) for (const entry of doc.hooks[event]!) {
    assert.deepEqual(Object.keys(entry), ["command", "timeout"], "no failClosed, no matcher: a failing hook lets Cursor go on");
  }
  // The exact command of each event is what counts as installed.
  assert.equal(cursorHooksState(s), "installed");
  doc.hooks.beforeReadFile = [{ command: s.command, timeout: 5 }];
  fs.writeFileSync(s.hooksFile, JSON.stringify(doc, null, 2));
  assert.equal(cursorHooksState(s), "partial", "the ordinary launcher under beforeReadFile is not the entry Connect installs");
  assert.equal(installCursorHooks(s).status, "updated");
  assert.deepEqual((JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc).hooks.beforeReadFile, [{ command: read, timeout: 5 }], "a repeated install puts the right one back, once");
  assert.equal(cursorHooksState(s), "installed");
  assert.ok(cursorHooksManualBlock(s.command).includes(`"beforeReadFile": [{ "command": "${read}", "timeout": 5 }]`));
  assert.ok(cursorHooksManualBlock(s.command).includes(`"afterAgentResponse": [{ "command": "${s.command}", "timeout": 5 }]`));
});

test("an installation with the six earlier entries gains the two new ones, keeps the user's hooks, and uninstall gives the user's file back", t => {
  const s = sandbox(t);
  const earlier = CURSOR_HOOK_EVENTS.slice(0, 6);
  // The user's own hooks, two of them under the events Connect now also uses.
  const user: Doc = { version: 1, hooks: {
    stop: [{ command: "/opt/fixture/bin/notify.sh" }],
    beforeReadFile: [{ command: "/opt/fixture/bin/guard.sh", failClosed: true }],
    afterAgentResponse: [{ command: "/opt/fixture/bin/log-reply.sh", timeout: 30 }],
    preToolUse: [{ command: "/opt/fixture/bin/audit.sh", matcher: "Shell" }],
  } };
  const text = JSON.stringify(user, null, 2) + "\n";
  // The file as the earlier release left it: one entry under each of six events.
  const before = JSON.parse(text) as Doc;
  for (const event of earlier) before.hooks[event] = [...(before.hooks[event] ?? []), { command: s.command, timeout: 5 }];
  fs.writeFileSync(s.hooksFile, JSON.stringify(before, null, 2) + "\n");
  const createdKeys = earlier.filter(event => !(event in user.hooks));
  assert.equal(cursorHooksState(s), "partial", "the two new entries are missing");

  const result = installCursorHooks({ ...s, createdKeys });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.createdKeys, createdKeys, "the two events the user already had are not Connect's keys");
  const installed = JSON.parse(fs.readFileSync(s.hooksFile, "utf8")) as Doc;
  assert.deepEqual(installed, merged(text, s.command));
  assert.deepEqual(installed.hooks.beforeReadFile, [{ command: "/opt/fixture/bin/guard.sh", failClosed: true },
    { command: path.join(path.dirname(s.command), "hook-read.sh"), timeout: 5 }], "the user's own guard stays first and unchanged");
  assert.deepEqual(installed.hooks.afterAgentResponse, [{ command: "/opt/fixture/bin/log-reply.sh", timeout: 30 }, { command: s.command, timeout: 5 }]);
  assert.deepEqual(installed.hooks.preToolUse, user.hooks.preToolUse);
  for (const event of CURSOR_HOOK_EVENTS) assert.equal(installed.hooks[event]!.filter(ours).length, 1, `${event} holds one entry of ours`);
  assert.equal(cursorHooksState(s), "installed");

  // Idempotent: a second and a third install write nothing.
  const bytes = fs.readFileSync(s.hooksFile), stat = fs.statSync(s.hooksFile);
  for (let round = 0; round < 2; round++) assert.equal(installCursorHooks({ ...s, createdKeys: result.createdKeys }).status, "unchanged");
  assert.deepEqual(fs.readFileSync(s.hooksFile), bytes);
  assert.equal(fs.statSync(s.hooksFile).mtimeMs, stat.mtimeMs);

  assert.equal(removeCursorHooks({ hooksFile: s.hooksFile, createdKeys: result.createdKeys }).status, "updated");
  assert.equal(fs.readFileSync(s.hooksFile, "utf8"), text, "every entry of ours is gone, and nothing else");
  assert.equal(cursorHooksState(s), "missing");
  assert.equal(removeCursorHooks({ hooksFile: s.hooksFile, createdKeys: result.createdKeys }).status, "unchanged");
});
