import fs from "node:fs/promises";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Durable state shared by the background collectors. `label` names the
// collector in error text only ("Kiro", "Cursor"); it never changes behaviour.

/** Read one bounded JSON state file. A missing file is null; a symlink, an
 * oversized file or malformed JSON is an error, never a silent reset. */
export async function readBoundedJson(file: string, maxBytes: number, label = "Collector"): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`${label} state file is unreadable`);}
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} state file exceeds bound`);
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error(`${label} state file exceeds bound`);
    try {return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, bytesRead)));}
    catch {throw new Error(`${label} state file is not valid JSON`);}
  } finally {await handle.close();}
}

/** Write one bounded JSON state file through a fixed 0600 temporary and a
 * rename, then sync the directory. The directory is created 0700 and may not
 * be a symlink. */
export async function writeAtomicJson(file: string, value: unknown, maxBytes: number, label = "Collector"): Promise<void> {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maxBytes) throw new Error(`${label} persisted state exceeds byte bound`);
  const directory = path.dirname(file);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error(`${label} state directory must not be a symlink`);
  const temporary = path.join(directory, `${path.basename(file)}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {await handle.writeFile(body); await handle.sync();}
  catch {await fs.unlink(temporary).catch(() => {}); throw new Error(`${label} state write failed`);}
  finally {await handle.close();}
  try {
    await fs.rename(temporary, file);
    if (process.platform !== "win32") {
      const dir = await fs.open(directory, "r");
      try {await dir.sync();} finally {await dir.close();}
    }
  } catch {await fs.unlink(temporary).catch(() => {}); throw new Error(`${label} state commit failed`);}
}

/** Replace an owned file through a fixed temporary beside it and a rename.
 * A symlink at the target is replaced, never followed, and a leftover
 * temporary from a crash is removed first. */
