// Codex rollout parser — pure and browser-safe (no node: imports), fed one line
// at a time so the CLI can stream large rollouts. `codex.ts` wraps it with
// filesystem scanning.
//
// One JSON line per record: { timestamp: ISO, type, payload }. Shapes consumed
// (verified against rollouts from Codex 0.14x–0.159; parse defensively):
//   session_meta      payload.{id|session_id, cwd}
//   turn_context      payload.model — the model for the following turns
//   prompts           event_msg user_message {message}            (older)
//                     event_msg item_completed item.type=UserMessage (newer)
//   tokens            token_usage_record {response_id, usage}      (newer, preferred:
//                       one record per billed response, with its id)
//                     event_msg token_count info.{last_token_usage|total_token_usage}
//                       (older; repeated emissions with an unchanged total are
//                       the same response reported twice and are dropped)
//   tools             response_item function_call | custom_tool_call |
//                     local_shell_call {call_id, name, arguments|input|action}
//                     and their *_output twins {call_id, output}; success only
//                     when an exit code / error flag is actually recorded.
// Latency histograms and tool decisions are not in rollouts and never invented.

import type { ContentPolicy, ImportedModelCall, ImportedPrompt, ImportedSession, ImportedToolCall } from "../model.ts";
import { MAX_EVENTS_PER_SESSION, MAX_PROMPT_CHARS, MAX_TOOL_INPUT_CHARS, NO_CONTENT, capText } from "../model.ts";

type Rec = Record<string, any>;
type Usage = { input: number; cached: number; output: number };

const count = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

const usageOf = (u: unknown): Usage | null => {
  if (!u || typeof u !== "object") return null;
  const v = u as Rec;
  return { input: count(v.input_tokens), cached: count(v.cached_input_tokens), output: count(v.output_tokens) };
};

