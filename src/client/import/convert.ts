// ImportedSession → OTLP-ready records in each assistant's NATIVE live shapes,
// so the existing ingest-time facts (materialized columns, parse/fact MVs) and
// every dashboard read treat imported rows exactly like live ones
// (packages/api/src/telemetryNormalize.ts is the contract):
//
//   Claude → user_prompt + tool_result log events under service "claude-code",
//            plus claude_code.token.usage delta points per (model, type, UTC hour).
//   Codex  → codex.user_prompt / codex.sse_event (event.kind=response.completed)
//            / codex.tool_result under service "codex-cli". Token counts reach
//            the dashboards through the same sse_event log union live Codex
//            uses, so no metrics are emitted.
//
// Honesty by construction: nothing here emits a shape whose meaning a transcript
// cannot honour. No Claude `api_request` / `api_error` (per-request latency,
// retries and invocation counts stay live-only, so model-latency coverage never
// turns on from history), no `tool_decision`, no `duration_ms` anywhere (a
// transcript's call→result gap includes human waits, unlike live execution
// time), no `cost_usd` (the server prices tokens with its own table, as it does
// for live token metrics), no active-time / session-count metrics, no Codex
// latency histograms. IMPORT_FORBIDDEN_* below pins that contract in tests.
//
// Every log row carries a deterministic vendor id (prompt.id / tool_use_id /
// call_id) and the transcript's own timestamp, so a re-sent log batch collapses
// in the read-time replay identity. Token METRIC points do not collapse (the
// collector stamps per-delivery ids into their identity), which is why the run
// protocol in run.ts never sends a metric part twice.

import type { ContentPolicy, ImportAttributes, ImportLog, ImportMetric, ImportedSession } from "./model.ts";
import { toNano } from "./model.ts";

export const CLAUDE_SERVICE = "claude-code";
export const CODEX_SERVICE = "codex-cli";
export const TOKEN_USAGE_METRIC = "claude_code.token.usage";

/** The sentinel live exporters send when a content flag is off; every
 *  "has content" fact (mat_has_prompt, coverage probes) treats it as absent. */
export const REDACTED = "<REDACTED>";

/** Commit marker: the LAST record of a session's import, posted only after
 *  every log and metric part was accepted. Twin of the constant the server's
 *  import-status read keys on (packages/api/src/import/importStatus.ts). */
export const IMPORT_COMPLETE_EVENT = "import.session_complete";

/** Event names and attributes an import must never emit (see header). */
export const IMPORT_FORBIDDEN_EVENTS: readonly string[] = Object.freeze([
  "api_request", "api_error", "api_request_body", "api_response_body", "tool_decision",
  "codex.tool_decision", "codex.api_request",
]);
export const IMPORT_FORBIDDEN_ATTRIBUTES: readonly string[] = Object.freeze(["duration_ms", "cost_usd"]);
export const IMPORT_FORBIDDEN_METRICS: readonly string[] = Object.freeze([
  "claude_code.active_time.total", "claude_code.session.count", "claude_code.cost.usage",
  "claude_code.lines_of_code.count", "claude_code.commit.count", "claude_code.pull_request.count",
  "claude_code.code_edit_tool.decision",
]);

export type ConvertedSession = { logs: ImportLog[]; metrics: ImportMetric[] };

const clean = (attrs: ImportAttributes): ImportAttributes => {
  const out: ImportAttributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
};

const iso = (ms: number): string => new Date(ms).toISOString();
const bool = (v: boolean | undefined): string | undefined => (v === undefined ? undefined : v ? "true" : "false");
const HOUR_MS = 3_600_000;

type Staged = { tsMs: number; order: number; attributes: ImportAttributes };

function finishLogs(staged: Staged[]): ImportLog[] {
  staged.sort((a, b) => a.tsMs - b.tsMs || a.order - b.order);
  return staged.map((s) => ({ timeUnixNano: toNano(s.tsMs), attributes: s.attributes }));
}

