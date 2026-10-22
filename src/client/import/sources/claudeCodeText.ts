// Claude Code transcript parser — pure and browser-safe (no node: imports), fed
// one line at a time so the CLI can stream a 100 MB transcript without holding
// it as one string, and a browser upload can share the exact same logic.
// `claudeCode.ts` wraps it with filesystem scanning.
//
// A session is the main transcript `<project>/<sessionId>.jsonl` PLUS its
// subagent transcripts `<project>/<sessionId>/subagents/agent-*.jsonl`
// (isSidechain records carrying the parent's sessionId). Live OTEL bills
// subagent model calls to the parent session, so the importer must too.
//
// Record shapes consumed (Claude Code 2.x; parse defensively, formats drift):
//   type:"user"      — human prompts (message.content string | [{type:"text"}])
//                      and tool-result carriers ([{type:"tool_result", tool_use_id,
//                      is_error?, content}]).
//   type:"assistant" — streamed as several records per API call sharing one
//                      top-level requestId (fallback message.id); usage repeats
//                      on each, the last record carries the settled counts.
//                      content blocks: text | thinking | tool_use{id,name,input}.
//   anything else    — summary / attachment / queue-operation / *-title / … ignored.

import type { ContentPolicy, ImportedModelCall, ImportedPrompt, ImportedSession, ImportedToolCall } from "../model.ts";
import { MAX_EVENTS_PER_SESSION, MAX_PROMPT_CHARS, MAX_TOOL_INPUT_CHARS, NO_CONTENT, capText } from "../model.ts";

type Rec = Record<string, any>;

const textOfBlocks = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: Rec) => b && b.type === "text" && typeof b.text === "string")
    .map((b: Rec) => b.text)
    .join("\n");
};