export function replaceFileSync(file: string, body: string | Uint8Array, mode: number): void {
  const temporary = `${file}.tmp`;
  rmSync(temporary, {force: true});
  const fd = openSync(temporary, "wx", mode);
  try {
    try {writeFileSync(fd, body); fchmodSync(fd, mode); fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(temporary, file);
  } catch (error) {rmSync(temporary, {force: true}); throw error;}
}

const OWNER_TEMPORARY = /^owner-[a-f0-9-]{36}[.]tmp$/;
export type CollectorStateInventory = {
  /** Files that may exist and are left alone. */
  files: readonly string[];
  /** Fixed temporaries by name with their byte bound; each one found is removed. */
  temporaries: Readonly<Record<string, number>>;
  /** Subdirectories that may exist and are left alone. */
  directories?: readonly string[];
  /** Directory entries inspected before the directory is refused. */
  maxEntries: number;
  /** "refuse" (default) fails on an entry outside the inventory; "ignore" skips it. */
  unknown?: "refuse" | "ignore";
};

/** One fixed temporary per owned file bounds crash leftovers as well as live
 * state. Run under the state claim, before the first write. */
export async function cleanCollectorState(directory: string, inventory: CollectorStateInventory, label = "Collector"): Promise<void> {
  const files = new Set(inventory.files), directories = new Set(inventory.directories ?? []);
  const temporaries = new Map(Object.entries(inventory.temporaries));
  const dir = await fs.opendir(directory, {bufferSize: 8});
  let count = 0;
  try {
    for await (const entry of dir) {
      const limit = OWNER_TEMPORARY.test(entry.name) ? 1024 : temporaries.get(entry.name);
      if (++count > inventory.maxEntries) throw new Error(`unrecognized ${label} state entry`);
      if (entry.isDirectory() && directories.has(entry.name)) continue;
      if (!entry.isFile() || (!files.has(entry.name) && limit === undefined)) {
        if (inventory.unknown === "ignore") continue;
        throw new Error(`unrecognized ${label} state entry`);
      }
      if (limit !== undefined) {
        const file = path.join(directory, entry.name);
        const stat = await fs.lstat(file);
        if (stat.size > limit || !stat.isFile()) throw new Error(`${label} temporary state exceeds bound`);
        await fs.unlink(file);
      }
    }
  } finally {await dir.close().catch(() => {});}
}

/** Runs one fixed system command and returns its output. Injected by tests. */
export type BootIdExecute = (command: string, args: string[]) => string;
const runBootCommand: BootIdExecute = (command, args) =>
  execFileSync(command, args, {encoding: "utf8", timeout: 2000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"]});

/** The kernel's identifier of the current boot, where it publishes one: the
 * boot id file on Linux, the boot session UUID on macOS. It changes at every
 * boot and at no other time, unlike anything derived from the clock (the boot
 * time macOS reports moves when the clock is set). Undefined when the platform
 * has none or it cannot be read; a lease is then judged by its pid alone. */
export function collectorBootId(platform: NodeJS.Platform = process.platform, file = "/proc/sys/kernel/random/boot_id",
  execute: BootIdExecute = runBootCommand): string | undefined {
  if (platform === "darwin") {
    try {
      const id = execute("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).trim().toLowerCase();
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : undefined;
    } catch {return undefined;}
  }
  if (platform !== "linux") return undefined;
  try {
    const fd = openSync(file, "r");
    try {
      const bytes = Buffer.alloc(64), id = bytes.toString("latin1", 0, readSync(fd, bytes, 0, bytes.length, 0)).trim();
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : undefined;
    } finally {closeSync(fd);}
  } catch {return undefined;}
}

/** Exactly one process owns a state directory. Stale dead-PID leases recover;
 * an unknown/live owner is preserved instead of risking overlapping capture.
 * With `boot`, the lease records the boot it was taken under, and a lease from
 * another boot is stale even when its pid is in use again: after a crash or a
 * power loss the next boot hands that pid to an unrelated process, which would
 * otherwise hold the directory for as long as it lives. A lease without a boot
 * is judged by its pid alone. A pid that exists but belongs to another user
 * counts as a live owner. Resolves to the release function. */
export async function claimCollectorState(directory: string, label = "Collector", opts: {boot?: string} = {}): Promise<() => Promise<void>> {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error(`${label} state directory must not be a symlink`);
  const file = path.join(directory, "collector.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Publish a complete owner atomically; a crash before link leaves no
      // ambiguous half-written primary lease.
      const temporary = path.join(directory, `owner-${token}.tmp`);
      const lock = await fs.open(temporary, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({version: 1, pid: process.pid, token, ...(opts.boot === undefined ? {} : {boot: opts.boot})})); await lock.sync();
        await fs.link(temporary, file);
      } finally {await lock.close(); await fs.unlink(temporary).catch(() => {});}
      return async () => {
        const owner = await readBoundedJson(file, 1024, label) as {token?: string} | null;
        if (owner?.token === token) await fs.unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readBoundedJson(file, 1024, label) as {pid?: number; boot?: unknown} | null;
      if (!Number.isSafeInteger(owner?.pid) || (owner?.pid ?? 0) < 1) throw new Error(`${label} collector ownership is unknown`);
      // A lease from another boot has no live owner, whatever holds its pid now.
      let stale = opts.boot !== undefined && typeof owner!.boot === "string" && owner!.boot !== opts.boot;
      if (!stale) {
        let foreign = false;
        try {process.kill(owner!.pid!, 0);}
        catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          // The process exists and belongs to another user: alive, and not ours to signal or replace.
          if (code === "EPERM") foreign = true;
          else if (code !== "ESRCH") throw cause;
          else stale = true;
        }
        if (foreign) throw new Error(`${label} collector is already running as another user (pid ${owner!.pid}); its lock ${file} was left in place`);
      }
      if (!stale) throw new Error(`${label} collector is already running`);
      // Serialize stale cleanup so two recovering processes cannot unlink
      // the other's newly published live owner.
      const recoveryFile = path.join(directory, "collector.recovery");
      let recovery: Awaited<ReturnType<typeof fs.open>>;
      try {recovery = await fs.open(recoveryFile, "wx", 0o600);}
      catch {throw new Error(`${label} ownership recovery needs inspection`);}
      try {
        await recovery.writeFile(JSON.stringify({pid: process.pid, token})); await recovery.sync();
        const current = await readBoundedJson(file, 1024, label) as {pid?: number; token?: string} | null;
        if (current?.pid !== owner!.pid || current?.token !== (owner as {token?: string}).token) throw new Error(`${label} ownership changed during recovery`);
        await fs.unlink(file);
      } finally {await recovery.close(); await fs.unlink(recoveryFile);}
    }
  }
  throw new Error(`${label} collector ownership changed during recovery`);
}
