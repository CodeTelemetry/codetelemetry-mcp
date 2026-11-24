// Cursor hook source records: the limits of the wire contract, the checks on one
// spool line, the context the collector keeps per conversation, and the framing
// of one record for upload. The hook program wrote allow-listed fields to a
// local file; this module copies them again by name before anything leaves the
// machine, applies the capture options in force now, and keeps every structure
// bounded. What a record means (token arithmetic, outcomes, model choice, tool
// call identity) is decided by the service, never here.

import { holdsCredentialStrict as holdsCredential, passesSecretArgument } from "../collector/scrub.ts";
import type { ImportAttributes, ImportLog } from "../import/model.ts";
import { toOtlpLogs } from "../import/otlpImport.ts";
import type { CursorPolicy } from "./config.ts";
import { CURSOR_HOOK_EVENTS, CURSOR_HOOK_LIMITS, type CursorHookEvent, type CursorSpoolLine } from "./hookProgram.ts";

export const CURSOR_SOURCE_FORMAT = "cursor-hooks-source-v1";
/** `event.name` of every uploaded record. */
export const CURSOR_SOURCE_EVENT = "cursor.source_record";
export const CURSOR_SOURCE_SERVICE = "cursor";
export const CURSOR_SOURCE_SCOPE = Object.freeze({ name: "codetelemetry-connect.cursor-hooks", version: "1" });
/** The hooks whose records are uploaded. The other three only supply context. */
export const CURSOR_UPLOADED_HOOKS: readonly CursorHookEvent[] = ["beforeSubmitPrompt", "stop", "postToolUse", "postToolUseFailure", "afterAgentResponse"];

const KIB = 1024, MIB = 1024 * KIB, MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export const CURSOR_LIMITS = Object.freeze({
  // The wire contract: one envelope, and one record inside it.
  envelopeBytes: 256 * KIB,
  envelopeRecords: 256,
  recordBytes: 64 * KIB,
  models: 4,
  /** Reasoning entries on one reply record, newest kept. */
  replyThoughts: 32,
  modelParams: 8,
  /** Framing stops here, well inside the wire bound. */
  frameBytes: 200 * KIB,

  // Cadence. One machine starts at most four requests a minute.
  tickMs: 2000,
  /** A record younger than this is not consumed: its companions may still be on their way to disk. */
  settleMs: 2000,
  /** An envelope is framed once this many uploaded records wait, or the oldest is this old. */
  lingerRecords: 64,
  lingerMs: 15_000,
  /** Least time between the starts of two requests, retries included, plus a random part. */
  postGapMs: 15_000,
  postJitterMs: 3000,
  /** A record older than this when it is read is dropped and counted. */
  expireMs: 14 * DAY,
  /** A record stamped further ahead of the clock than this is not a capture
   *  time and is skipped. One stamped less far ahead is sent as it is. */
  futureMs: DAY,

  // Work per tick.
  readBytes: 2 * MIB,
  recordsPerTick: 256,
  linesPerTick: 4096,
  tickBudgetMs: 500,
  /** Spool entries listed in one pass: every segment the hook may keep, and room to spare. */
  spoolEntries: 4096,
  /** Segments older than the expiry age that one pass counts and reclaims. */
  expireSegmentsPerTick: 64,

  // Context kept between records.
  conversations: 64,
  /** Cursor fires a thought twice, so this holds the 32 a reply may carry. */
  thoughts: 64,
  sandboxFlags: 32,
  /** File contents waiting for the Read record of their call. */
  reads: 8,
  lookahead: 16,
  contextBytes: 256 * KIB,

  // Persisted state.
  checkpointBytes: MIB,
  pendingBytes: MIB,
  healthBytes: 16 * KIB,
  rejectedBytes: 16 * MIB,
  rejectedFiles: 256,

  // Delivery.
  requestMs: 10_000,
  retryCapMs: MINUTE,
  authRetryMs: MINUTE,
  slowRetryMs: 15 * MINUTE,
  rejectedRetryMs: Object.freeze([MINUTE, 5 * MINUTE, 30 * MINUTE, HOUR]) as readonly number[],
  /** No schedule waits longer than this, whatever the clock or the service says. */
  maxWaitMs: HOUR,
  /** A refused envelope is set aside this long after its first refusal. */
  quarantineMs: DAY,
  /** An unacknowledged envelope is framed again under a new key after this long. */
  reframeMs: 6 * DAY,
});
/** The same bounds as plain numbers, so a test can lower one. */
export type CursorLimits = Readonly<Record<Exclude<keyof typeof CURSOR_LIMITS, "rejectedRetryMs">, number> & { rejectedRetryMs: readonly number[] }>;

