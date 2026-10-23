// Option resolution shared by the `import` CLI and (later) the MCP tool: which
// key to send with, what content each source may export, and the window flags.

import { looksLikeKey } from "../keys.ts";
import { readClaudeContentFlags } from "../settings.ts";
import { readClaudeKey } from "../clients.ts";
import { readCodexKey, readCodexLogUserPrompt } from "../codexConfig.ts";
import type { ContentPolicy, ImportSource } from "./model.ts";
import { ALL_CONTENT, NO_CONTENT } from "./model.ts";
import type { ContentBySource } from "./run.ts";

export type KeyPaths = { claudeSettings: string; codexConfig: string };

/**
 * Where an import takes its ingest key from, in order:
 *  1. an explicit key (argument);
 *  2. the key env var (`CODETELEMETRY_INGEST_KEY` or `--key-env`);
 *  3. the configured clients — for `--source codex` the Codex config first, so a
 *     Codex-only user (onboarded with `login --codex`) needs no extra step;
 *     otherwise Claude Code's settings.json first, then the Codex config.
 * With `--source all` and BOTH clients configured with different keys, it
 * refuses: those are two different workspaces and one import must not mix them.
 */
export function resolveImportKey(opts: {
  explicit?: string;
  env?: string;
  envName?: string;
  source: ImportSource | "all";
  paths: KeyPaths;
  readClaude?: (p: string) => string | null;
  readCodex?: (p: string) => string | null;
}): { key: string; from: string } | { error: string } {
  if (opts.explicit !== undefined) {
    return looksLikeKey(opts.explicit) ? { key: opts.explicit.trim(), from: "argument" } : { error: "That is not a CodeTelemetry ingest key (cot_…)." };
  }
  const fromEnv = opts.env?.trim();
  if (fromEnv) {
    if (!looksLikeKey(fromEnv)) return { error: `$${opts.envName ?? "CODETELEMETRY_INGEST_KEY"} is set but is not an ingest key.` };
    return { key: fromEnv, from: `$${opts.envName ?? "CODETELEMETRY_INGEST_KEY"}` };
  }
  const claude = (opts.readClaude ?? readClaudeKey)(opts.paths.claudeSettings);
  const codex = (opts.readCodex ?? readCodexKey)(opts.paths.codexConfig);
  if (opts.source === "all" && claude && codex && claude !== codex) {
    return {
      error: "Claude Code and Codex are configured with different ingest keys (different workspaces). " +
        "Import each separately with --source claude-code and --source codex.",
    };
  }
  const order: Array<[string | null, string]> = opts.source === "codex"
    ? [[codex, opts.paths.codexConfig], [claude, opts.paths.claudeSettings]]
    : [[claude, opts.paths.claudeSettings], [codex, opts.paths.codexConfig]];
  for (const [key, from] of order) if (key) return { key, from };
  return {
    error: `No ingest key found in ${opts.paths.claudeSettings} or ${opts.paths.codexConfig}. ` +
      "Run `codetelemetry-connect login` (or `login --codex`) first, or set CODETELEMETRY_INGEST_KEY.",
  };
}

export type ContentMode = "none" | "live" | "all" | ContentPolicy;

/** `none` | `live` | `all` | a comma list of `prompts`, `tools`. Absent means
 *  `live` (owner decision 2026-10-18: an import sends what the user's live
 *  exporters already send; `none` is the explicit opt-out). */
export function parseContentFlag(raw: string | undefined): ContentMode | null {
  if (raw === undefined) return "live";
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "live" || v === "all") return v;
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => p !== "prompts" && p !== "tools")) return null;
  return { prompts: parts.includes("prompts"), toolDetails: parts.includes("tools") };
}

/**
 * Content per source. `live` mirrors what the live exporters are configured
 * to send: Claude Code's OTEL_LOG_USER_PROMPTS / OTEL_LOG_TOOL_DETAILS in
 * settings.json, Codex's `log_user_prompt` (Codex's live tool events always
 * carry their arguments). It is the default for the CLI and the MCP tool.
 */
export function resolveImportContent(mode: ContentMode, paths: KeyPaths): ContentBySource {
  if (mode === "none") return { "claude-code": NO_CONTENT, codex: NO_CONTENT };
  if (mode === "all") return { "claude-code": ALL_CONTENT, codex: ALL_CONTENT };
  if (mode === "live") {
    return {
      "claude-code": readClaudeContentFlags(paths.claudeSettings),
      codex: { prompts: readCodexLogUserPrompt(paths.codexConfig), toolDetails: true },
    };
  }
  return { "claude-code": mode, codex: mode };
}

/** `30d` / `12h` (relative to now) or an ISO date/time. Null when unusable. */
export function parseWhen(raw: string, nowMs: number): number | null {
  const rel = raw.trim().match(/^(\d{1,4})([dh])$/i);
  if (rel) {
    const n = Number(rel[1]);
    // Whole days snap to a UTC midnight, so re-running tomorrow trims a
    // straddling session at the same edge (same plan) instead of a moving one.
    if (rel[2].toLowerCase() === "d") return Math.floor((nowMs - n * 86_400_000) / 86_400_000) * 86_400_000;
    return nowMs - n * 3_600_000;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw.trim())) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}
