// Price past sessions before importing them (ELL-655). Reads the same local
// history the importer reads, with the same parsers, and reports what an
// upload would hold: sessions and tokens per source, per UTC month and per
// day, the oldest and newest session, and the trailing-30-day pace. It needs
// no key and sends nothing; the optional public price list
// (GET /api/pricing) turns tokens into dollars.
//
// Pure and browser-safe (no node: imports): the in-page upload estimates the
// dropped files (browser.ts `estimateFiles`), the CLI and MCP tool estimate
// ~/.claude/projects and ~/.codex/sessions (run.ts `runEstimate`).
//
// Tokens are input + output + cache read + cache creation, every type counted
// once, exactly as the plan meters them. A token counts in the UTC month / day
// of its own model call. The estimate cannot see which sessions CodeTelemetry
// already captured live; an import asks the server and skips those.

import type { ImportSource, ImportedSession, MonthBucket } from "./model.ts";
import { DAY_OF, MONTH_OF, callTokens, sessionEventCount, trimSessionToWindow } from "./model.ts";
import { DAY_MS, RETENTION_DAYS, RETENTION_MARGIN_DAYS, resolveWindow, startOfUtcDay } from "./core.ts";
import type { FetchLike } from "../otlp.ts";

export type { MonthBucket } from "./model.ts";

export type HistoryEstimateSource = {
  source: ImportSource;
  filesFound: number;
  sessions: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  events: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
  skipped: Record<string, number>;
};

export type HistoryEstimate = {
  window: { sinceIso: string; untilIso: string };
  sources: HistoryEstimateSource[];
  months: MonthBucket[];
  /** Tokens per UTC day, oldest first; at most MAX_ESTIMATE_DAYS entries. */
  days: Array<{ day: string; tokens: number }>;
  totals: { sessions: number; tokens: number; events: number };
  oldestEventMs: number | null;
  newestEventMs: number | null;
  /** Tokens whose model call falls in the 30 days before `now`. */
  trailing30dTokens: number;
  /** Claude Code's transcript retention (settings.json cleanupPeriodDays,
   *  default 30). Node only; null in a browser or for a Codex-only estimate. */
  claudeCleanupPeriodDays: number | null;
  warnings: string[];
};

/** The default window: the whole retained year (the importer's 364-day clamp). */
export const ESTIMATE_DEFAULT_DAYS = RETENTION_DAYS - RETENTION_MARGIN_DAYS;
export const MAX_ESTIMATE_DAYS = 366;
export const MAX_ESTIMATE_WARNINGS = 50;
/** Claude Code's default cleanupPeriodDays. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;
const TRAILING_DAYS = 30;

/** What an import can never recover from local files (live-only signals). */
export const IMPORT_NEVER_RECOVERS =
  "per-request latency and retries, permission decisions, active time, lines-of-code / commit / pull-request counters, " +
  "model responses and tool output content";

/** The estimate window: default the retained year, clamped to retention. */
export function estimateWindow(nowMs: number, sinceMs?: number): { sinceMs: number; untilMs: number; clamped: boolean; warning?: string } {
  return resolveWindow(nowMs, sinceMs ?? startOfUtcDay(nowMs - ESTIMATE_DEFAULT_DAYS * DAY_MS));
}

const emptySource = (source: ImportSource): HistoryEstimateSource => ({
  source,
  filesFound: 0,
  sessions: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  events: 0,
  firstEventMs: null,
  lastEventMs: null,
  skipped: {},
});

/**
 * Accumulates one estimate across many sessions without holding them: each
 * session is trimmed to the window, counted and dropped. Memory is bounded by
 * the month / day buckets (≤ 13 / ≤ 366) and the capped warnings.
 */
export class EstimateBuilder {
  readonly #sinceMs: number;
  readonly #untilMs: number;
  readonly #nowMs: number;
  readonly #sources = new Map<ImportSource, HistoryEstimateSource>();
  readonly #months: MonthBucket[] = [];
  readonly #days = new Map<string, number>();
  readonly #warnings: string[] = [];
  #warningsDropped = 0;
  #trailing = 0;