type Fields = Record<string, unknown>;
export type CursorModelParam = { id: string; value: string };
/** One `afterAgentThought`, kept until the stop of its turn is framed. */
export type CursorThought = {
  generation_id?: string;
  model?: string;
  model_id?: string;
  model_params?: CursorModelParam[];
  /** The reasoning text, kept until the reply of its turn is framed. */
  text?: string;
  /** Not of the latest prompt's turn by position: read before that prompt, or
   *  left over when a stop found its own thoughts by turn key. */
  prior?: true;
  /** A stop has taken its model; it is kept for its text alone. */
  done?: true;
};
export type CursorConversation = {
  id: string;
  /** `generation_id` of the latest prompt. */
  prompt?: string;
  thoughts: CursorThought[];
  /** Raw tool call ids with the sandbox flag their shell execution reported. */
  sandbox: Array<[string, boolean]>;
  /** Raw tool call ids with the content their file read returned. */
  reads?: Array<[string, string]>;
  /** Spool ids of context records already attached to a record framed before them. */
  used?: string[];
};

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EVENT_ID = /^[0-9a-f]{32}$/;
/** Nanoseconds as the hook stamps them; nineteen digits reach the year 2286. */
const CAPTURE_TIME = /^\d{1,19}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const CONNECT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const HOOKS: readonly string[] = CURSOR_HOOK_EVENTS;
/** Tool arguments kept under the tool-details option, by tool and value type. */
const TOOL_INPUT: Readonly<Record<string, Readonly<Record<string, "string" | "number" | "boolean">>>> = {
  Shell: { command: "string", cwd: "string", timeout: "number" },
  Read: { file_path: "string" },
  Write: { file_path: "string" },
  Grep: { pattern: "string", glob: "string", file_path: "string", output_mode: "string" },
  Task: { subagent_type: "string", run_in_background: "boolean", model: "string" },
};

const isRecord = (value: unknown): value is Fields => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isEventId = (value: unknown): value is string => typeof value === "string" && EVENT_ID.test(value);

function copyText(out: Fields, source: Fields, key: string, max: number): void {
  if (isText(source[key], max)) out[key] = source[key];
}
function copyInteger(out: Fields, source: Fields, key: string): void {
  if (Number.isSafeInteger(source[key])) out[key] = source[key];
}
function copyNumber(out: Fields, source: Fields, key: string): void {
  if (typeof source[key] === "number" && Number.isFinite(source[key])) out[key] = source[key];
}
function copyFlag(out: Fields, source: Fields, key: string): void {
  if (typeof source[key] === "boolean") out[key] = source[key];
}

/** One spool line as the hook wrote it, or null for anything else: a partial
 *  write, a foreign line, a line from a hook version this collector does not
 *  know. The payload is copied field by field later; here only the frame is
 *  checked, against the grammar the service applies to it. */
export function parseCursorSpoolLine(bytes: Uint8Array): CursorSpoolLine | null {
  if (bytes.byteLength === 0 || bytes.byteLength >= CURSOR_HOOK_LIMITS.lineBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || !isEventId(value.id) ||
    typeof value.t !== "string" || !CAPTURE_TIME.test(value.t) ||
    typeof value.hook !== "string" || !HOOKS.includes(value.hook) ||
    typeof value.conversation_id !== "string" || !IDENTITY.test(value.conversation_id) ||
    !isRecord(value.p) || typeof value.p.prompts !== "boolean" || typeof value.p.toolDetails !== "boolean" ||
    typeof value.p.email !== "boolean" || !isRecord(value.payload)) return null;
  return {
    v: 1,
    id: value.id,
    t: value.t,
    hook: value.hook as CursorHookEvent,
    conversation_id: value.conversation_id,
    p: { prompts: value.p.prompts, toolDetails: value.p.toolDetails, email: value.p.email },
    payload: value.payload,
  };
}

/** Capture time of a line in milliseconds since the epoch. */
export function cursorTimeMs(line: Pick<CursorSpoolLine, "t">): number {
  return Number(BigInt(line.t) / 1_000_000n);
}

function modelParams(value: unknown): CursorModelParam[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs: CursorModelParam[] = [];
  for (const item of value.slice(0, 32)) {
    if (pairs.length === CURSOR_LIMITS.modelParams) break;
    if (isRecord(item) && isText(item.id, 64) && isText(item.value, 64)) pairs.push({ id: item.id, value: item.value });
  }
  return pairs.length ? pairs : undefined;
}

