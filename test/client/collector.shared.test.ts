// Loaded here as well as by the test scripts, so this file cannot reach the
// real home directory however it is run.
import "../support/isolateHome.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { claimCollectorState, cleanCollectorState, collectorBootId, readBoundedJson, replaceFileSync, writeAtomicJson } from "../../src/client/collector/state.ts";
import { CREDENTIAL_BLOCK_RE, CREDENTIAL_RE, holdsCredential, scrubCredentials, SECRET_ASSIGNMENT_RE } from "../../src/client/collector/scrub.ts";
import { scrub as scrubKey } from "../../src/client/keys.ts";
import { KIRO_CREDENTIAL_RE } from "../../src/client/kiro/records.ts";
import { claimKiroState, cleanKiroState, readBoundedJson as readKiroJson, writeAtomicJson as writeKiroJson } from "../../src/client/kiro/state.ts";

function scratch(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collector-shared-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
const mode = (file: string) => fs.lstatSync(file).mode & 0o777;

test("state files are bounded, private, atomic and never read or written through a symlink", async t => {
  const root = scratch(t), state = path.join(root, "state"), file = path.join(state, "checkpoint.json");
  assert.equal(await readBoundedJson(file, 1024, "Cursor"), null);
  await writeAtomicJson(file, {version: 1, offsets: {"seg-1.jsonl": 42}}, 1024, "Cursor");
  assert.deepEqual(await readBoundedJson(file, 1024, "Cursor"), {version: 1, offsets: {"seg-1.jsonl": 42}});
  assert.equal(mode(file), 0o600); assert.equal(mode(state), 0o700);
  assert.deepEqual(fs.readdirSync(state), ["checkpoint.json"]);
  await assert.rejects(writeAtomicJson(file, {padding: "x".repeat(2000)}, 1024, "Cursor"), {message: "Cursor persisted state exceeds byte bound"});
  assert.deepEqual(await readBoundedJson(file, 1024, "Cursor"), {version: 1, offsets: {"seg-1.jsonl": 42}}, "a refused write keeps the previous file");
  await assert.rejects(readBoundedJson(file, 8, "Cursor"), {message: "Cursor state file exceeds bound"});
  fs.writeFileSync(file, "{not json");
  await assert.rejects(readBoundedJson(file, 1024, "Cursor"), {message: "Cursor state file is not valid JSON"});
  fs.writeFileSync(file, Buffer.from([0x22, 0xff, 0xfe, 0x22]));
  await assert.rejects(readBoundedJson(file, 1024, "Cursor"), {message: "Cursor state file is not valid JSON"});
  const target = path.join(root, "elsewhere.json");
  fs.writeFileSync(target, "{}"); fs.unlinkSync(file); fs.symlinkSync(target, file);
  await assert.rejects(readBoundedJson(file, 1024, "Cursor"), {message: "Cursor state file is unreadable"});
  await assert.rejects(readBoundedJson(state, 1024, "Cursor"), /Cursor state file/);
  const linked = path.join(root, "linked-state");
  fs.symlinkSync(state, linked);
  await assert.rejects(writeAtomicJson(path.join(linked, "health.json"), {}, 1024, "Cursor"), {message: "Cursor state directory must not be a symlink"});
  // The label is error text only; without one the text is generic.
  await assert.rejects(readBoundedJson(file, 1024), {message: "Collector state file is unreadable"});
});

test("a crash leftover blocks the next write until the state is cleaned under the claim", async t => {
  const root = scratch(t), state = path.join(root, "state");
  const inventory = {files: ["collector.lock", "collector.recovery", "checkpoint.json", "pending.json", "health.json", "dropped"],
    temporaries: {"checkpoint.json.tmp": 1024, "pending.json.tmp": 1024}, directories: ["spool", "rejected"], maxEntries: 16};
  const release = await claimCollectorState(state, "Cursor");
  try {
    await writeAtomicJson(path.join(state, "checkpoint.json"), {version: 1}, 1024, "Cursor");
    fs.writeFileSync(path.join(state, "checkpoint.json.tmp"), "{partial");
    fs.writeFileSync(path.join(state, "owner-11111111-1111-4111-8111-111111111111.tmp"), "{}");
    fs.mkdirSync(path.join(state, "spool")); fs.writeFileSync(path.join(state, "spool", "seg-1.jsonl"), "{}\n"); fs.writeFileSync(path.join(state, "dropped"), "x");
    await assert.rejects(writeAtomicJson(path.join(state, "checkpoint.json"), {version: 2}, 1024, "Cursor"), {code: "EEXIST"});
    await cleanCollectorState(state, inventory, "Cursor");
    assert.deepEqual(fs.readdirSync(state).sort(), ["checkpoint.json", "collector.lock", "dropped", "spool"]);
    assert.deepEqual(fs.readdirSync(path.join(state, "spool")), ["seg-1.jsonl"]);
    await writeAtomicJson(path.join(state, "checkpoint.json"), {version: 2}, 1024, "Cursor");
    // Anything outside the inventory is refused, or skipped when asked.
    fs.writeFileSync(path.join(state, "node-path"), "/opt/node\n");
    await assert.rejects(cleanCollectorState(state, inventory, "Cursor"), {message: "unrecognized Cursor state entry"});
    await cleanCollectorState(state, {...inventory, unknown: "ignore"}, "Cursor");
    assert.equal(fs.existsSync(path.join(state, "node-path")), true);
    fs.unlinkSync(path.join(state, "node-path")); fs.mkdirSync(path.join(state, "unexpected"));
    await assert.rejects(cleanCollectorState(state, inventory, "Cursor"), {message: "unrecognized Cursor state entry"});
    fs.rmdirSync(path.join(state, "unexpected"));
    // A temporary larger than its bound is not ours to delete.
    fs.writeFileSync(path.join(state, "pending.json.tmp"), "x".repeat(2000));
    await assert.rejects(cleanCollectorState(state, inventory, "Cursor"), {message: "Cursor temporary state exceeds bound"});
    assert.equal(fs.existsSync(path.join(state, "pending.json.tmp")), true);
    fs.unlinkSync(path.join(state, "pending.json.tmp"));
    await assert.rejects(cleanCollectorState(state, {...inventory, maxEntries: 2}, "Cursor"), {message: "unrecognized Cursor state entry"});
    // A name on Object.prototype is not a known temporary.
    fs.writeFileSync(path.join(state, "constructor"), "x");
    await assert.rejects(cleanCollectorState(state, inventory, "Cursor"), {message: "unrecognized Cursor state entry"});
    assert.equal(fs.existsSync(path.join(state, "constructor")), true);
  } finally {await release();}
});

test("one process owns a state directory; a dead owner is recovered and a live one is preserved", async t => {
  const root = scratch(t), state = path.join(root, "state"), lock = path.join(state, "collector.lock");
  const release = await claimCollectorState(state, "Cursor");
  assert.equal(mode(lock), 0o600); assert.equal(mode(state), 0o700);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  await assert.rejects(claimCollectorState(state, "Cursor"), {message: "Cursor collector is already running"});
  await assert.rejects(claimKiroState(state), {message: "Kiro collector is already running"});
  assert.deepEqual(fs.readdirSync(state), ["collector.lock"], "a refused claim leaves no temporary");
  await release();
  assert.equal(fs.existsSync(lock), false);
  const exited = spawnSync(process.execPath, ["-e", ""], {env: {PATH: "/usr/bin:/bin", HOME: os.homedir()}});
  assert.equal(exited.status, 0);
  fs.writeFileSync(lock, JSON.stringify({version: 1, pid: exited.pid, token: "previous-owner"}));
  const recovered = await claimCollectorState(state, "Cursor");
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  assert.deepEqual(fs.readdirSync(state), ["collector.lock"]);
  // Releasing after another owner took over must not remove that owner's lease.
  fs.writeFileSync(lock, JSON.stringify({version: 1, pid: process.pid, token: "someone-else"}));
  await recovered();
  assert.equal(fs.existsSync(lock), true);
  fs.writeFileSync(lock, "{}");
  await assert.rejects(claimCollectorState(state, "Cursor"), {message: "Cursor collector ownership is unknown"});
  const linked = path.join(root, "linked");
  fs.symlinkSync(state, linked);
  await assert.rejects(claimCollectorState(linked, "Cursor"), {message: "Cursor state directory must not be a symlink"});
});

test("a lease that names its boot is stale after a restart of the machine, even while its pid is alive again", async t => {
  const root = scratch(t), state = path.join(root, "state"), lock = path.join(state, "collector.lock");
  const boot = "11111111-2222-4333-8444-555555555555", earlier = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const lease = () => JSON.parse(fs.readFileSync(lock, "utf8"));
  const release = await claimCollectorState(state, "Cursor", {boot});
  assert.deepEqual(lease(), {version: 1, pid: process.pid, token: lease().token, boot});
  await assert.rejects(claimCollectorState(state, "Cursor", {boot}), {message: "Cursor collector is already running"});
  await assert.rejects(claimCollectorState(state, "Cursor"), {message: "Cursor collector is already running"});
  await release();
  // What a crash or a power loss leaves: the next boot gave the pid to a live process (here, this one).
  const left = JSON.stringify({version: 1, pid: process.pid, token: "before-the-restart", boot: earlier});
  fs.writeFileSync(lock, left);
  await assert.rejects(claimCollectorState(state, "Cursor"), {message: "Cursor collector is already running"}, "with no boot to compare, the pid decides");
  await assert.rejects(claimKiroState(state), {message: "Kiro collector is already running"}, "Kiro judges a lease as it always did");
  assert.equal(fs.readFileSync(lock, "utf8"), left);
  const recovered = await claimCollectorState(state, "Cursor", {boot});
  assert.deepEqual([lease().pid, lease().boot, lease().token === "before-the-restart"], [process.pid, boot, false]);
  assert.deepEqual(fs.readdirSync(state), ["collector.lock"], "the recovery leaves nothing behind");
  await recovered();
  // A lease without a usable boot is judged by its pid alone.
  for (const other of [{}, {boot: 7}, {boot: null}]) {
    fs.writeFileSync(lock, JSON.stringify({version: 1, pid: process.pid, token: "no-boot", ...other}));
    await assert.rejects(claimCollectorState(state, "Cursor", {boot}), {message: "Cursor collector is already running"});
  }
  fs.unlinkSync(lock);
  const kiro = await claimKiroState(state);
  assert.deepEqual(Object.keys(lease()), ["version", "pid", "token"], "Kiro's lease keeps its format");
  await kiro();

  // The identifier is read from the kernel on Linux only, bounded, and only in its own form.
  const file = path.join(root, "boot_id");
  fs.writeFileSync(file, `${boot}\n`);
  assert.equal(collectorBootId("linux", file), boot);
  assert.equal(collectorBootId("win32", file), undefined);
  // macOS: the boot session identifier, asked for through the injected runner only.
  const asked: string[] = [];
  const sysctl = (output: string | Error) => (command: string, args: string[]) => {
    asked.push([command, ...args].join(" "));
    if (output instanceof Error) throw output;
    return output;
  };
  assert.equal(collectorBootId("darwin", file, sysctl("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\n")), earlier);
  assert.deepEqual(asked, ["/usr/sbin/sysctl -n kern.bootsessionuuid"]);
  for (const output of ["", "{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023\n", `${boot}${boot}`, new Error("sysctl: unknown oid")]) {
    assert.equal(collectorBootId("darwin", file, sysctl(output)), undefined, "anything else is no identifier, and the lease is judged by its pid");
  }
  assert.equal(collectorBootId("linux", file, () => {throw new Error("Linux reads its file and runs nothing");}), boot);
  assert.equal(collectorBootId("win32", file, () => {throw new Error("no command on a platform without an identifier");}), undefined);
  for (const content of ["", "not-an-identifier\n", `${boot}${boot}\n`, "x".repeat(4096)]) {
    fs.writeFileSync(file, content);
    assert.equal(collectorBootId("linux", file), undefined, content.slice(0, 20));
  }
  assert.equal(collectorBootId("linux", path.join(root, "missing")), undefined);
  assert.equal(collectorBootId("linux", root), undefined, "a directory is not an identifier");
  const own = collectorBootId();
  assert.ok(own === undefined || /^[0-9a-f-]{36}$/.test(own));
});

test("a lease from an earlier macOS boot session is stale; one held by another user's process is alive", async t => {
  const root = scratch(t), state = path.join(root, "state"), lock = path.join(state, "collector.lock");
  const session = (id: string) => collectorBootId("darwin", "/nonexistent", () => `${id}\n`);
  const before = session("0F0F0F0F-1111-4222-8333-444444444444"), now = session("A0A0A0A0-5555-4666-8777-888888888888");
  fs.mkdirSync(state);
  // The Mac lost power; after the restart the old pid belongs to an unrelated live process (here, this one).
  fs.writeFileSync(lock, JSON.stringify({version: 1, pid: process.pid, token: "before-the-restart", boot: before}));
  await assert.rejects(claimCollectorState(state, "Cursor", {boot: before}), {message: "Cursor collector is already running"}, "the same session: the pid decides");
  const release = await claimCollectorState(state, "Cursor", {boot: now});
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).boot, now);
  await release();

  // kill(pid, 0) answers EPERM for a process of another user: it exists, so the lease is live.
  const left = JSON.stringify({version: 1, pid: 4242, token: "another-user"});
  fs.writeFileSync(lock, left);
  const probed: Array<[number, unknown]> = [];
  const kill = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    probed.push([pid, signal]);
    throw Object.assign(new Error("kill EPERM"), {code: "EPERM", errno: -1, syscall: "kill"});
  });
  for (const [label, claim] of [["Cursor", () => claimCollectorState(state, "Cursor", {boot: now})], ["Kiro", () => claimKiroState(state)]] as const) {
    await assert.rejects(claim(), (error: Error) => {
      assert.equal(error.message, `${label} collector is already running as another user (pid 4242); its lock ${lock} was left in place`);
      assert.equal((error as NodeJS.ErrnoException).code, undefined, "a sentence, not the raw EPERM");
      return true;
    });
  }
  assert.deepEqual(probed, [[4242, 0], [4242, 0]]);
  assert.equal(fs.readFileSync(lock, "utf8"), left, "the other user's lease is untouched");
  assert.deepEqual(fs.readdirSync(state), ["collector.lock"]);
  // Any other failure of the probe is still an error, never a guess.
  kill.mock.mockImplementation(() => {throw Object.assign(new Error("kill EINVAL"), {code: "EINVAL"});});
  await assert.rejects(claimCollectorState(state, "Cursor"), {code: "EINVAL"});
  kill.mock.restore();
});