  constructor(opts: { sinceMs: number; untilMs: number; nowMs: number; sources: ImportSource[] }) {
    this.#sinceMs = opts.sinceMs;
    this.#untilMs = opts.untilMs;
    this.#nowMs = opts.nowMs;
    for (const s of opts.sources) this.#sources.set(s, emptySource(s));
  }

  #source(source: ImportSource): HistoryEstimateSource {
    let s = this.#sources.get(source);
    if (!s) {
      s = emptySource(source);
      this.#sources.set(source, s);
    }
    return s;
  }

  found(source: ImportSource, n = 1): void {
    this.#source(source).filesFound += n;
  }

  skip(source: ImportSource, reason: string, n = 1): void {
    const s = this.#source(source);
    s.skipped[reason] = (s.skipped[reason] ?? 0) + n;
  }

  warn(message: string): void {
    if (this.#warnings.length < MAX_ESTIMATE_WARNINGS) this.#warnings.push(message);
    else this.#warningsDropped++;
  }

  /** Count one parsed session; the skip reason when nothing of it is in the window. */
  add(session: ImportedSession): "added" | "older" | "newer" {
    if (session.endMs < this.#sinceMs) return "older";
    if (session.startMs > this.#untilMs) return "newer";
    const trimmed = trimSessionToWindow(session, this.#sinceMs, this.#untilMs);
    if (!trimmed) return "older";
    const s = this.#source(session.source);
    s.sessions++;
    s.events += sessionEventCount(trimmed);
    s.firstEventMs = s.firstEventMs === null ? trimmed.startMs : Math.min(s.firstEventMs, trimmed.startMs);
    s.lastEventMs = s.lastEventMs === null ? trimmed.endMs : Math.max(s.lastEventMs, trimmed.endMs);
    this.#month(MONTH_OF(trimmed.startMs)).sessions++;
    const trailingFrom = this.#nowMs - TRAILING_DAYS * DAY_MS;
    for (const c of trimmed.modelCalls) {
      s.tokens.input += c.inputTokens;
      s.tokens.output += c.outputTokens;
      s.tokens.cacheRead += c.cacheReadTokens;
      s.tokens.cacheCreation += c.cacheCreationTokens;
      const n = callTokens(c);
      if (n <= 0) continue;
      // Each call's own timestamp (every parsed call carries one).
      const ts = Number.isFinite(c.tsMs) ? c.tsMs : trimmed.startMs;
      this.#month(MONTH_OF(ts)).tokens += n;
      const day = DAY_OF(ts);
      this.#days.set(day, (this.#days.get(day) ?? 0) + n);
      if (ts > trailingFrom && ts <= this.#nowMs) this.#trailing += n;
    }
    return "added";
  }

  #month(month: string): MonthBucket {
    let b = this.#months.find((m) => m.month === month);
    if (!b) {
      b = { month, sessions: 0, tokens: 0 };
      this.#months.push(b);
    }
    return b;
  }

  finish(extra: { claudeCleanupPeriodDays: number | null }): HistoryEstimate {
    const sources = [...this.#sources.values()];
    const tokensOf = (s: HistoryEstimateSource) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
    const firsts = sources.map((s) => s.firstEventMs).filter((v): v is number => v !== null);
    const lasts = sources.map((s) => s.lastEventMs).filter((v): v is number => v !== null);
    const days = [...this.#days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(-MAX_ESTIMATE_DAYS)
      .map(([day, tokens]) => ({ day, tokens }));
    const warnings = [...this.#warnings];
    if (this.#warningsDropped) warnings.push(`…and ${this.#warningsDropped} more warning(s)`);
    const windowDays = (this.#nowMs - this.#sinceMs) / DAY_MS;
    if (windowDays < TRAILING_DAYS) {
      warnings.push(
        `The window covers only ${Math.max(0, Math.round(windowDays * 10) / 10)} day(s), so the last-30-day pace ` +
          "(trailing30dTokens, and any monthly price from it) is understated; widen the window to 30 days or more.",
      );
    }
    warnings.push(
      "Sessions CodeTelemetry already captured live are counted here too; an import checks with the server and skips them.",
    );
    return {
      window: { sinceIso: new Date(this.#sinceMs).toISOString(), untilIso: new Date(this.#untilMs).toISOString() },
      sources,
      months: [...this.#months].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
      days,
      totals: {
        sessions: sources.reduce((n, s) => n + s.sessions, 0),
        tokens: sources.reduce((n, s) => n + tokensOf(s), 0),
        events: sources.reduce((n, s) => n + s.events, 0),
      },
      oldestEventMs: firsts.length ? Math.min(...firsts) : null,
      newestEventMs: lasts.length ? Math.max(...lasts) : null,
      trailing30dTokens: this.#trailing,
      claudeCleanupPeriodDays: extra.claudeCleanupPeriodDays,
      warnings,
    };
  }
}

/** The public price list (GET {apiBase}/api/pricing, no auth). */
export type PublicPricing = {
  seatPriceUsdPerMonth: number;
  tokenPriceUsdPerMillion: number;
  includedTokensPerSeat: number;
  signupCreditUsd: number;
  retentionDays: number;
  importsBilled: boolean;
};

const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Defensive parse; null for anything that is not the full, sane price list. */
export function parsePricing(raw: unknown): PublicPricing | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (!nonNegative(p.seatPriceUsdPerMonth) || !nonNegative(p.tokenPriceUsdPerMillion) || !nonNegative(p.includedTokensPerSeat) ||
    !nonNegative(p.signupCreditUsd) || !nonNegative(p.retentionDays) || typeof p.importsBilled !== "boolean") return null;
  return {
    seatPriceUsdPerMonth: p.seatPriceUsdPerMonth,
    tokenPriceUsdPerMillion: p.tokenPriceUsdPerMillion,
    includedTokensPerSeat: p.includedTokensPerSeat,
    signupCreditUsd: p.signupCreditUsd,
    retentionDays: p.retentionDays,
    importsBilled: p.importsBilled,
  };
}

/** GET the public price list; null on any failure (the estimate still stands). */
export async function fetchPricing(apiBase: string, fetchImpl: FetchLike = (i, init) => fetch(i, init), timeoutMs = 5_000): Promise<PublicPricing | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiBase.replace(/\/$/, "")}/api/pricing`, { method: "GET", headers: { accept: "application/json" }, signal: ac.signal });
    if (res.status !== 200) return null;
    const text = await res.text();
    if (text.length > 16_384) return null;
    return parsePricing(JSON.parse(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type EstimateCost = {
  /** Every estimated token at the per-million price, before the included
   *  seat tokens (which apply first, so a real bill is at most this). */
  uploadCostUsd: number;
  /** One seat plus overage at the trailing-30-day pace. */
  monthlyUsdOneSeat: number;
  tokenPriceUsdPerMillion: number;
  includedTokensPerSeat: number;
  seatPriceUsdPerMonth: number;
  importsBilled: boolean;
};

const round2 = (usd: number): number => Math.round(usd * 100) / 100;

export function priceEstimate(estimate: Pick<HistoryEstimate, "totals" | "trailing30dTokens">, pricing: PublicPricing): EstimateCost {
  const perToken = pricing.tokenPriceUsdPerMillion / 1e6;
  return {
    uploadCostUsd: pricing.importsBilled ? round2(estimate.totals.tokens * perToken) : 0,
    monthlyUsdOneSeat: round2(pricing.seatPriceUsdPerMonth + Math.max(0, estimate.trailing30dTokens - pricing.includedTokensPerSeat) * perToken),
    tokenPriceUsdPerMillion: pricing.tokenPriceUsdPerMillion,
    includedTokensPerSeat: pricing.includedTokensPerSeat,
    seatPriceUsdPerMonth: pricing.seatPriceUsdPerMonth,
    importsBilled: pricing.importsBilled,
  };
}

/** The first day whose un-captured Claude Code sessions still exist locally:
 *  Claude Code deletes a transcript `days` after its last activity. */
export function claudeRetentionCutoffMs(nowMs: number, days: number): number {
  return startOfUtcDay(nowMs - days * DAY_MS);
}
