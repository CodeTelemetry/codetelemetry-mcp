// Intermediate model shared by the session-history importers (#165 re-implementation).
//
// Each source parser (Claude Code transcripts, Codex rollouts) reduces one local
// session to an `ImportedSession`; `convert.ts` turns that into OTLP-ready
// records. Only facts actually present in the local files live here. Anything
// only live OTEL records — API latency, permission decisions, active time,
// execution-time tool durations — is deliberately absent and must never be
// fabricated downstream.
//
// This module is pure (no node: imports) so a browser upload can share it.

export type ImportSource = "claude-code" | "codex";

export type Primitive = string | number | boolean;
export type ImportAttributes = Record<string, Primitive | undefined>;

/**
 * Which captured CONTENT an import may carry, mirroring the live exporters'
 * opt-in flags. Every flag off is the conservative default: counts, sizes,
 * models and tool names still ship, text never does.
 *
 *  - `prompts`      ↔ Claude OTEL_LOG_USER_PROMPTS / Codex `log_user_prompt`
 *  - `toolDetails`  ↔ Claude OTEL_LOG_TOOL_DETAILS (tool inputs / parameters)
 *
 * Model response text and tool OUTPUT content are never imported (live needs
 * OTEL_LOG_RAW_API_BODIES / OTEL_LOG_TOOL_CONTENT for those, and a transcript's
 * reconstruction of them is not what those flags capture).
 */
export type ContentPolicy = { prompts: boolean; toolDetails: boolean };

export const NO_CONTENT: ContentPolicy = Object.freeze({ prompts: false, toolDetails: false });
export const ALL_CONTENT: ContentPolicy = Object.freeze({ prompts: true, toolDetails: true });

export type ImportedPrompt = {
  promptId: string;
  tsMs: number;
  /** Prompt text, capped — null unless the parser was asked to keep prompts. */
  text: string | null;
  /** Length of the full prompt text (characters), always known. */
  length: number;
};

/** One billed model response. */
export type ImportedModelCall = {
  /** Deterministic per-response identity: Claude requestId / message.id,
   *  Codex response_id (or a stable positional id for legacy rollouts). */
  responseId: string;
  tsMs: number;
  model: string;
  /** FRESH input tokens (disjoint from the cache buckets). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Nearest preceding human prompt, when attributable. */
  promptId?: string;
};

export type ImportedToolCall = {
  /** Claude tool_use id / Codex call_id. */
  toolUseId: string;
  toolName: string;
  /** Time the RESULT was recorded. */
  tsMs: number;
  /** Stringified tool input, capped — null unless tool details are kept. */
  input: string | null;
  /** Size of the full stringified input (characters). */
  inputBytes: number;
  /** Only when the file states it (Claude is_error / Codex exit code). */
  success?: boolean;
  resultBytes?: number;
  promptId?: string;
};

export type ImportedSession = {
  source: ImportSource;
  sessionId: string;
  /** Every local file folded into this session (main transcript + subagents). */
  files: string[];
  /** `${bytes}:${mtimeMs}` over all files — detects a session that grew. */
  fileSig: string;
  cwd: string | null;
  repositoryUrl?: string;
  parentThreadId?: string;
  startMs: number;
  endMs: number;
  prompts: ImportedPrompt[];
  modelCalls: ImportedModelCall[];
  toolCalls: ImportedToolCall[];
  warnings: string[];
  /** Lines that failed to parse or carried record types we don't import. */
  skippedRecords: number;
  totalRecords: number;
};

/** Hard bound on what one session may hold in memory. A session over it is
 *  refused whole (never imported partially: a truncated session would show
 *  totals that disagree with its events). */
export const MAX_EVENTS_PER_SESSION = 200_000;
export const MAX_PROMPT_CHARS = 64_000;
export const MAX_TOOL_INPUT_CHARS = 16_000;

export const capText = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Tool-input keys that say WHAT a tool touched. A long input keeps them whole
 *  (while they fit) and shortens the bulky values (file contents, patches)
 *  instead. */
