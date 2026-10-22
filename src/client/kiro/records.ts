import { createHash } from "node:crypto";
import { looksLikeKey, scrub as scrubKey } from "../keys.ts";
import type { ContentPolicy, ImportAttributes, ImportLog } from "../import/model.ts";

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
export type KiroCall = {id: string; name: string; executionId: string | null; input?: string; denied?: true};
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
function semanticDigest(value: unknown): string {
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
function verifiedToolArgs(name:string,value:unknown):Record<string,unknown>|null {
  const args=object(value);
  if(!args) return null;
  const only=(keys:readonly string[])=>Object.keys(args).every(key=>keys.includes(key));
  if(name==="execute_bash") return only(["command","cwd","run_in_background"]) && typeof args.command==="string" && typeof args.cwd==="string" && args.run_in_background===false ? args : null;
  if(typeof args.path!=="string") return null;
  if(name==="read_file") return only(["path","offset","limit"]) &&
    (args.offset==null || (Number.isSafeInteger(args.offset)&&Number(args.offset)>=0)) &&
    (args.limit==null || (Number.isSafeInteger(args.limit)&&Number(args.limit)>=1)) ? args : null;
  if(name==="fs_write") return only(["path","text"]) && typeof args.text==="string" ? args : null;
  if(name==="str_replace") return only(["path","oldStr","newStr","replace_all"]) && typeof args.oldStr==="string" && typeof args.newStr==="string" && typeof args.replace_all==="boolean" ? args : null;
  return null;
}

/** Redacted/truncated tool text cannot support exact edit or command facts.
 * Check raw scalar values before JSON encoding; never export modified input. */
function verifiedEncodedInput(name:string,value:unknown):string|undefined {
 const args=verifiedToolArgs(name,value);if(!args) return undefined;
 const encoded=JSON.stringify(args);if(encoded.length>KIRO_LIMITS.toolInputChars) return undefined;
 if(Object.values(args).some(item=>typeof item==="string" && (scrub(item,item.length)!==item || /<REDACTED>|cot_…/.test(item)))) return undefined;
 return encoded;
}

/** Mutates staged state only; persist after its emitted logs are acknowledged.
 * Assistant notes, reasoning, signatures and hook payloads never leave this parser. */
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
  try {digest = semanticDigest(record);} catch {counters.malformed++; return [];}
  const identity = hash(id), prior = state.seen.find(entry => entry[0] === identity);
  if (prior) {
    if (prior[1] !== digest) throw new KiroSourceConflictError();
    counters.duplicates++; return [];
  }
  const attrs: ImportAttributes = {"session.id": sessionId, "source.event.id": id,
    "telemetry.source": "kiro-v3-local-transcript", "telemetry.contract.version": 1};
  if (executionId) attrs["source.execution.id"] = executionId;
  const log = (name: string): ImportLog[] => {attrs["event.name"] = name; return [{timeUnixNano: nano, attributes: attrs}];};
  let logs: ImportLog[] = [];
  if (kind === "user") {
    attrs["prompt.id"] = id; attrs.request_id = id;
    if (typeof payload.content === "string") {
      attrs.prompt_length = payload.content.length;
      if (policy.prompts) attrs.prompt = scrub(payload.content, KIRO_LIMITS.promptChars);
    }
    logs = log("user_prompt");
  } else if (kind === "tool_call") {
    const callId = sourceId(payload.toolCallId), name = sourceId(payload.toolName);
    if (!callId || !name || name.length > 128) {counters.malformed++; return [];}
    const existing = state.calls.find(call => call.id === callId);
    if (existing && (existing.name !== name || existing.executionId !== executionId)) throw new KiroSourceConflictError();
    let input: string | undefined;
    // ELL-414's controlled corpus proves these closed shapes only. Never
    // truncate JSON into an invalid partial command or edit measurement.
    if(policy.toolDetails) input=verifiedEncodedInput(name,payload.args);
    if(policy.toolDetails && !input) counters.unsupportedDetails++;
    if (existing && payload.status === "denied") existing.denied = true;
    if (!existing) state.calls.push({id: callId, name, executionId, ...(input ? {input} : {}), ...(payload.status === "denied" ? {denied: true as const} : {})});
    if (state.calls.length > KIRO_LIMITS.callsPerSession) {state.calls.shift(); counters.callsEvicted++;}
  } else if (kind === "tool_result") {
    const callId = sourceId(payload.toolCallId);
    if (!callId) {counters.malformed++; return [];}
    const index = state.calls.findIndex(call => call.id === callId);
    const call = index >= 0 ? state.calls[index] : undefined;
    if (call && call.executionId !== executionId) throw new KiroSourceConflictError();
    attrs.call_id = callId;
    if (typeof payload.success === "boolean") attrs.success = payload.success;
    if (call) {
      if (call.denied && payload.success === true) throw new KiroSourceConflictError();
      if (call.denied) attrs.decision = "deny";
      attrs.tool_name = call.name;
      if(policy.toolDetails && call.input){
        let verified:string|undefined;
        try {verified=verifiedEncodedInput(call.name,JSON.parse(call.input));}catch { /* Older truncated inputs remain unreadable details. */ }
        if(verified) attrs.tool_input=verified;else counters.unsupportedDetails++;
      }
      state.calls.splice(index, 1);
    } else counters.missingCalls++;
    logs = log("tool_result");
  } else if (kind === "usage_summary") {
    if (!executionId || !Array.isArray(payload.promptTurnSummaries) || payload.promptTurnSummaries.length > 16) {counters.malformed++; return [];}
    const credits = payload.promptTurnSummaries.map(object).filter(item => item?.unit === "credit");
    if (!credits.length || credits.some(item => typeof item!.usage !== "number" || !Number.isFinite(item!.usage) || (item!.usage as number) < 0)) {counters.malformed++; return [];}
    const amount = credits.reduce((total, item) => total + (item!.usage as number), 0);
    if (!Number.isFinite(amount) || amount > 1_000_000) {counters.malformed++; return [];}
    attrs.request_id = id; attrs["usage.provider"] = "kiro"; attrs["usage.unit"] = "credit"; attrs["usage.amount"] = amount;
    if (typeof payload.elapsedTime === "number" && Number.isInteger(payload.elapsedTime) && payload.elapsedTime >= 0 && payload.elapsedTime <= 86_400_000) attrs["turn.elapsed_ms"] = payload.elapsedTime;
    attrs["turn.status"] = ["success", "failure", "cancelled"].includes(String(payload.status)) ? String(payload.status) : "unknown";
    logs = log("provider_turn_usage");
  } else {
    if (!executionId) {counters.malformed++; return [];}
    attrs.request_id = id;
    attrs["turn.stop_reason"] = ["end_turn", "cancelled", "error"].includes(String(payload.stopReason)) ? String(payload.stopReason) : "unknown";
    attrs["turn.status"] = "unknown";
    logs = log("turn_completion");
  }
  state.seen.push([identity, digest]);
  if (state.seen.length > KIRO_LIMITS.replayEntriesPerSession) state.seen.shift();
  return logs;
}
