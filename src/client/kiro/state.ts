import { claimCollectorState, cleanCollectorState, readBoundedJson as readBounded, writeAtomicJson as writeAtomic } from "../collector/state.ts";
import { KIRO_LIMITS, type KiroRecordState } from "./records.ts";

export const KIRO_SESSION_ID = /^sess_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const KIRO_WORKSPACE = /^[a-f0-9]{16,64}$/;
export type KiroSessionCheckpoint = {
  id: string; relative: string; physical: string; offset: number; generation?: number; anchor?: string; skipInitialLine?: boolean; skippingOversize?: true; records: KiroRecordState;
  observedSize?: number; observedMtimeMs?: number; activationOffset?: number; awaitingMore?: boolean;
  blocked?: "unsupported_schema" | "source_conflict" | "source_error";
};
export type KiroCheckpoint = {version: 3; rootHash: string; destinationHash: string; cursor: number; retirementCursor: number; sessions: KiroSessionCheckpoint[]; parked: KiroSessionCheckpoint[]};
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
      (call.status !== undefined && (typeof call.status !== "string" || call.status.length > 256)) ||
      (call.denied !== undefined && call.denied !== true)) throw new Error("invalid Kiro call checkpoint");
  }
}
/** A single atomic file owns active and dormant cursors, so crashes cannot
 * publish a retirement without its acknowledged offset. Versions 1 and 2 stay readable;
 * older binaries reject version 3 rather than misreading source-context state. */
export function normalizeKiroCheckpoint(value: unknown, rootHash: string, destinationHash: string): KiroCheckpoint {
  if(value === null) return {version:3,rootHash,destinationHash,cursor:0,retirementCursor:0,sessions:[],parked:[]};
  const v=value as Record<string,unknown>;
  if(!v || (v.version!==1 && v.version!==2 && v.version!==3) || v.rootHash!==rootHash || v.destinationHash!==destinationHash || !Array.isArray(v.sessions) || v.sessions.length>KIRO_LIMITS.sessions || !Number.isSafeInteger(v.cursor) || Number(v.cursor)<0) throw new Error("unsupported Kiro checkpoint contract");
  const parked=v.version!==1?v.parked:[];
  const retirementCursor=v.version!==1?v.retirementCursor:0;
  if(!Array.isArray(parked) || parked.length+v.sessions.length>KIRO_LIMITS.registeredSessions || !Number.isSafeInteger(retirementCursor) || Number(retirementCursor)<0) throw new Error("unsupported Kiro checkpoint registry");
  for(const row of [...v.sessions,...parked]) validateSession(row);
  if(parked.some(row=>(row as KiroSessionCheckpoint).records.seen.length>KIRO_LIMITS.parkedReplayEntries)) throw new Error("oversized Kiro dormant replay ledger");
  if(new Set([...v.sessions,...parked].map(row=>(row as KiroSessionCheckpoint).id)).size!==v.sessions.length+parked.length) throw new Error("duplicate Kiro checkpoint ownership");
  return {version:3,rootHash,destinationHash,cursor:Number(v.cursor),retirementCursor:Number(retirementCursor),sessions:(v.sessions as KiroSessionCheckpoint[]).map(row=>({...row,activationOffset:row.activationOffset??row.offset})),parked:parked as KiroSessionCheckpoint[]};
}
// The state primitives are shared with the other collectors; these wrappers
// keep Kiro's names, signatures and error text.
export async function readBoundedJson(file: string, maxBytes: number): Promise<unknown | null> {
  return readBounded(file, maxBytes, "Kiro");
}
export async function writeAtomicJson(file: string, value: unknown, maxBytes: number): Promise<void> {
  return writeAtomic(file, value, maxBytes, "Kiro");
}

/** One fixed temporary per owned file bounds crash leftovers as well as live state. */
export async function cleanKiroState(directory: string): Promise<void> {
  return cleanCollectorState(directory, {maxEntries: 16,
    files: ["collector.lock", "checkpoint.json", "pending.json", "health.json", "collector.recovery"],
    temporaries: {"checkpoint.json.tmp": KIRO_LIMITS.checkpointBytes, "pending.json.tmp": KIRO_LIMITS.spoolBytes, "health.json.tmp": 4096}}, "Kiro");
}

/** Exactly one process owns a state directory. Stale dead-PID leases recover;
 * an unknown/live owner is preserved instead of risking overlapping capture. */
export async function claimKiroState(directory: string): Promise<() => Promise<void>> {
  return claimCollectorState(directory, "Kiro");
}