export const TOOL_INPUT_KEEP_KEYS: ReadonlySet<string> = new Set(["file_path", "notebook_path", "command", "path"]);

const TRUNCATION_MARK = "…";

/** A string prefix of at most `n` UTF-16 units that never splits a surrogate pair. */
const prefix = (s: string, n: number): string => {
  if (s.length <= n) return s;
  let end = Math.max(0, n);
  if (end > 0 && end < s.length) {
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return s.slice(0, end);
};

function shortenStrings(value: unknown, cap: number, keepKeys: boolean, key?: string): unknown {
  if (typeof value === "string") {
    if (keepKeys && key !== undefined && TOOL_INPUT_KEEP_KEYS.has(key)) return value;
    return value.length > cap ? prefix(value, cap) + TRUNCATION_MARK : value;
  }
  if (Array.isArray(value)) return value.map((v) => shortenStrings(v, cap, keepKeys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shortenStrings(v, cap, keepKeys, k);
    return out;
  }
  return value;
}

const jsonLength = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

/** The longest per-string cap (binary search) whose JSON still fits in `max`. */
function fitStrings(value: unknown, max: number, keepKeys: boolean): string | null {
  // No string longer than `max` can fit, so start from there: it also bounds
  // the work each probe does on a huge input.
  let hi = max;
  if (jsonLength(shortenStrings(value, hi, keepKeys)) <= max) return JSON.stringify(shortenStrings(value, hi, keepKeys));
  let lo = 0;
  if (jsonLength(shortenStrings(value, lo, keepKeys)) > max) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (jsonLength(shortenStrings(value, mid, keepKeys)) <= max) lo = mid;
    else hi = mid;
  }
  return JSON.stringify(shortenStrings(value, lo, keepKeys));
}

/**
 * The exported form of a tool input: its JSON text when it fits in `max`
 * characters, otherwise still VALID JSON within `max` — long string values are
 * shortened (marked with "…"), keeping `file_path` / `notebook_path` /
 * `command` / `path` intact while they fit. A bare slice of the JSON text
 * (the previous behaviour) produced unparseable inputs for every long Write /
 * Edit call. `full` is `JSON.stringify(value)`, already computed by the caller.
 */
export function capToolInput(value: unknown, full: string, max: number): string {
  if (full.length <= max) return full;
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      const fitted = fitStrings(value, max, false);
      if (fitted !== null) return fitted;
    }
    return JSON.stringify({ truncated: true });
  }
  const kept = fitStrings(value, max, true) ?? fitStrings(value, max, false);
  if (kept !== null) return kept;
  // Structure alone (thousands of keys or array items) is over the bound: keep
  // only the identifying keys, shortened if need be.
  const summary: Record<string, unknown> = { truncated: true };
  if (!Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TOOL_INPUT_KEEP_KEYS.has(k) && typeof v === "string") summary[k] = v;
    }
  }
  return fitStrings(summary, max, false) ?? JSON.stringify({ truncated: true });
}

/**
 * Identity attributes per source, stamped as LOG attributes on every imported
 * record exactly as the live exporters send them (Claude Code:
 * organization.id, user.account_id, user.account_uuid, user.email, user.id;
 * Codex: user.account_id, user.email). Resolved by the node paths
 * (identity.ts); a browser upload passes only an email.
 */
export type ImportIdentity = Readonly<Record<string, string>>;
export type IdentityBySource = Partial<Record<ImportSource, ImportIdentity>>;

/** `e***@g***.com` — enough to recognise the account, not to read it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email ? `${email[0]}***` : "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${host ? host[0] : ""}***${tld}`;
}

/** A model-/screen-safe view of an identity: emails masked, ids shortened. */
export function maskIdentity(identity: IdentityBySource): Partial<Record<ImportSource, Record<string, string>>> {
  const out: Partial<Record<ImportSource, Record<string, string>>> = {};
  for (const [source, attrs] of Object.entries(identity) as Array<[ImportSource, ImportIdentity | undefined]>) {
    if (!attrs || Object.keys(attrs).length === 0) continue;
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) masked[k] = k === "user.email" ? maskEmail(v) : v.length > 8 ? `${v.slice(0, 6)}…` : "…";
    out[source] = masked;
  }
  return out;
}