/** The fields of a thought the service may see, its text only `withText`, or
 *  null when it names no model and carries no text. */
function thoughtOf(source: Fields, withText: boolean): CursorThought | null {
  const thought: CursorThought = {};
  if (isText(source.generation_id, 256)) thought.generation_id = source.generation_id;
  if (isText(source.model, 128)) thought.model = source.model;
  if (isText(source.model_id, 128)) thought.model_id = source.model_id;
  const params = modelParams(source.model_params);
  if (params) thought.model_params = params;
  if (withText && isText(source.text, CURSOR_HOOK_LIMITS.thoughtChars)) thought.text = source.text;
  return thought.model !== undefined || thought.model_id !== undefined || thought.text !== undefined ? thought : null;
}

/** A cut never leaves half a character. */
function whole(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

/** A tool's arguments are kept whole or withheld whole: never cut, never redacted. */
function toolInput(name: unknown, raw: unknown, prompts: boolean): Fields | undefined {
  if (typeof name !== "string" || !Object.hasOwn(TOOL_INPUT, name) || !isRecord(raw)) return undefined;
  const out: Fields = {};
  for (const [key, kind] of Object.entries(TOOL_INPUT[name])) {
    const value = raw[key];
    if (Object.hasOwn(raw, key) && typeof value === kind && (kind !== "number" || Number.isFinite(value))) out[key] = value;
  }
  if (name === "Task" && prompts && typeof raw.description === "string") out.description = raw.description;
  const values = Object.values(out);
  if (!values.length || JSON.stringify(out).length > CURSOR_HOOK_LIMITS.inputChars ||
    values.some(value => typeof value === "string" && holdsCredential(value)) ||
    (name === "Shell" && typeof out.command === "string" && passesSecretArgument(out.command))) return undefined;
  return out;
}

function toolResult(raw: unknown): Fields {
  const out: Fields = {};
  if (!isRecord(raw)) return out;
  copyInteger(out, raw, "exit_code");
  copyInteger(out, raw, "output_bytes");
  copyInteger(out, raw, "content_length");
  copyFlag(out, raw, "success");
  copyText(out, raw, "agent_id", 256);
  return out;
}

/** The payload of an uploaded record. A field is copied only by name, with its
 *  type and size checked, so nothing the hook did not allow-list can leave in
 *  it. A field that a capture option adds is kept only when that option was on
 *  when the line was written and is still on now: turning an option off also
 *  reduces what is already on disk. */
export function cursorSourcePayload(line: CursorSpoolLine, policy: CursorPolicy): Fields {
  const source = line.payload, out: Fields = {};
  const prompts = line.p.prompts && policy.prompts, toolDetails = line.p.toolDetails && policy.toolDetails;
  copyText(out, source, "generation_id", 256);
  copyText(out, source, "model", 128);
  copyText(out, source, "model_id", 128);
  copyText(out, source, "cursor_version", 64);
  copyText(out, source, "composer_mode", 32);
  if (toolDetails && isText(source.workspace_root, 2048) && !holdsCredential(source.workspace_root)) out.workspace_root = source.workspace_root;
  if (line.p.email && policy.email && typeof source.user_email === "string" && EMAIL.test(source.user_email)) out.user_email = source.user_email;
  if (line.hook === "beforeSubmitPrompt") {
    copyInteger(out, source, "prompt_length");
    if (prompts && typeof source.prompt === "string" && source.prompt.length <= CURSOR_HOOK_LIMITS.promptChars) out.prompt = source.prompt;
    copyInteger(out, source, "attachment_count");
    return out;
  }
  if (line.hook === "stop" || line.hook === "afterAgentResponse") {
    if (line.hook === "stop") {
      copyText(out, source, "status", 64);
      copyNumber(out, source, "loop_count");
    } else if (prompts) copyText(out, source, "text", CURSOR_HOOK_LIMITS.replyChars);
    // Passed through as reported; the service judges whether a count is sound.
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      const value = source[key];
      if ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 32)) out[key] = value;
    }
    return out;
  }
  copyText(out, source, "tool_name", 128);
  copyText(out, source, "tool_use_id", 512);
  copyNumber(out, source, "duration");
  copyInteger(out, source, "tool_input_size_bytes");
  if (line.hook === "postToolUse") {
    out.result = toolResult(source.result);
  } else {
    copyText(out, source, "failure_type", 64);
    copyFlag(out, source, "is_interrupt");
    copyInteger(out, source, "error_bytes");
  }
  const input = toolDetails ? toolInput(source.tool_name, source.tool_input, prompts) : undefined;
  if (input) out.tool_input = input;
  if (!toolDetails) return out;
  if (line.hook === "postToolUse") {
    copyText(out, source, "output", CURSOR_HOOK_LIMITS.contentChars);
    // What a Write wrote is sent beside its arguments, and only with them.
    if (input && source.tool_name === "Write") copyText(out, source, "content", CURSOR_HOOK_LIMITS.contentChars);
  } else copyText(out, source, "error_message", CURSOR_HOOK_LIMITS.contentChars);
  return out;
}

