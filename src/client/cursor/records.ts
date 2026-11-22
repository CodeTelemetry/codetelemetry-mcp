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
/** The hooks whose records are uploaded. The other two only supply context. */
export const CURSOR_UPLOADED_HOOKS: readonly CursorHookEvent[] = ["beforeSubmitPrompt", "stop", "postToolUse", "postToolUseFailure"];

const KIB = 1024, MIB = 1024 * KIB, MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export const CURSOR_LIMITS = Object.freeze({
  // The wire contract: one envelope, and one record inside it.
  envelopeBytes: 256 * KIB,
  envelopeRecords: 256,
  recordBytes: 32 * KIB,
  models: 4,
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
  thoughts: 16,
  sandboxFlags: 32,
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
  /** Not of the latest prompt's turn by position: read before that prompt, or
   *  left over when a stop found its own thoughts by turn key. */
  prior?: true;
};
export type CursorConversation = {
  id: string;
  /** `generation_id` of the latest prompt. */
  prompt?: string;
  thoughts: CursorThought[];
  /** Raw tool call ids with the sandbox flag their shell execution reported. */
  sandbox: Array<[string, boolean]>;
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

/** The fields of a thought the service may see, or null when it names no model. */
function thoughtOf(source: Fields): CursorThought | null {
  const thought: CursorThought = {};
  if (isText(source.generation_id, 256)) thought.generation_id = source.generation_id;
  if (isText(source.model, 128)) thought.model = source.model;
  if (isText(source.model_id, 128)) thought.model_id = source.model_id;
  const params = modelParams(source.model_params);
  if (params) thought.model_params = params;
  return thought.model !== undefined || thought.model_id !== undefined ? thought : null;
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
  if (line.hook === "stop") {
    copyText(out, source, "status", 64);
    copyNumber(out, source, "loop_count");
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
  return out;
}

/** One uploaded record, or null when it is over the record bound. The payload
 *  of a line is always smaller than the line, which the hook already bounds, so
 *  only the attached context can take a record past it. */
export function frameCursorRecord(line: CursorSpoolLine, policy: CursorPolicy, context: Fields): ImportLog | null {
  const record = JSON.stringify({ hook: line.hook, payload: cursorSourcePayload(line, policy), context });
  if (Buffer.byteLength(record) > CURSOR_LIMITS.recordBytes) return null;
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

/** Rebuild one saved conversation. A wrong structure is an error; a count above
 *  today's bound keeps its newest entries, so a later release may lower a bound
 *  without stranding a checkpoint. */
function restoreConversation(value: unknown, limits: CursorLimits): CursorConversation {
  if (!isRecord(value) || typeof value.id !== "string" || !IDENTITY.test(value.id) ||
    (value.prompt !== undefined && !isText(value.prompt, 256)) || !Array.isArray(value.thoughts) || !Array.isArray(value.sandbox) ||
    (value.used !== undefined && (!Array.isArray(value.used) || !value.used.every(isEventId)))) throw new Error(INVALID_CONTEXT);
  const conversation: CursorConversation = { id: value.id, thoughts: [], sandbox: [] };
  if (value.prompt !== undefined) conversation.prompt = value.prompt;
  for (const item of value.thoughts.slice(-limits.thoughts)) {
    const thought = isRecord(item) ? thoughtOf(item) : null;
    if (!thought || (item.prior !== undefined && item.prior !== true)) throw new Error(INVALID_CONTEXT);
    if (item.prior === true) thought.prior = true;
    conversation.thoughts.push(thought);
  }
  for (const item of value.sandbox.slice(-limits.sandboxFlags)) {
    if (!Array.isArray(item) || item.length !== 2 || !isText(item[0], 512) || typeof item[1] !== "boolean") throw new Error(INVALID_CONTEXT);
    conversation.sandbox.push([item[0], item[1]]);
  }
  const used = value.used as string[] | undefined;
  if (used?.length) conversation.used = used.slice(-limits.lookahead);
  return conversation;
}

/** Thoughts as the service receives them: one entry per (model, model_id), each
 *  moved to the end when it is seen again, oldest first. */
function distinctModels(thoughts: readonly CursorThought[]): Fields[] {
  const models = new Map<string, Fields>();
  for (const thought of thoughts) {
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

export type CursorAttachment = {
  /** The record's `context`. */
  context: Fields;
  /** Retire what the context used. Call it only once the record is framed. */
  settle: () => void;
};
const NO_CONTEXT: CursorAttachment = Object.freeze({ context: Object.freeze({}), settle: () => {} });

/** What the collector remembers per conversation between records: the latest
 *  prompt's turn, the thoughts not yet attached to a stop and the sandbox flags
 *  not yet attached to a tool record. Hooks are separate processes, so two
 *  records written within milliseconds reach the spool in either order; a
 *  record therefore also looks at the context records that follow it. The state
 *  is a function of the spool alone and is bounded in entries and bytes, least
 *  recently used conversation first to go. */
export class CursorContext {
  private conversations = new Map<string, CursorConversation>();
  private limits: CursorLimits;

  constructor(saved: unknown = [], limits: CursorLimits = CURSOR_LIMITS) {
    if (!Array.isArray(saved)) throw new Error(INVALID_CONTEXT);
    this.limits = limits;
    for (const item of saved.slice(-limits.conversations)) {
      const conversation = restoreConversation(item, limits);
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
    if (conversation.prompt === undefined && !conversation.thoughts.length && !conversation.sandbox.length && !conversation.used) {
      this.conversations.delete(conversation.id);
    }
  }

  private markUsed(conversation: CursorConversation, ids: readonly string[]): void {
    conversation.used = [...(conversation.used ?? []), ...ids].slice(-this.limits.lookahead);
  }

  /** Take in a consumed record: a prompt opens a turn, a thought and a shell
   *  execution wait for the record they belong to. Uploaded tool records and
   *  stops leave no trace of their own. */
  observe(line: CursorSpoolLine): void {
    if (line.hook === "beforeSubmitPrompt") {
      const conversation = this.touch(line.conversation_id);
      if (isText(line.payload.generation_id, 256)) conversation.prompt = line.payload.generation_id;
      else delete conversation.prompt;
      for (const thought of conversation.thoughts) thought.prior = true;
      this.release(conversation);
      return;
    }
    if (line.hook !== "afterAgentThought" && line.hook !== "afterShellExecution") return;
    const known = this.conversations.get(line.conversation_id);
    if (known?.used?.includes(line.id)) {
      // Already attached to a record that was framed before this one was consumed.
      known.used = known.used.filter(id => id !== line.id);
      this.release(known);
      return;
    }
    if (line.hook === "afterAgentThought") {
      const thought = thoughtOf(line.payload);
      if (!thought) return;
      const conversation = this.touch(line.conversation_id);
      conversation.thoughts.push(thought);
      if (conversation.thoughts.length > this.limits.thoughts) conversation.thoughts.shift();
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
    if (line.hook === "postToolUse" || line.hook === "postToolUseFailure") return this.shell(line, ahead);
    return NO_CONTEXT;
  }

  /** The thoughts of a stop's own turn. A thought names its turn in its
   *  `generation_id` (the turn's id, or that id and a suffix), which does not
   *  depend on the order the hooks reached the spool. Only when no thought does
   *  are the thoughts read since the conversation's latest prompt used, and
   *  only for the stop of that prompt. A model of another turn is never attached. */
  private models(line: CursorSpoolLine, ahead: Iterable<CursorSpoolLine>): CursorAttachment {
    const turn = isText(line.payload.generation_id, 256) ? line.payload.generation_id : undefined;
    if (turn === undefined) return NO_CONTEXT;
    const conversation = this.conversations.get(line.conversation_id);
    const ofTurn = (thought: CursorThought): boolean => thought.generation_id !== undefined &&
      (thought.generation_id === turn || thought.generation_id.startsWith(`${turn}-`));
    let seen = conversation?.thoughts.filter(ofTurn) ?? [];
    const later: Array<[string, CursorThought]> = [];
    for (const other of ahead) {
      if (later.length === this.limits.lookahead) break;
      if (other.hook !== "afterAgentThought" || other.conversation_id !== line.conversation_id || conversation?.used?.includes(other.id)) continue;
      const thought = thoughtOf(other.payload);
      if (thought && ofTurn(thought)) later.push([other.id, thought]);
    }
    const keyed = seen.length > 0 || later.length > 0;
    if (!keyed && conversation?.prompt === turn) seen = conversation.thoughts.filter(thought => !thought.prior);
    if (!seen.length && !later.length) return NO_CONTEXT;
    const models = distinctModels([...seen, ...later.map(([, thought]) => thought)]).slice(-this.limits.models);
    return {
      context: { models },
      settle: () => {
        const target = this.touch(line.conversation_id);
        target.thoughts = target.thoughts.filter(thought => !seen.includes(thought));
        // Thoughts name their turn here, so what is left is not this turn's and
        // must not reach a later stop of it through the positional rule.
        if (keyed) for (const thought of target.thoughts) thought.prior = true;
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

  /** The state to persist: a copy, least recently used first, inside every bound. */
  snapshot(): CursorConversation[] {
    const drop = () => this.conversations.delete(this.conversations.keys().next().value!);
    while (this.conversations.size > this.limits.conversations) drop();
    while (this.conversations.size && Buffer.byteLength(JSON.stringify([...this.conversations.values()])) > this.limits.contextBytes) drop();
    return structuredClone([...this.conversations.values()]);
  }
}