function convertClaude(session: ImportedSession, content: ContentPolicy): ConvertedSession {
  const staged: Staged[] = [];
  let order = 0;
  for (const p of session.prompts) {
    staged.push({
      tsMs: p.tsMs,
      order: order++,
      attributes: clean({
        "event.name": "user_prompt",
        "event.timestamp": iso(p.tsMs),
        "session.id": session.sessionId,
        "prompt.id": p.promptId,
        prompt: content.prompts && p.text !== null ? p.text : REDACTED,
        prompt_length: p.length,
      }),
    });
  }
  for (const t of session.toolCalls) {
    staged.push({
      tsMs: t.tsMs,
      order: order++,
      attributes: clean({
        "event.name": "tool_result",
        "event.timestamp": iso(t.tsMs),
        "session.id": session.sessionId,
        "prompt.id": t.promptId,
        tool_name: t.toolName,
        tool_use_id: t.toolUseId,
        success: bool(t.success),
        ...(content.toolDetails && t.input !== null ? { tool_input: t.input } : {}),
        tool_input_size_bytes: t.inputBytes || undefined,
        tool_result_size_bytes: t.resultBytes,
      }),
    });
  }

  // Delta token points per (model, type, UTC hour): day- and hour-accurate like
  // live export intervals, while a long session stays a bounded handful of points.
  type Bucket = { firstMs: number; lastMs: number; total: number; model: string; type: string };
  const buckets = new Map<string, Bucket>();
  for (const c of session.modelCalls) {
    const hour = Math.floor(c.tsMs / HOUR_MS);
    for (const [type, n] of [
      ["input", c.inputTokens],
      ["output", c.outputTokens],
      ["cacheRead", c.cacheReadTokens],
      ["cacheCreation", c.cacheCreationTokens],
    ] as const) {
      if (n <= 0) continue;
      const key = `${c.model}\u0000${type}\u0000${hour}`;
      const b = buckets.get(key);
      if (b) {
        b.total += n;
        b.firstMs = Math.min(b.firstMs, c.tsMs);
        b.lastMs = Math.max(b.lastMs, c.tsMs);
      } else {
        buckets.set(key, { firstMs: c.tsMs, lastMs: c.tsMs, total: n, model: c.model, type });
      }
    }
  }
  const metrics: ImportMetric[] = [...buckets.values()]
    .sort((a, b) => a.lastMs - b.lastMs || a.model.localeCompare(b.model) || a.type.localeCompare(b.type))
    .map((b) => ({
      name: TOKEN_USAGE_METRIC,
      timeUnixNano: toNano(b.lastMs),
      startTimeUnixNano: toNano(b.firstMs),
      asInt: b.total,
      attributes: clean({ "session.id": session.sessionId, model: b.model || undefined, type: b.type }),
    }));
  return { logs: finishLogs(staged), metrics };
}

function convertCodex(session: ImportedSession, content: ContentPolicy): ConvertedSession {
  const staged: Staged[] = [];
  let order = 0;
  for (const p of session.prompts) {
    staged.push({
      tsMs: p.tsMs,
      order: order++,
      attributes: clean({
        "event.name": "codex.user_prompt",
        "event.timestamp": iso(p.tsMs),
        "conversation.id": session.sessionId,
        "prompt.id": p.promptId,
        prompt: content.prompts && p.text !== null ? p.text : REDACTED,
        prompt_length: p.length,
      }),
    });
  }
  for (const c of session.modelCalls) {
    staged.push({
      tsMs: c.tsMs,
      order: order++,
      attributes: clean({
        "event.name": "codex.sse_event",
        "event.kind": "response.completed",
        "event.timestamp": iso(c.tsMs),
        "conversation.id": session.sessionId,
        model: c.model || undefined,
        // Codex's wire convention: input INCLUDES the cached portion; the server
        // splits fresh = input - cached (CODEX_FRESH_INPUT_TOKENS).
        input_token_count: c.inputTokens + c.cacheReadTokens,
        output_token_count: c.outputTokens,
        cached_token_count: c.cacheReadTokens,
      }),
    });
  }
  for (const t of session.toolCalls) {
    staged.push({
      tsMs: t.tsMs,
      order: order++,
      attributes: clean({
        "event.name": "codex.tool_result",
        "event.timestamp": iso(t.tsMs),
        "conversation.id": session.sessionId,
        tool_name: t.toolName,
        call_id: t.toolUseId,
        success: bool(t.success),
        ...(content.toolDetails && t.input !== null ? { arguments: t.input } : {}),
      }),
    });
  }
  return { logs: finishLogs(staged), metrics: [] };
}

export function convertSession(session: ImportedSession, content: ContentPolicy): ConvertedSession {
  return session.source === "claude-code" ? convertClaude(session, content) : convertCodex(session, content);
}

/** The commit marker record for one session plan. Carries no content. */
export function completionMarker(
  session: ImportedSession,
  plan: { id: string; logParts: number; metricParts: number; events: number },
): ImportLog {
  return {
    timeUnixNano: toNano(session.endMs),
    attributes: {
      "event.name": IMPORT_COMPLETE_EVENT,
      "session.id": session.sessionId,
      "import.plan": plan.id,
      "import.log_parts": plan.logParts,
      "import.metric_parts": plan.metricParts,
      "import.events": plan.events,
    },
  };
}