/** True for a reply record that would carry neither reply text nor reasoning
 *  text. Such a record is not uploaded. */
export function cursorReplyIsEmpty(line: CursorSpoolLine, policy: CursorPolicy, context: Fields): boolean {
  if (line.hook !== "afterAgentResponse") return false;
  const thoughts = context.thoughts;
  return !(Array.isArray(thoughts) && thoughts.length) &&
    !(line.p.prompts && policy.prompts && isText(line.payload.text, CURSOR_HOOK_LIMITS.replyChars));
}

type ContentSlot = { length: number; halve: () => void };
/** Every content string of a record, with the way to shorten it or leave it out. */
function contentSlots(payload: Fields, context: Fields): ContentSlot[] {
  const slots: ContentSlot[] = [];
  const slot = (holder: Fields, key: string, remove: () => void) => {
    const value = holder[key];
    if (typeof value !== "string") return;
    slots.push({ length: value.length, halve: () => {
      const half = whole(value.slice(0, Math.floor(value.length / 2)));
      if (half.length) holder[key] = half; else remove();
    } });
  };
  for (const key of ["output", "error_message", "content", "text"]) slot(payload, key, () => delete payload[key]);
  if (isRecord(context.read)) slot(context.read, "content", () => delete context.read);
  if (Array.isArray(context.thoughts)) {
    const thoughts = context.thoughts as Fields[];
    for (const thought of thoughts) {
      slot(thought, "text", () => {
        thoughts.splice(thoughts.indexOf(thought), 1);
        if (!thoughts.length) delete context.thoughts;
      });
    }
  }
  return slots;
}

/** One uploaded record, or null when it cannot be sent: a reply with nothing to
 *  carry, or a record whose metadata alone is over the record bound. Content
 *  is inside its character cuts already; where the record is still over the
 *  byte bound (text that JSON or UTF-8 widens), its longest content string is
 *  halved until the record fits. Metadata is never shortened. */
export function frameCursorRecord(line: CursorSpoolLine, policy: CursorPolicy, context: Fields): ImportLog | null {
  if (cursorReplyIsEmpty(line, policy, context)) return null;
  const framed = { hook: line.hook, payload: cursorSourcePayload(line, policy), context: structuredClone(context) };
  let record = JSON.stringify(framed);
  while (Buffer.byteLength(record) > CURSOR_LIMITS.recordBytes) {
    const longest = contentSlots(framed.payload, framed.context).reduce<ContentSlot | null>((most, slot) => most && most.length >= slot.length ? most : slot, null);
    if (!longest) return null;
    longest.halve();
    record = JSON.stringify(framed);
  }
  if (cursorReplyIsEmpty({ ...line, payload: framed.payload }, policy, framed.context)) return null;
  return {
    timeUnixNano: line.t,
    attributes: {
      "event.name": CURSOR_SOURCE_EVENT,
      "session.id": line.conversation_id,
      "source.event.id": line.id,
      "cursor.source.version": 1,
      "cursor.source.record": record,
    },
  };
}

function resource(connectVersion: string | undefined): ImportAttributes {
  if (connectVersion !== undefined && !CONNECT_VERSION.test(connectVersion)) throw new Error("invalid Connect version for the Cursor source envelope");
  return { "service.name": CURSOR_SOURCE_SERVICE, "codetelemetry.connect.version": connectVersion };
}

/** The exact request body: one resource, one scope, the given records. */
export function cursorEnvelope(logs: ImportLog[], connectVersion?: string): string {
  return JSON.stringify(toOtlpLogs(logs, resource(connectVersion), CURSOR_SOURCE_SCOPE));
}

const EMPTY_SCOPE_BYTES = Buffer.byteLength(JSON.stringify(toOtlpLogs([], {}, CURSOR_SOURCE_SCOPE)));

