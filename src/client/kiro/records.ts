import { createHash } from "node:crypto";
import { looksLikeKey, scrub as scrubKey } from "../keys.ts";
import type { ContentPolicy, ImportLog } from "../import/model.ts";

export const KIRO_LIMITS = Object.freeze({
  sessions: 128, sessionsPerTick: 8, directoryEntriesPerTick: 512,
  readBytesPerSession: 64 * 1024, recordBytes: 128 * 1024,
  recordsPerTick: 1024, logsPerBatch: 256, envelopeBytes: 256 * 1024,
  replayEntriesPerSession: 128, callsPerSession: 32,
  registeredSessions: 8192, parkedReplayEntries: 8, candidateChecksPerTick: 32,
  carrySessions: 256, carryBytes: 32 * 1024 * 1024,
  checkpointBytes: 16 * 1024 * 1024, spoolBytes: 4 * 1024 * 1024,
  toolInputChars: 1024, promptChars: 16 * 1024,
  requestMs: 10_000, retryHorizonMs: 23 * 60 * 60 * 1000,
  maxAttempts: 1000, requestGapMs: 1000,
});
export type KiroCall = {id: string; name: string; executionId: string | null; input?: string; status?: string; denied?: true};
export type KiroRecordState = {seen: Array<[string, string]>; calls: KiroCall[]};
export type KiroRecordCounters = {unknown: number; malformed: number; duplicates: number; callsEvicted: number; missingCalls: number; unsupportedDetails: number};
export const emptyRecordState = (): KiroRecordState => ({seen: [], calls: []});
export const emptyRecordCounters = (): KiroRecordCounters => ({unknown: 0, malformed: 0, duplicates: 0, callsEvicted: 0, missingCalls: 0, unsupportedDetails: 0});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const KIRO_CREDENTIAL_RE = /(?:-----BEGIN [A-Z ]+(?:PRIVATE KEY|CREDENTIAL)-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:api[_-]?key|authorization|client[_-]?secret|password|passwd|secret|token|accountkey)\s*[:=]\s*\S+|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s/]*:[^\s/@]+@)/i;
const sourceId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && !KIRO_CREDENTIAL_RE.test(value) && !looksLikeKey(value) ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export class KiroSourceConflictError extends Error {
  constructor() {super("Kiro source record identity conflicts with previously captured content"); this.name = "KiroSourceConflictError";}
}
function recordDigest(value: unknown): string {
  let nodes = 0;
  const ordered = (item: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) throw new Error("Kiro source structure exceeds bound");
    if (Array.isArray(item)) return item.map(value => ordered(value, depth + 1));
    const record = object(item);
    return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, ordered(record[key], depth + 1)])) : item;
  };
  return hash(JSON.stringify(ordered(value, 0)));
}
/** Preserve the source's sub-millisecond digits instead of substituting receive time. */
function sourceNano(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[.](\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null;
  return String(BigInt(ms) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0")));
}
function scrub(value: string, max: number): string {
  return scrubKey(value)
    .replace(/-----BEGIN ([A-Z ]*(?:PRIVATE KEY|CREDENTIAL))-----[\s\S]*?(?:-----END \1-----|$)/gi,"<REDACTED>")
    .replace(new RegExp(KIRO_CREDENTIAL_RE.source, "gi"), "<REDACTED>")
    .replace(/(["']?(?:api[_-]?key|authorization|client[_-]?secret|password|passwd|secret|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1<REDACTED>")
    .slice(0, max);
}

/** Unknown argument fields can contain private provider metadata. Do not
 * forward them merely because the tool's display name is familiar. */
function allowedToolArgs(name:string,value:unknown):Record<string,unknown>|null {
  const args=object(value);
  if(!args) return null;
  const only=(keys:readonly string[])=>Object.keys(args).every(key=>keys.includes(key));
  if(name==="execute_bash") return only(["command","cwd","run_in_background"]) && typeof args.command==="string" && typeof args.cwd==="string" && typeof args.run_in_background==="boolean" ? args : null;
  if(typeof args.path!=="string") return null;
  if(name==="read_file") return only(["path","offset","limit"]) &&
    (args.offset==null || (Number.isSafeInteger(args.offset)&&Number(args.offset)>=0)) &&
    (args.limit==null || (Number.isSafeInteger(args.limit)&&Number(args.limit)>=1)) ? args : null;
  if(name==="fs_write") return only(["path","text"]) && typeof args.text==="string" ? args : null;
  if(name==="str_replace") return only(["path","oldStr","newStr","replace_all"]) && typeof args.oldStr==="string" && typeof args.newStr==="string" && typeof args.replace_all==="boolean" ? args : null;
  return null;
}

/** Check raw scalar values before JSON encoding. Withhold an entire argument
 * object when secret removal or truncation would change it. */
function privateInput(name:string,value:unknown):string|undefined {
 const args=allowedToolArgs(name,value);if(!args) return undefined;
 const encoded=JSON.stringify(args);if(encoded.length>KIRO_LIMITS.toolInputChars) return undefined;
 if(Object.values(args).some(item=>typeof item==="string" && (scrub(item,item.length)!==item || /<REDACTED>|cot_…/.test(item)))) return undefined;
 return encoded;
}

/** Capture source data only. The private ingest service interprets it. Recent
 * sanitized calls are transport context, never joined or classified here.
 * Existing replay digests and checkpoint offsets remain upgrade-compatible. */
export function applyKiroRecord(state: KiroRecordState, line: Uint8Array, sessionId: string, policy: ContentPolicy,
  counters: KiroRecordCounters): ImportLog[] {
  if (line.byteLength > KIRO_LIMITS.recordBytes || !sourceId(sessionId)) {counters.malformed++; return [];}
  let record: Record<string, unknown> | null;
  try {record = object(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(line)));}
  catch {counters.malformed++; return [];}
  const payload = object(record?.payload);
  if (!record || !payload) {counters.malformed++; return [];}
  const kind = payload.type;
  if (!["user", "tool_call", "tool_result", "usage_summary", "turn_end"].includes(String(kind))) {counters.unknown++; return [];}
  const id = sourceId(record.id), executionId = sourceId(payload.executionId), nano = sourceNano(record.timestamp);
  if (!id || !nano) {counters.malformed++; return [];}
  let digest: string;
  try {digest = recordDigest(record);} catch {counters.malformed++; return [];}
  const identity = hash(id), prior = state.seen.find(entry => entry[0] === identity);
  if (prior) {
    if (prior[1] !== digest) throw new KiroSourceConflictError();
    counters.duplicates++; return [];
  }
  const source: Record<string, unknown> = {type:kind, ...(executionId ? {executionId} : {})};
  if (kind === "user") {
    if (typeof payload.content === "string") {
      source.contentLength = payload.content.length;
      if (policy.prompts) source.content = scrub(payload.content, KIRO_LIMITS.promptChars);
    }
  } else if (kind === "tool_call") {
    const callId = sourceId(payload.toolCallId), name = sourceId(payload.toolName);
    if (!callId || !name || name.length > 128) {counters.malformed++; return [];}
    const input = policy.toolDetails ? privateInput(name,payload.args) : undefined;
    if (policy.toolDetails && input === undefined) counters.unsupportedDetails++;
    const status = sourceId(payload.status);
    state.calls.push({id:callId, name, executionId, ...(input ? {input} : {}), ...(status ? {status} : {})});
    if (state.calls.length > KIRO_LIMITS.callsPerSession) {state.calls.shift(); counters.callsEvicted++;}
  } else if (kind === "tool_result") {
    const callId = sourceId(payload.toolCallId);
    if (!callId) {counters.malformed++; return [];}
    source.toolCallId = callId;
    if (typeof payload.success === "boolean") source.success = payload.success;
  } else if (kind === "usage_summary") {
    if (!executionId || !Array.isArray(payload.promptTurnSummaries) || payload.promptTurnSummaries.length > 16) {counters.malformed++; return [];}
    // Copy only the documented scalar fields. Aggregation and status meaning
    // are private service responsibilities.
    source.promptTurnSummaries = payload.promptTurnSummaries.map(value => {
      const item = object(value);
      return {...(sourceId(item?.unit) ? {unit:item!.unit} : {}), ...(typeof item?.usage === "number" && Number.isFinite(item.usage) ? {usage:item.usage} : {})};
    });
    if (typeof payload.elapsedTime === "number" && Number.isFinite(payload.elapsedTime)) source.elapsedTime = payload.elapsedTime;
    if (sourceId(payload.status)) source.status = payload.status;
  } else {
    if (!executionId) {counters.malformed++; return [];}
    if (sourceId(payload.stopReason)) source.stopReason = payload.stopReason;
  }
  const context = kind === "tool_result" ? state.calls.map(call => {
    // Recheck persisted fields against the active policy, including checkpoints
    // written by the earlier binary. No unknown checkpoint fields are exported.
    let input: string | undefined;
    if (policy.toolDetails && call.input) {
      try {input = privateInput(call.name,JSON.parse(call.input));} catch { /* Withhold unsafe old input. */ }
      if (input === undefined) counters.unsupportedDetails++;
    }
    return {id:sourceId(call.id), name:sourceId(call.name), executionId:sourceId(call.executionId),
      ...(input ? {input} : {}), ...(sourceId(call.status) ? {status:call.status} : call.denied ? {status:"denied"} : {})};
  }) : undefined;
  // Delivery context can retire once it is included with its referring source
  // record. The staged checkpoint commits only after the envelope is accepted;
  // interpretation of the full context remains the service's responsibility.
  if (kind === "tool_result") state.calls = state.calls.filter(call => call.id !== source.toolCallId);
  state.seen.push([identity,digest]);
  if (state.seen.length > KIRO_LIMITS.replayEntriesPerSession) state.seen.shift();
  if (kind === "tool_call") return [];
  return [{timeUnixNano:nano, attributes:{"session.id":sessionId, "source.event.id":id,
    "event.name":"kiro.source_record", "kiro.source.version":1,
    "kiro.source.record":JSON.stringify({payload:source, ...(context ? {context} : {})})}}];
}