test("Kiro's state wrappers keep their signatures, bounds and error text", async t => {
  const root = scratch(t), state = path.join(root, "state"), file = path.join(state, "health.json");
  assert.equal(await readKiroJson(file, 64), null);
  await writeKiroJson(file, {status: "idle"}, 64);
  assert.deepEqual(await readKiroJson(file, 64), {status: "idle"});
  await assert.rejects(writeKiroJson(file, {status: "x".repeat(100)}, 64), {message: "Kiro persisted state exceeds byte bound"});
  await assert.rejects(readKiroJson(file, 4), {message: "Kiro state file exceeds bound"});
  fs.writeFileSync(path.join(state, "health.json.tmp"), "{}"); fs.writeFileSync(path.join(state, "pending.json.tmp"), "{}");
  await cleanKiroState(state);
  assert.deepEqual(fs.readdirSync(state), ["health.json"]);
  fs.writeFileSync(path.join(state, "health.json.tmp"), "x".repeat(4097));
  await assert.rejects(cleanKiroState(state), {message: "Kiro temporary state exceeds bound"});
  fs.unlinkSync(path.join(state, "health.json.tmp")); fs.writeFileSync(path.join(state, "notes.txt"), "x");
  await assert.rejects(cleanKiroState(state), {message: "unrecognized Kiro state entry"});
  fs.unlinkSync(path.join(state, "notes.txt")); fs.mkdirSync(path.join(state, "spool"));
  await assert.rejects(cleanKiroState(state), {message: "unrecognized Kiro state entry"});
});