/** Bytes one record adds to an envelope, its separator included. */
export function cursorRecordBytes(log: ImportLog): number {
  return Buffer.byteLength(JSON.stringify(toOtlpLogs([log], {}, CURSOR_SOURCE_SCOPE))) - EMPTY_SCOPE_BYTES + 1;
}

const INVALID_CONTEXT = "invalid Cursor checkpoint context";
/** The two content options, as the context applies them. */
type ContentBits = Pick<CursorPolicy, "prompts" | "toolDetails">;
const ALL_CONTENT: ContentBits = Object.freeze({ prompts: true, toolDetails: true });

/** Rebuild one saved conversation. A wrong structure is an error; a count above
 *  today's bound keeps its newest entries, so a later release may lower a bound
 *  without stranding a checkpoint. Content saved under an option that is off
 *  now is left out. */
function restoreConversation(value: unknown, limits: CursorLimits, policy: ContentBits): CursorConversation {
  if (!isRecord(value) || typeof value.id !== "string" || !IDENTITY.test(value.id) ||
    (value.prompt !== undefined && !isText(value.prompt, 256)) || !Array.isArray(value.thoughts) || !Array.isArray(value.sandbox) ||
    (value.reads !== undefined && !Array.isArray(value.reads)) ||
    (value.used !== undefined && (!Array.isArray(value.used) || !value.used.every(isEventId)))) throw new Error(INVALID_CONTEXT);
  const conversation: CursorConversation = { id: value.id, thoughts: [], sandbox: [] };
  if (value.prompt !== undefined) conversation.prompt = value.prompt;
  for (const item of value.thoughts.slice(-limits.thoughts)) {
    if (!isRecord(item) || !thoughtOf(item, true) || (item.prior !== undefined && item.prior !== true) ||
      (item.done !== undefined && item.done !== true)) throw new Error(INVALID_CONTEXT);
    const thought = thoughtOf(item, policy.prompts);
    // Kept for its text alone, and the text may no longer be sent.
    if (!thought || (item.done === true && thought.text === undefined)) continue;
    if (item.prior === true) thought.prior = true;
    if (item.done === true) thought.done = true;
    conversation.thoughts.push(thought);
  }
  for (const item of value.sandbox.slice(-limits.sandboxFlags)) {
    if (!Array.isArray(item) || item.length !== 2 || !isText(item[0], 512) || typeof item[1] !== "boolean") throw new Error(INVALID_CONTEXT);
    conversation.sandbox.push([item[0], item[1]]);
  }
  const reads: Array<[string, string]> = [];
  for (const item of (value.reads as unknown[] | undefined)?.slice(-limits.reads) ?? []) {
    if (!Array.isArray(item) || item.length !== 2 || !isText(item[0], 512) || !isText(item[1], CURSOR_HOOK_LIMITS.contentChars)) throw new Error(INVALID_CONTEXT);
    reads.push([item[0], item[1]]);
  }
  if (reads.length && policy.toolDetails) conversation.reads = reads;
  const used = value.used as string[] | undefined;
  if (used?.length) conversation.used = used.slice(-limits.lookahead);
  return conversation;
}

/** Thoughts as the service receives them: one entry per (model, model_id), each
 *  moved to the end when it is seen again, oldest first. */
function distinctModels(thoughts: readonly CursorThought[]): Fields[] {
  const models = new Map<string, Fields>();
  for (const thought of thoughts) {
    if (thought.model === undefined && thought.model_id === undefined) continue;
    const key = JSON.stringify([thought.model ?? null, thought.model_id ?? null]);
    models.delete(key);
    models.set(key, {
      ...(thought.model !== undefined ? { model: thought.model } : {}),
      ...(thought.model_id !== undefined ? { model_id: thought.model_id } : {}),
      ...(thought.model_params ? { model_params: thought.model_params } : {}),
    });
  }
  return [...models.values()];
}

/** True when a thought belongs to the turn: its `generation_id` is the turn's,
 *  or the turn's and a suffix. */
const ofTurn = (thought: CursorThought, turn: string): boolean => thought.generation_id !== undefined &&
  (thought.generation_id === turn || thought.generation_id.startsWith(`${turn}-`));

export type CursorAttachment = {
  /** The record's `context`. */
  context: Fields;
  /** Retire what the context used. Call it only once the record is framed. */
  settle: () => void;
};
const NO_CONTEXT: CursorAttachment = Object.freeze({ context: Object.freeze({}), settle: () => {} });