export const MONTH_OF = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
export const DAY_OF = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Every token type counted once, as the plan prices them. */
export const callTokens = (c: Pick<ImportedModelCall, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">): number =>
  c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens;

/** Tokens per UTC month of each model call's own timestamp. */
export function tokensByMonth(session: Pick<ImportedSession, "modelCalls">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of session.modelCalls) {
    const n = callTokens(c);
    if (n <= 0) continue;
    const m = MONTH_OF(c.tsMs);
    out[m] = (out[m] ?? 0) + n;
  }
  return out;
}

export type MonthBucket = { month: string; sessions: number; tokens: number };

/** Add a session (counted in the month it starts) and its per-month tokens to
 *  a sorted month list, in place. */
export function addToMonths(months: MonthBucket[], startMs: number, monthTokens: Record<string, number>): void {
  const bucket = (month: string): MonthBucket => {
    let b = months.find((x) => x.month === month);
    if (!b) {
      b = { month, sessions: 0, tokens: 0 };
      months.push(b);
      months.sort((x, y) => (x.month < y.month ? -1 : x.month > y.month ? 1 : 0));
    }
    return b;
  };
  bucket(MONTH_OF(startMs)).sessions++;
  for (const [month, tokens] of Object.entries(monthTokens)) bucket(month).tokens += tokens;
}

// OTLP-ready flat records.
export type ImportLog = {
  timeUnixNano: string;
  attributes: ImportAttributes;
  body?: string;
};

/** One delta sum data point (token counts). */
export type ImportMetric = {
  name: string;
  timeUnixNano: string;
  startTimeUnixNano: string;
  asInt: number;
  attributes: ImportAttributes;
};

export function toNano(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

/** `source:sessionId` — the ledger identity of a session. */
export function sessionKeyOf(source: ImportSource, sessionId: string): string {
  return `${source}:${sessionId}`;
}

/** Event count a session will hold (the MAX_EVENTS_PER_SESSION bound). */
export function sessionEventCount(s: Pick<ImportedSession, "prompts" | "modelCalls" | "toolCalls">): number {
  return s.prompts.length + s.modelCalls.length + s.toolCalls.length;
}

/**
 * Restrict a session to events inside [sinceMs, untilMs], or null when nothing
 * survives.
 *
 * A long session can straddle the window edge. Importing it whole would ship
 * events older than `--since` and, at the retention boundary, ClickHouse would
 * TTL-delete exactly those rows while the session's end-stamped token metric
 * survived. Trimming keeps the in-window part internally consistent: the token
 * metric is summed from the SURVIVING model calls, so it always matches what
 * was sent.
 */
export function trimSessionToWindow(session: ImportedSession, sinceMs: number, untilMs: number): ImportedSession | null {
  if (session.startMs >= sinceMs && session.endMs <= untilMs) return session;
  const keep = (tsMs: number) => tsMs >= sinceMs && tsMs <= untilMs;
  const prompts = session.prompts.filter((p) => keep(p.tsMs));
  const modelCalls = session.modelCalls.filter((c) => keep(c.tsMs));
  const toolCalls = session.toolCalls.filter((t) => keep(t.tsMs));
  if (prompts.length + modelCalls.length + toolCalls.length === 0) return null;
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const e of [...prompts, ...modelCalls, ...toolCalls]) {
    if (e.tsMs < startMs) startMs = e.tsMs;
    if (e.tsMs > endMs) endMs = e.tsMs;
  }
  return {
    ...session,
    prompts,
    modelCalls,
    toolCalls,
    startMs,
    endMs,
    warnings: [...session.warnings, "session spans the import window; only in-window events were imported"],
  };
}
