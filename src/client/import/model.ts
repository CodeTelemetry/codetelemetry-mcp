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