/** What the collector remembers per conversation between records: the latest
 *  prompt's turn, the thoughts not yet attached to a stop or a reply, the
 *  sandbox flags and file contents not yet attached to a tool record. Hooks are
 *  separate processes, so two records written within milliseconds reach the
 *  spool in either order; a record therefore also looks at the context records
 *  that follow it. The state is a function of the spool and the capture options
 *  alone and is bounded in entries and bytes, least recently used conversation
 *  first to go. Reasoning text and file content are held only while their
 *  option is on. */
export class CursorContext {
  private conversations = new Map<string, CursorConversation>();
  private limits: CursorLimits;
  private policy: ContentBits;

  constructor(saved: unknown = [], limits: CursorLimits = CURSOR_LIMITS, policy: ContentBits = ALL_CONTENT) {
    if (!Array.isArray(saved)) throw new Error(INVALID_CONTEXT);
    this.limits = limits;
    this.policy = { prompts: policy.prompts, toolDetails: policy.toolDetails };
    for (const item of saved.slice(-limits.conversations)) {
      const conversation = restoreConversation(item, limits, this.policy);
      if (this.conversations.has(conversation.id)) throw new Error(INVALID_CONTEXT);
      this.conversations.set(conversation.id, conversation);
    }
  }

  /** The conversation, moved to the most recently used end. */
  private touch(id: string): CursorConversation {
    const conversation = this.conversations.get(id) ?? { id, thoughts: [], sandbox: [] };
    this.conversations.delete(id);
    this.conversations.set(id, conversation);
    return conversation;
  }

  /** Forget a conversation that holds nothing. */
  private release(conversation: CursorConversation): void {
    if (!conversation.used?.length) delete conversation.used;
    if (!conversation.reads?.length) delete conversation.reads;
    if (conversation.prompt === undefined && !conversation.thoughts.length && !conversation.sandbox.length && !conversation.reads && !conversation.used) {
      this.conversations.delete(conversation.id);
    }
  }

  private markUsed(conversation: CursorConversation, ids: readonly string[]): void {
    conversation.used = [...(conversation.used ?? []), ...ids].slice(-this.limits.lookahead);
  }

  private keep(conversation: CursorConversation, thought: CursorThought): void {
    conversation.thoughts.push(thought);
    if (conversation.thoughts.length > this.limits.thoughts) conversation.thoughts.shift();
  }

  /** A thought as it may be held: its text only when the prompts option was on
   *  when it was written and is on now. */
  private thought(line: CursorSpoolLine): CursorThought | null {
    return thoughtOf(line.payload, line.p.prompts && this.policy.prompts);
  }

  /** The content of a file read, when the tool-details option allows it. */
  private readContent(line: CursorSpoolLine): string | undefined {
    const content = line.payload.content;
    return line.p.toolDetails && this.policy.toolDetails && isText(content, CURSOR_HOOK_LIMITS.contentChars) ? content : undefined;
  }

  /** Take in a consumed record: a prompt opens a turn; a thought, a shell
   *  execution and a file read wait for the record they belong to. Uploaded
   *  tool records, stops and replies leave no trace of their own. */
  observe(line: CursorSpoolLine): void {
    if (line.hook === "beforeSubmitPrompt") {
      const conversation = this.touch(line.conversation_id);
      if (isText(line.payload.generation_id, 256)) conversation.prompt = line.payload.generation_id;
      else delete conversation.prompt;
      for (const thought of conversation.thoughts) thought.prior = true;
      this.release(conversation);
      return;
    }
    if (line.hook !== "afterAgentThought" && line.hook !== "afterShellExecution" && line.hook !== "beforeReadFile") return;
    const known = this.conversations.get(line.conversation_id);
    if (known?.used?.includes(line.id)) {
      // Already attached to a record that was framed before this one was consumed.
      known.used = known.used.filter(id => id !== line.id);
      this.release(known);
      return;
    }
    if (line.hook === "afterAgentThought") {
      const thought = this.thought(line);
      if (thought) this.keep(this.touch(line.conversation_id), thought);
    } else if (line.hook === "beforeReadFile") {
      const content = this.readContent(line);
      if (content === undefined || !isText(line.payload.tool_use_id, 512)) return;
      const conversation = this.touch(line.conversation_id);
      conversation.reads = [...(conversation.reads ?? []), [line.payload.tool_use_id, content] as [string, string]].slice(-this.limits.reads);
    } else if (isText(line.payload.tool_use_id, 512) && typeof line.payload.sandbox === "boolean") {
      const conversation = this.touch(line.conversation_id);
      conversation.sandbox.push([line.payload.tool_use_id, line.payload.sandbox]);
      if (conversation.sandbox.length > this.limits.sandboxFlags) conversation.sandbox.shift();
    }
  }

