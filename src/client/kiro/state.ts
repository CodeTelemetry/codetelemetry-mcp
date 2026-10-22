import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KIRO_LIMITS, type KiroRecordState } from "./records.ts";

export const KIRO_SESSION_ID = /^sess_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const KIRO_WORKSPACE = /^[a-f0-9]{16,64}$/;
export type KiroSessionCheckpoint = {
  id: string; relative: string; physical: string; offset: number; generation?: number; anchor?: string; skipInitialLine?: boolean; skippingOversize?: true; records: KiroRecordState;
  observedSize?: number; observedMtimeMs?: number; activationOffset?: number; awaitingMore?: boolean;
  blocked?: "unsupported_schema" | "source_conflict" | "source_error";
};
export type KiroCheckpoint = {version: 2; rootHash: string; destinationHash: string; cursor: number; retirementCursor: number; sessions: KiroSessionCheckpoint[]; parked: KiroSessionCheckpoint[]};
export type KiroPending = {version: 1; privacyVersion?: 2; id: string; body: string; digest: string; createdAt: number; attempts: number;
  nextAttemptAt: number; updates: KiroSessionCheckpoint[]};

export function validateSession(value: unknown): asserts value is KiroSessionCheckpoint {
  const v = value as KiroSessionCheckpoint;
  if (!v || typeof v.id !== "string" || typeof v.relative !== "string" || !KIRO_SESSION_ID.test(v.id) || v.relative.split("/").length !== 2 || !KIRO_WORKSPACE.test(v.relative.split("/")[0]) ||
    v.relative.split("/")[1] !== v.id || typeof v.physical !== "string" || v.physical.length > 100 ||
    !Number.isSafeInteger(v.offset) || v.offset < 0 ||
    (v.generation !== undefined && (!Number.isSafeInteger(v.generation) || v.generation < 0)) ||
    (v.anchor !== undefined && !/^[a-f0-9]{64}$/.test(v.anchor)) ||
    (v.skipInitialLine !== undefined && typeof v.skipInitialLine !== "boolean") ||
    (v.skippingOversize !== undefined && v.skippingOversize !== true) ||
    [v.observedSize,v.activationOffset].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) ||
    (v.observedMtimeMs !== undefined && (!Number.isFinite(v.observedMtimeMs) || v.observedMtimeMs < 0)) ||
    (v.awaitingMore !== undefined && typeof v.awaitingMore !== "boolean") ||
    (v.blocked !== undefined && !["unsupported_schema","source_conflict","source_error"].includes(v.blocked)) || !v.records || !Array.isArray(v.records.seen) || !Array.isArray(v.records.calls) ||
    v.records.seen.length > KIRO_LIMITS.replayEntriesPerSession || v.records.calls.length > KIRO_LIMITS.callsPerSession) throw new Error("invalid Kiro checkpoint session");
  for (const pair of v.records.seen) if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error("invalid Kiro replay ledger");
  for (const call of v.records.calls) {
    if (!call || typeof call.id !== "string" || call.id.length > 256 || typeof call.name !== "string" || call.name.length > 128 ||
      (call.executionId !== null && (typeof call.executionId !== "string" || call.executionId.length > 256)) ||
      (call.input !== undefined && (typeof call.input !== "string" || call.input.length > KIRO_LIMITS.toolInputChars)) ||
      (call.denied !== undefined && call.denied !== true)) throw new Error("invalid Kiro call checkpoint");
  }
}
/** A single atomic file owns active and dormant cursors, so crashes cannot
 * publish a retirement without its acknowledged offset. Version 1 stays readable;
 * older binaries reject version 2 rather than silently deleting dormant cursors. */