test("an owned file is replaced by rename: a link is replaced, not followed", t => {
  const root = scratch(t), file = path.join(root, "collector.sh"), target = path.join(root, "target");
  replaceFileSync(file, "#!/bin/sh\nexit 0\n", 0o700);
  assert.equal(fs.readFileSync(file, "utf8"), "#!/bin/sh\nexit 0\n"); assert.equal(mode(file), 0o700);
  fs.writeFileSync(`${file}.tmp`, "crash leftover");
  replaceFileSync(file, Buffer.from("#!/bin/sh\nexit 1\n"), 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), "#!/bin/sh\nexit 1\n"); assert.equal(mode(file), 0o600);
  fs.writeFileSync(target, "user file"); fs.unlinkSync(file); fs.symlinkSync(target, file);
  replaceFileSync(file, "ours", 0o600);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, "utf8"), "user file");
  assert.deepEqual(fs.readdirSync(root).sort(), ["collector.sh", "target"]);
  assert.throws(() => replaceFileSync(path.join(root, "missing-directory", "x"), "ours", 0o600), {code: "ENOENT"});
  assert.deepEqual(fs.readdirSync(root).sort(), ["collector.sh", "target"]);
});

// Invented values in the shapes the patterns name; none is a real credential.
const fake = {
  ingest: "cot_" + "s".repeat(12) + "Zz09",
  bearer: "Bearer " + "abc.def-ghi".repeat(3),
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  github: "ghp_" + "a1".repeat(12),
  slack: "xoxb-" + "1234567890-abcdef",
  jwt: ["eyJhbGciOiJ", "eyJzdWIiOiIx", "c2lnbmF0dXJl"].join("."),
  url: "https://deploy:" + "hunter2" + "@git.example.test/repo.git",
  block: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIfake\n-----END " + "RSA PRIVATE KEY-----",
};
const samples = ["a plain sentence about tokens and passwords in general", "", `export KEY=${fake.ingest} done`, `curl -H "Authorization: ${fake.bearer}" x`,
  `aws ${fake.aws} and ${fake.github}`, `slack ${fake.slack} jwt ${fake.jwt}`, `git clone ${fake.url}`, `before\n${fake.block}\nafter`,
  "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nunterminated", 'config = {"password": "s3cr3t-value", "api_key":"abc123", token=xyz}', "passwd: hunter2, secret = value; client-secret:abc",
  "ACCOUNTKEY=abcdef0123456789", "x".repeat(40_000) + ` ${fake.github}`];