const sizeOf = (value: unknown): number => {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

/** Legacy shell outputs are a JSON string {"output": "...", "metadata": {"exit_code": 0}}. */
const exitCodeSuccess = (output: unknown): boolean | undefined => {
  if (typeof output !== "string" || !output.startsWith("{")) return undefined;
  try {
    const code = JSON.parse(output)?.metadata?.exit_code;
    if (typeof code === "number") return code === 0;
  } catch {
    /* free-form output — no verdict */
  }
  return undefined;
};

const userMessageText = (item: Rec): string => {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((c: Rec) => c && typeof c.text === "string")
    .map((c: Rec) => c.text)
    .join("\n");
};

export type CodexParseOptions = { keep?: ContentPolicy };

export class CodexSessionAccumulator {
  readonly #keep: ContentPolicy;
  readonly #prompts: ImportedPrompt[] = [];
  readonly #records: ImportedModelCall[] = [];
  readonly #counts: ImportedModelCall[] = [];
  readonly #tools: ImportedToolCall[] = [];
  readonly #pending = new Map<string, { name: string; input: string | null; inputBytes: number }>();
  /** Exit verdicts from item_completed CommandExecution / McpToolCall, by item id. */
  readonly #verdicts = new Map<string, boolean>();
  readonly #warnings = new Set<string>();
  #sessionId = "";
  #cwd: string | null = null;
  #model = "";
  #prevTotal: Usage | null = null;
  #skipped = 0;
  #total = 0;
  #overflow = false;

  constructor(opts: CodexParseOptions = {}) {
    this.#keep = opts.keep ?? NO_CONTENT;
  }

  get overflowed(): boolean {
    return this.#overflow;
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
    const p: Rec = r.payload && typeof r.payload === "object" ? r.payload : {};
    if (r.type === "session_meta") {
      if (!this.#sessionId) {
        if (typeof p.id === "string" && p.id) this.#sessionId = p.id;
        else if (typeof p.session_id === "string" && p.session_id) this.#sessionId = p.session_id;
      }
      if (!this.#cwd && typeof p.cwd === "string" && p.cwd) this.#cwd = p.cwd;
      if (typeof p.model === "string" && p.model) this.#model = p.model;
      return;
    }
    if (r.type === "turn_context") {
      if (typeof p.model === "string" && p.model) this.#model = p.model;
      if (!this.#cwd && typeof p.cwd === "string" && p.cwd) this.#cwd = p.cwd;
      return;
    }
    const tsMs = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(tsMs)) {
      this.#skipped++;
      return;
    }
    if (this.#prompts.length + this.#records.length + this.#counts.length + this.#tools.length >= MAX_EVENTS_PER_SESSION) {
      this.#overflow = true;
      return;
    }

    if (r.type === "token_usage_record") {
      const u = usageOf(p.usage);
      const responseId = typeof p.response_id === "string" ? p.response_id : "";
      if (u && responseId) this.#modelCall(this.#records, responseId, tsMs, u);
      else this.#skipped++;
      return;
    }

    if (r.type === "event_msg") {
      if (p.type === "user_message") {
        const text = typeof p.message === "string" ? p.message.trim() : "";
        const id = typeof p.client_id === "string" && p.client_id ? p.client_id : "";
        this.#prompt(id, tsMs, text);
        return;
      }
      if (p.type === "item_completed" && p.item && typeof p.item === "object") {
        const item: Rec = p.item;
        if (item.type === "UserMessage") {
          this.#prompt(typeof item.id === "string" ? item.id : "", tsMs, userMessageText(item).trim());
        } else if (item.type === "CommandExecution" && typeof item.id === "string" && typeof item.exit_code === "number") {
          this.#verdicts.set(item.id, item.exit_code === 0);
        } else if (item.type === "McpToolCall" && typeof item.id === "string" && typeof item.result?.isError === "boolean") {
          this.#verdicts.set(item.id, !item.result.isError);
        }
        return;
      }
      if (p.type === "token_count") {
        this.#tokenCount(p.info, tsMs);
        return;
      }
    }

    if (r.type === "response_item") {
      if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        const callId = typeof p.call_id === "string" ? p.call_id : typeof p.id === "string" ? p.id : "";
        if (!callId) {
          this.#skipped++;
          return;
        }
        const rawInput = p.arguments ?? p.input ?? p.action;
        let full = "";
        if (typeof rawInput === "string") full = rawInput;
        else if (rawInput !== undefined) {
          try {
            full = JSON.stringify(rawInput) ?? "";
          } catch {
            full = "";
          }
        }
        this.#pending.set(callId, {
          name: String(p.name ?? (p.type === "local_shell_call" ? "shell" : "unknown")),
          input: this.#keep.toolDetails && full ? capText(full, MAX_TOOL_INPUT_CHARS) : null,
          inputBytes: full.length,
        });
        return;
      }
      if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
        const callId = typeof p.call_id === "string" ? p.call_id : "";
        const pending = callId ? this.#pending.get(callId) : undefined;
        if (!pending) {
          this.#skipped++;
          return;
        }
        this.#pending.delete(callId);
        const success = exitCodeSuccess(p.output);
        this.#tools.push({
          toolUseId: callId,
          toolName: pending.name,
          tsMs,
          input: pending.input,
          inputBytes: pending.inputBytes,
          ...(success !== undefined ? { success } : {}),
          resultBytes: sizeOf(p.output),
        });
        return;
      }
    }
    // reasoning / agent_message / task_* / world_state / compacted / … — not importable.
    this.#skipped++;
  }

  #prompt(id: string, tsMs: number, text: string): void {
    if (!text || text.startsWith("<")) return;
    this.#prompts.push({
      promptId: id || `${this.#sessionId || "codex"}:p${this.#prompts.length}`,
      tsMs,
      text: this.#keep.prompts ? capText(text, MAX_PROMPT_CHARS) : null,
      length: text.length,
    });
  }

  #modelCall(into: ImportedModelCall[], responseId: string, tsMs: number, u: Usage): void {
    if (u.input + u.output === 0) return;
    // Codex reports cached input as a SUBSET of input. A record that breaks the
    // containment is malformed: the server excludes such rows outright, so the
    // importer refuses it too instead of publishing a clamped guess.
    if (u.cached > u.input) {
      this.#warnings.add("a token record reported more cached than total input tokens (not imported)");
      return;
    }
    into.push({
      responseId,
      tsMs,
      model: this.#model,
      inputTokens: u.input - u.cached,
      outputTokens: u.output,
      cacheReadTokens: u.cached,
      cacheCreationTokens: 0,
    });
  }

  #tokenCount(info: unknown, tsMs: number): void {
    if (!info || typeof info !== "object") return;
    const i = info as Rec;
    const total = usageOf(i.total_token_usage);
    let turn = usageOf(i.last_token_usage);
    if (total && this.#prevTotal &&
      total.input === this.#prevTotal.input && total.cached === this.#prevTotal.cached && total.output === this.#prevTotal.output) {
      return; // the same response reported again (e.g. a rate-limit refresh)
    }
    if (!turn && total) {
      if (this.#prevTotal) {
        const d = {
          input: total.input - this.#prevTotal.input,
          cached: total.cached - this.#prevTotal.cached,
          output: total.output - this.#prevTotal.output,
        };
        if (d.input < 0 || d.cached < 0 || d.output < 0) {
          this.#warnings.add("token counter reset mid-session; that turn's usage was not imported");
          turn = null;
        } else {
          turn = d;
        }
      } else {
        turn = total;
      }
    }
    if (total) this.#prevTotal = total;
    if (turn) this.#modelCall(this.#counts, `${this.#sessionId || "codex"}:t${this.#counts.length}`, tsMs, turn);
  }

  finish(meta: { files: string[]; fileSig: string; fallbackSessionId?: string }): ImportedSession | null {
    // One source of truth per file: per-response records when the rollout has
    // them, else the token_count stream. Mixing both would bill twice.
    const modelCalls = (this.#records.length > 0 ? this.#records : this.#counts).sort((a, b) => a.tsMs - b.tsMs);
    const prompts = [...this.#prompts].sort((a, b) => a.tsMs - b.tsMs);
    const toolCalls = this.#tools
      .map((t) => (t.success === undefined && this.#verdicts.has(t.toolUseId) ? { ...t, success: this.#verdicts.get(t.toolUseId) } : t))
      .sort((a, b) => a.tsMs - b.tsMs);
    if (prompts.length + modelCalls.length + toolCalls.length === 0) return null;

    let p = -1;
    for (const c of modelCalls) {
      while (p + 1 < prompts.length && prompts[p + 1].tsMs <= c.tsMs) p++;
      if (p >= 0) c.promptId = prompts[p].promptId;
    }
    p = -1;
    for (const t of toolCalls) {
      while (p + 1 < prompts.length && prompts[p + 1].tsMs <= t.tsMs) p++;
      if (p >= 0) t.promptId = prompts[p].promptId;
    }

    let startMs = Infinity;
    let endMs = -Infinity;
    for (const e of [...prompts, ...modelCalls, ...toolCalls]) {
      if (e.tsMs < startMs) startMs = e.tsMs;
      if (e.tsMs > endMs) endMs = e.tsMs;
    }
    const warnings = [...this.#warnings];
    if (this.#pending.size > 0) warnings.push(`${this.#pending.size} tool call(s) without a recorded output (not imported)`);
    return {
      source: "codex",
      sessionId: this.#sessionId || meta.fallbackSessionId || "codex-session",
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

/** The uuid tail of rollout-<timestamp>-<uuid>.jsonl — the session id when a
 *  rollout has no session_meta record. */
export function codexSessionIdFromName(filePath: string): string | undefined {
  const base = filePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, "") ?? "";
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : undefined;
}

/** Parse a whole rollout held in memory (browser upload, tests). */
export function parseCodexRolloutText(
  raw: string,
  meta: { filePath?: string; fileSig?: string } = {},
  opts: CodexParseOptions = {},
): ImportedSession | null {
  const acc = new CodexSessionAccumulator(opts);
  for (const line of raw.split("\n")) acc.line(line);
  if (acc.overflowed) return null;
  return acc.finish({
    files: meta.filePath ? [meta.filePath] : [],
    fileSig: meta.fileSig ?? `${raw.length}:0`,
    fallbackSessionId: meta.filePath ? codexSessionIdFromName(meta.filePath) : undefined,
  });
}