export function normalizeKiroCheckpoint(value: unknown, rootHash: string, destinationHash: string): KiroCheckpoint {
  if(value === null) return {version:2,rootHash,destinationHash,cursor:0,retirementCursor:0,sessions:[],parked:[]};
  const v=value as Record<string,unknown>;
  if(!v || (v.version!==1 && v.version!==2) || v.rootHash!==rootHash || v.destinationHash!==destinationHash || !Array.isArray(v.sessions) || v.sessions.length>KIRO_LIMITS.sessions || !Number.isSafeInteger(v.cursor) || Number(v.cursor)<0) throw new Error("unsupported Kiro checkpoint contract");
  const parked=v.version===2?v.parked:[];
  const retirementCursor=v.version===2?v.retirementCursor:0;
  if(!Array.isArray(parked) || parked.length+v.sessions.length>KIRO_LIMITS.registeredSessions || !Number.isSafeInteger(retirementCursor) || Number(retirementCursor)<0) throw new Error("unsupported Kiro checkpoint registry");
  for(const row of [...v.sessions,...parked]) validateSession(row);
  if(parked.some(row=>(row as KiroSessionCheckpoint).records.seen.length>KIRO_LIMITS.parkedReplayEntries)) throw new Error("oversized Kiro dormant replay ledger");
  if(new Set([...v.sessions,...parked].map(row=>(row as KiroSessionCheckpoint).id)).size!==v.sessions.length+parked.length) throw new Error("duplicate Kiro checkpoint ownership");
  return {version:2,rootHash,destinationHash,cursor:Number(v.cursor),retirementCursor:Number(retirementCursor),sessions:(v.sessions as KiroSessionCheckpoint[]).map(row=>({...row,activationOffset:row.activationOffset??row.offset})),parked:parked as KiroSessionCheckpoint[]};
}
export async function readBoundedJson(file: string, maxBytes: number): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Kiro state file is unreadable");}
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Kiro state file exceeds bound");
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error("Kiro state file exceeds bound");
    try {return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, bytesRead)));}
    catch {throw new Error("Kiro state file is not valid JSON");}
  } finally {await handle.close();}
}
export async function writeAtomicJson(file: string, value: unknown, maxBytes: number): Promise<void> {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maxBytes) throw new Error("Kiro persisted state exceeds byte bound");
  const directory = path.dirname(file);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Kiro state directory must not be a symlink");
  const temporary = path.join(directory, `${path.basename(file)}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {await handle.writeFile(body); await handle.sync();}
  catch {await fs.unlink(temporary).catch(() => {}); throw new Error("Kiro state write failed");}
  finally {await handle.close();}
  try {
    await fs.rename(temporary, file);
    if (process.platform !== "win32") {
      const dir = await fs.open(directory, "r");
      try {await dir.sync();} finally {await dir.close();}
    }
  } catch {await fs.unlink(temporary).catch(() => {}); throw new Error("Kiro state commit failed");}
}


/** One fixed temporary per owned file bounds crash leftovers as well as live state. */
export async function cleanKiroState(directory: string): Promise<void> {
  const known = new Set(["collector.lock", "checkpoint.json", "pending.json", "health.json", "collector.recovery"]);
  const temporary = new Map([["checkpoint.json.tmp", KIRO_LIMITS.checkpointBytes], ["pending.json.tmp", KIRO_LIMITS.spoolBytes], ["health.json.tmp", 4096]]);
  const dir = await fs.opendir(directory, {bufferSize: 8});
  let count = 0;
  try {
    for await (const entry of dir) {
      if (++count > 16 || !entry.isFile() || (!known.has(entry.name) && !temporary.has(entry.name) && !/^owner-[a-f0-9-]{36}[.]tmp$/.test(entry.name))) throw new Error("unrecognized Kiro state entry");
      const limit = /^owner-[a-f0-9-]{36}[.]tmp$/.test(entry.name) ? 1024 : temporary.get(entry.name);
      if (limit !== undefined) {
        const file = path.join(directory, entry.name);
        const stat = await fs.lstat(file);
        if (stat.size > limit || !stat.isFile()) throw new Error("Kiro temporary state exceeds bound");
        await fs.unlink(file);
      }
    }
  } finally {await dir.close().catch(() => {});}
}

/** Exactly one process owns a state directory. Stale dead-PID leases recover;
 * an unknown/live owner is preserved instead of risking overlapping capture. */
export async function claimKiroState(directory: string): Promise<() => Promise<void>> {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Kiro state directory must not be a symlink");
  const file = path.join(directory, "collector.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Publish a complete owner atomically; a crash before link leaves no
      // ambiguous half-written primary lease.
      const temporary = path.join(directory, `owner-${token}.tmp`);
      const lock = await fs.open(temporary, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({version: 1, pid: process.pid, token})); await lock.sync();
        await fs.link(temporary, file);
      } finally {await lock.close(); await fs.unlink(temporary).catch(() => {});}
      return async () => {
        const owner = await readBoundedJson(file, 1024) as {token?: string} | null;
        if (owner?.token === token) await fs.unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readBoundedJson(file, 1024) as {pid?: number} | null;
      if (!Number.isSafeInteger(owner?.pid) || (owner?.pid ?? 0) < 1) throw new Error("Kiro collector ownership is unknown");
      try {process.kill(owner!.pid!, 0); throw new Error("Kiro collector is already running");}
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
        // Serialize stale cleanup so two recovering processes cannot unlink
        // the other's newly published live owner.
        const recoveryFile = path.join(directory, "collector.recovery");
        let recovery: Awaited<ReturnType<typeof fs.open>>;
        try {recovery = await fs.open(recoveryFile, "wx", 0o600);}
        catch {throw new Error("Kiro ownership recovery needs inspection");}
        try {
          await recovery.writeFile(JSON.stringify({pid: process.pid, token})); await recovery.sync();
          const current = await readBoundedJson(file, 1024) as {pid?: number; token?: string} | null;
          if (current?.pid !== owner!.pid || current?.token !== (owner as {token?: string}).token) throw new Error("Kiro ownership changed during recovery");
          await fs.unlink(file);
        } finally {await recovery.close(); await fs.unlink(recoveryFile);}
      }
    }
  }
  throw new Error("Kiro collector ownership changed during recovery");
}