test("the shared scrub is the rule Kiro shipped, with the ingest key masked as keys.ts masks it", () => {
  assert.equal(KIRO_CREDENTIAL_RE, CREDENTIAL_RE);
  const released = (value: string, max: number) => scrubKey(value)
    .replace(/-----BEGIN ([A-Z ]*(?:PRIVATE KEY|CREDENTIAL))-----[\s\S]*?(?:-----END \1-----|$)/gi, "<REDACTED>")
    .replace(new RegExp(CREDENTIAL_RE.source, "gi"), "<REDACTED>")
    .replace(/(["']?(?:api[_-]?key|authorization|client[_-]?secret|password|passwd|secret|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1<REDACTED>")
    .slice(0, max);
  for (const sample of samples) for (const max of [16, 1024, 16_384, sample.length]) assert.equal(scrubCredentials(sample, max), released(sample, max), sample.slice(0, 40));
  assert.equal(scrubCredentials(`key ${fake.ingest}`, 100), "key cot_\u2026Zz09");
  for (const secret of Object.values(fake)) {
    const cleaned = scrubCredentials(`run with ${secret} now`, 16_384);
    assert.equal(cleaned.includes(secret), false, secret.slice(0, 12));
    assert.equal(holdsCredential(`run with ${secret} now`), true);
  }
  assert.equal(scrubCredentials("npm test -- --grep transport", 1024), "npm test -- --grep transport");
  assert.equal(holdsCredential("npm test -- --grep transport"), false);
  assert.equal(holdsCredential("already <REDACTED> once"), true);
  assert.equal(holdsCredential("masked cot_\u2026Zz09"), true);
  assert.equal(scrubCredentials("abcdef", 3), "abc");
});

test("the three patterns are exported in a form a generated program can embed", () => {
  for (const pattern of [CREDENTIAL_RE, CREDENTIAL_BLOCK_RE, SECRET_ASSIGNMENT_RE]) {
    assert.equal(pattern.flags, "i", "no global flag: a shared pattern must not carry match state");
    assert.equal(/[^\x20-\x7e]/.test(pattern.source), false, "ASCII only");
  }
  // Rebuilt from their sources alone, as a standalone program would, they give the module's answer.
  const rebuilt = (value: string, max: number) => scrubKey(value)
    .replace(new RegExp(CREDENTIAL_BLOCK_RE.source, "gi"), "<REDACTED>").replace(new RegExp(CREDENTIAL_RE.source, "gi"), "<REDACTED>")
    .replace(new RegExp(SECRET_ASSIGNMENT_RE.source, "gi"), "$1<REDACTED>").slice(0, max);
  for (const sample of [...samples, ...Object.values(fake)]) assert.equal(rebuilt(sample, 16_384), scrubCredentials(sample, 16_384), sample.slice(0, 40));
  // Calling it twice on the same text gives the same answer: no state is kept between calls.
  assert.equal(scrubCredentials(samples[3], 1024), scrubCredentials(samples[3], 1024));
  assert.equal(holdsCredential(samples[3]), true); assert.equal(holdsCredential(samples[3]), true);
});