  /** The context of an uploaded record. `ahead` is every record after it that
   *  has been read, consumed or not. Nothing changes until `settle` runs, so a
   *  record that does not fit its envelope leaves the state as it was. */
  attach(line: CursorSpoolLine, ahead: Iterable<CursorSpoolLine>): CursorAttachment {
    if (line.hook === "stop") return this.models(line, ahead);
    if (line.hook === "afterAgentResponse") return this.reply(line, ahead);
    if (line.hook === "postToolUse" || line.hook === "postToolUseFailure") {
      if (line.hook !== "postToolUse" || line.payload.tool_name !== "Read") return this.shell(line, ahead);
      // `ahead` may be a generator, and two parts read it.
      const later = [...ahead], shell = this.shell(line, later), read = this.read(line, later);
      if (read === NO_CONTEXT) return shell;
      return { context: { ...shell.context, ...read.context }, settle: () => {
        shell.settle();
        read.settle();
      } };
    }
    return NO_CONTEXT;
  }

  /** The thoughts of a turn that follow a record in the spool, with their ids. */
  private later(line: CursorSpoolLine, turn: string, ahead: Iterable<CursorSpoolLine>): Array<[string, CursorThought]> {
    const conversation = this.conversations.get(line.conversation_id), later: Array<[string, CursorThought]> = [];
    for (const other of ahead) {
      if (later.length === this.limits.lookahead) break;
      if (other.hook !== "afterAgentThought" || other.conversation_id !== line.conversation_id || conversation?.used?.includes(other.id)) continue;
      const thought = this.thought(other);
      if (thought && ofTurn(thought, turn)) later.push([other.id, thought]);
    }
    return later;
  }

  /** The thoughts of a stop's own turn. A thought names its turn in its
   *  `generation_id` (the turn's id, or that id and a suffix), which does not
   *  depend on the order the hooks reached the spool. Only when no thought does
   *  are the thoughts read since the conversation's latest prompt used, and
   *  only for the stop of that prompt. A model of another turn is never
   *  attached. A thought that still holds reasoning text stays, marked, for
   *  the reply of its turn. */
  private models(line: CursorSpoolLine, ahead: Iterable<CursorSpoolLine>): CursorAttachment {
    const turn = isText(line.payload.generation_id, 256) ? line.payload.generation_id : undefined;
    if (turn === undefined) return NO_CONTEXT;
    const conversation = this.conversations.get(line.conversation_id);
    const open = conversation?.thoughts.filter(thought => !thought.done) ?? [];
    let seen = open.filter(thought => ofTurn(thought, turn));
    const later = this.later(line, turn, ahead);
    const keyed = seen.length > 0 || later.length > 0;
    if (!keyed && conversation?.prompt === turn) seen = open.filter(thought => !thought.prior);
    const models = distinctModels([...seen, ...later.map(([, thought]) => thought)]).slice(-this.limits.models);
    if (!models.length) return NO_CONTEXT;
    return {
      context: { models },
      settle: () => {
        const target = this.touch(line.conversation_id);
        target.thoughts = target.thoughts.filter(thought => !seen.includes(thought) || thought.text !== undefined);
        for (const thought of seen) thought.done = true;
        // Thoughts name their turn here, so what is left is not this turn's and
        // must not reach a later stop of it through the positional rule.
        if (keyed) for (const thought of target.thoughts) thought.prior = true;
        for (const [, thought] of later) if (thought.text !== undefined) this.keep(target, { ...thought, done: true });
        if (later.length) this.markUsed(target, later.map(([id]) => id));
        this.release(target);
      },
    };
  }

  /** The reasoning text of a reply's own turn, bound by the turn key only: one
   *  entry per distinct text at its first position (Cursor fires a thought
   *  twice), the newest kept. The same thoughts still give the turn's stop its
   *  models, whichever of the two records comes first. */
  private reply(line: CursorSpoolLine, ahead: Iterable<CursorSpoolLine>): CursorAttachment {
    const turn = isText(line.payload.generation_id, 256) ? line.payload.generation_id : undefined;
    if (turn === undefined) return NO_CONTEXT;
    const seen = this.conversations.get(line.conversation_id)?.thoughts.filter(thought => ofTurn(thought, turn)) ?? [];
    const later = this.later(line, turn, ahead);
    if (!seen.length && !later.length) return NO_CONTEXT;
    const texts = new Set<string>();
    for (const thought of [...seen, ...later.map(([, thought]) => thought)]) if (thought.text !== undefined) texts.add(thought.text);
    const thoughts = [...texts].slice(-this.limits.replyThoughts).map(text => ({ text }));
    return {
      context: thoughts.length ? { thoughts } : {},
      settle: () => {
        const target = this.touch(line.conversation_id);
        for (const thought of seen) delete thought.text;
        const spent = (thought: CursorThought) => thought.done === true || (thought.model === undefined && thought.model_id === undefined);
        target.thoughts = target.thoughts.filter(thought => !seen.includes(thought) || !spent(thought));
        for (const [, thought] of later) {
          const { text: _text, ...rest } = thought;
          if (!spent(rest)) this.keep(target, rest);
        }
        if (later.length) this.markUsed(target, later.map(([id]) => id));
        this.release(target);
      },
    };
  }