const sizeOf = (value: unknown): number => {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

const count = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

/** Prompts Claude Code itself injects into the main chain — not typed by a human. */
const injectedPrompt = (text: string): boolean =>
  text.startsWith("<") || text.startsWith("[Request interrupted") || text.startsWith("Caveat: The messages below");

export type ClaudeParseOptions = {
  /** Which content to keep in memory (and later export). Default: none. */
  keep?: ContentPolicy;
};

/**
 * Accumulates one Claude Code session across its transcript files. Feed every
 * line of the main transcript and of each subagent transcript, then `finish()`.
 */
export class ClaudeSessionAccumulator {
  readonly #keep: ContentPolicy;
  readonly #prompts: ImportedPrompt[] = [];
  readonly #tools: ImportedToolCall[] = [];
  readonly #calls = new Map<string, ImportedModelCall>();
  readonly #pending = new Map<string, { name: string; input: string | null; inputBytes: number }>();
  #sessionId = "";
  #cwd: string | null = null;
  #skipped = 0;
  #total = 0;
  #overflow = false;

  constructor(opts: ClaudeParseOptions = {}) {
    this.#keep = opts.keep ?? NO_CONTENT;
  }

  get overflowed(): boolean {
    return this.#overflow;
  }

  #events(): number {
    return this.#prompts.length + this.#tools.length + this.#calls.size;
  }

  line(raw: string): void {
    if (!raw.trim()) return;
    this.#total++;
    if (this.#overflow) return;
    let r: Rec;
    try {
      r = JSON.parse(raw);
    } catch {
      this.#skipped++;
      return;
    }
    if (!r || typeof r !== "object") {
      this.#skipped++;
      return;
    }
    if (!this.#sessionId && typeof r.sessionId === "string") this.#sessionId = r.sessionId;
    if (!this.#cwd && typeof r.cwd === "string" && r.cwd) this.#cwd = r.cwd;
    const tsMs = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if ((r.type === "user" || r.type === "assistant") && r.message && Number.isFinite(tsMs)) {
      if (this.#events() >= MAX_EVENTS_PER_SESSION) {
        this.#overflow = true;
        return;
      }
      if (r.type === "user") this.#user(r, tsMs);
      else this.#assistant(r, tsMs);
      return;
    }
    this.#skipped++;
  }

  #user(r: Rec, tsMs: number): void {
    const content = r.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const pending = this.#pending.get(block.tool_use_id);
        if (!pending) continue;
        this.#pending.delete(block.tool_use_id);
        this.#tools.push({
          toolUseId: block.tool_use_id,
          toolName: pending.name,
          tsMs,
          input: pending.input,
          inputBytes: pending.inputBytes,
          success: block.is_error === true ? false : true,
          resultBytes: sizeOf(block.content),
        });
      }
    }
    const human =
      !r.isSidechain && !r.isMeta && !r.isCompactSummary && !r.isVisibleInTranscriptOnly &&
      (!r.origin || r.origin.kind === "human") && r.message.role === "user";
    if (!human) return;
    const text = textOfBlocks(content).trim();
    if (!text || injectedPrompt(text)) return;
    const promptId = typeof r.promptId === "string" && r.promptId ? r.promptId
      : typeof r.uuid === "string" && r.uuid ? r.uuid : `${this.#sessionId || "session"}:p${this.#prompts.length}`;
    this.#prompts.push({
      promptId,
      tsMs,
      text: this.#keep.prompts ? capText(text, MAX_PROMPT_CHARS) : null,
      length: text.length,
    });
  }

  #assistant(r: Rec, tsMs: number): void {
    const model = typeof r.message.model === "string" ? r.message.model : "";
    const responseId = String(r.requestId ?? r.message.id ?? "");
    const content = r.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "tool_use" && typeof block.id === "string") {
          let full = "";
          try {
            full = block.input === undefined ? "" : JSON.stringify(block.input) ?? "";
          } catch {
            full = "";
          }
          this.#pending.set(block.id, {
            name: String(block.name ?? "unknown"),
            input: this.#keep.toolDetails && full ? capText(full, MAX_TOOL_INPUT_CHARS) : null,
            inputBytes: full.length,
          });
        }
      }
    }
    // Synthetic records (API error notices, `<synthetic>` model) bill nothing.
    if (!responseId || model === "<synthetic>" || r.isApiErrorMessage) return;
    const usage = r.message.usage;
    if (!usage || typeof usage !== "object") return;
    const prev = this.#calls.get(responseId);
    this.#calls.set(responseId, {
      responseId,
      tsMs: prev?.tsMs ?? tsMs,
      model: model || prev?.model || "",
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheCreationTokens: count(usage.cache_creation_input_tokens),
    });
  }

  finish(meta: { files: string[]; fileSig: string; fallbackSessionId?: string }): ImportedSession | null {
    const modelCalls = [...this.#calls.values()].filter(
      (c) => c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens > 0,
    );
    const prompts = [...this.#prompts].sort((a, b) => a.tsMs - b.tsMs);
    const toolCalls = [...this.#tools].sort((a, b) => a.tsMs - b.tsMs);
    modelCalls.sort((a, b) => a.tsMs - b.tsMs);
    if (prompts.length + modelCalls.length + toolCalls.length === 0) return null;

    // Attribute model calls and tools (main chain AND subagents, whose files are
    // read separately) to the latest human prompt at or before them.
    let p = -1;
    const attribute = <T extends { tsMs: number; promptId?: string }>(items: T[]): void => {
      p = -1;
      for (const item of items) {
        while (p + 1 < prompts.length && prompts[p + 1].tsMs <= item.tsMs) p++;
        if (p >= 0) item.promptId = prompts[p].promptId;
      }
    };
    attribute(modelCalls);
    attribute(toolCalls);

    let startMs = Infinity;
    let endMs = -Infinity;
    for (const e of [...prompts, ...modelCalls, ...toolCalls]) {
      if (e.tsMs < startMs) startMs = e.tsMs;
      if (e.tsMs > endMs) endMs = e.tsMs;
    }
    const warnings: string[] = [];
    if (this.#pending.size > 0) warnings.push(`${this.#pending.size} tool call(s) without a recorded result (not imported)`);
    return {
      source: "claude-code",
      sessionId: this.#sessionId || meta.fallbackSessionId || "claude-session",
      files: meta.files,
      fileSig: meta.fileSig,
      cwd: this.#cwd,
      startMs,
      endMs,
      prompts,
      modelCalls,
      toolCalls,
      warnings,
      skippedRecords: this.#skipped,
      totalRecords: this.#total,
    };
  }
}

/** Parse a whole transcript held in memory (browser upload, tests). */
export function parseClaudeTranscriptText(
  raw: string,
  meta: { filePath?: string; fileSig?: string } = {},
  opts: ClaudeParseOptions = {},
): ImportedSession | null {
  const acc = new ClaudeSessionAccumulator(opts);
  for (const line of raw.split("\n")) acc.line(line);
  if (acc.overflowed) return null;
  const base = (meta.filePath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  return acc.finish({
    files: meta.filePath ? [meta.filePath] : [],
    fileSig: meta.fileSig ?? `${raw.length}:0`,
    fallbackSessionId: base.replace(/\.jsonl$/, "") || undefined,
  });
}