  /** The sandbox flag of the shell execution with the same raw tool call id,
   *  whether it reached the spool before the tool record or just after it. */
  private shell(line: CursorSpoolLine, ahead: Iterable<CursorSpoolLine>): CursorAttachment {
    const raw = line.payload.tool_use_id;
    if (!isText(raw, 512)) return NO_CONTEXT;
    const conversation = this.conversations.get(line.conversation_id);
    let flag = conversation?.sandbox.find(([id]) => id === raw)?.[1];
    let later: string | undefined;
    if (flag === undefined) {
      const moment = cursorTimeMs(line);
      for (const other of ahead) {
        if (other.hook !== "afterShellExecution" || other.conversation_id !== line.conversation_id || other.payload.tool_use_id !== raw ||
          typeof other.payload.sandbox !== "boolean" || conversation?.used?.includes(other.id) ||
          Math.abs(cursorTimeMs(other) - moment) > this.limits.settleMs) continue;
        flag = other.payload.sandbox;
        later = other.id;
        break;
      }
    }
    if (flag === undefined) return NO_CONTEXT;
    return {
      context: { shell: { sandbox: flag } },
      settle: () => {
        const target = this.touch(line.conversation_id);
        if (later !== undefined) this.markUsed(target, [later]);
        else target.sandbox.splice(target.sandbox.findIndex(([id]) => id === raw), 1);
        this.release(target);
      },
    };
  }

  /** The content of the file read with the same raw tool call id as a Read
   *  record, whether it reached the spool before the record or just after it.
   *  Only a Read record takes it: Cursor reuses one raw id across calls of
   *  different tools. The entry is retired when it is used. */
  private read(line: CursorSpoolLine, ahead: Iterable<CursorSpoolLine>): CursorAttachment {
    const raw = line.payload.tool_use_id;
    if (!isText(raw, 512) || !line.p.toolDetails || !this.policy.toolDetails) return NO_CONTEXT;
    const conversation = this.conversations.get(line.conversation_id);
    let content = conversation?.reads?.find(([id]) => id === raw)?.[1];
    let later: string | undefined;
    if (content === undefined) {
      const moment = cursorTimeMs(line);
      for (const other of ahead) {
        if (other.hook !== "beforeReadFile" || other.conversation_id !== line.conversation_id || other.payload.tool_use_id !== raw ||
          conversation?.used?.includes(other.id) || Math.abs(cursorTimeMs(other) - moment) > this.limits.settleMs) continue;
        content = this.readContent(other);
        if (content === undefined) continue;
        later = other.id;
        break;
      }
    }
    if (content === undefined) return NO_CONTEXT;
    return {
      context: { read: { content } },
      settle: () => {
        const target = this.touch(line.conversation_id);
        if (later !== undefined) this.markUsed(target, [later]);
        else target.reads?.splice(target.reads.findIndex(([id]) => id === raw), 1);
        this.release(target);
      },
    };
  }

  /** The state to persist: a copy, least recently used first, inside every
   *  bound. A conversation that is over the byte bound on its own gives up the
   *  content it holds before it is forgotten. */
  snapshot(): CursorConversation[] {
    const drop = () => this.conversations.delete(this.conversations.keys().next().value!);
    const over = () => Buffer.byteLength(JSON.stringify([...this.conversations.values()])) > this.limits.contextBytes;
    while (this.conversations.size > this.limits.conversations) drop();
    while (this.conversations.size > 1 && over()) drop();
    if (this.conversations.size && over()) {
      for (const conversation of this.conversations.values()) {
        delete conversation.reads;
        for (const thought of conversation.thoughts) delete thought.text;
        conversation.thoughts = conversation.thoughts.filter(thought => !thought.done);
      }
      if (over()) drop();
    }
    return structuredClone([...this.conversations.values()]);
  }
}
