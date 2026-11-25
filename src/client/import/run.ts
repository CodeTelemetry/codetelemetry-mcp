// `codetelemetry-connect import` (and the MCP `import_history` tool): scan the
// local Claude Code / Codex history, stream-parse it, and hand the planned
// sessions to the shared import core (core.ts) with the durable on-disk
// ledger. Design: apps/code-telemetry-web/docs/history-import.md.

import { createHash, randomUUID } from "node:crypto";
import { assertKey, keyHash, mask } from "../keys.ts";
import { resolveEndpoints } from "../config.ts";
import type { FetchLike } from "../otlp.ts";
import type { IdentityBySource, ImportSource } from "./model.ts";
import { NO_CONTENT, sessionKeyOf } from "./model.ts";
import {
  ACTIVE_GRACE_MS,
  bump,
  contentOrDefault,
  emptySummary,
  importPrepared,
  prepareSession,
  resolveWindow,
  underProject,
  type ContentBySource,
  type ImportRunResult,
  type ImportSourceSummary,
  type ImportTool,
  type Prepared,
} from "./core.ts";
import {
  HistoryReadBudgetError,
  MAX_SESSION_FILE_BYTES,
  defaultClaudeProjectsDir,
  defaultClaudeSettingsPath,
  defaultCodexSessionsDir,
  readClaudeCleanupPeriodDays,
  parseCandidate,
  candidateProjectDirectory,
  scanClaudeSessions,
  scanCodexSessions,
  type SessionCandidate,
} from "./sources/files.ts";
import { LedgerStore, resolveLedgerPath } from "./ledger.ts";
import { EstimateBuilder, estimateWindow, type HistoryEstimate } from "./estimate.ts";

export {
  RETENTION_DAYS,
  DEFAULT_SINCE_DAYS,
  ACTIVE_GRACE_MS,
  IMPORT_VERSION,
  DEFAULT_RATE_PER_MINUTE,
  MAX_RATE_PER_MINUTE,
  DEFAULT_TIME_LIMIT_MS,
  type ContentBySource,
  type ImportRunResult,
  type ImportSourceSummary,
  type SkipCounts,
  type StopReason,
  type ImportRunBilling,
  type ImportRunPartial,
} from "./core.ts";
export type { HistoryEstimate, HistoryEstimateSource, MonthBucket } from "./estimate.ts";

export type ImportRunOptions = {
  key: string;
  endpoints?: Partial<{ apiBase: string; ingestEndpoint: string }>;
  source?: ImportSource | "all";
  /** Window start (epoch ms). Default: start of the UTC day 30 days ago;
   *  clamped to the retention floor. */
  sinceMs?: number;
  untilMs?: number;
  /** Only sessions whose cwd is this path or under it. */
  project?: string;
  /** Stamped as user.email on imported rows (resource and every record);
   *  overrides the resolved identity's email. */
  email?: string;
  /** Identity attributes per source, stamped on every record the way live
   *  exporters send them (identity.ts resolveImportIdentity). Default none:
   *  the library stamps no identity unless the caller resolves one. */
  identity?: IdentityBySource;
  /** Content each source may export. Default: none (counts / sizes / names only). */
  content?: Partial<ContentBySource>;
  /** Parse, check and summarize; send nothing, write nothing. */
  dryRun?: boolean;
  /** Workspace onboarding's local-only preview; no server calls or ledger writes. */
  previewOnly?: boolean;
  /** Exact plans selected from a saved preview; changed content is never uploaded. */
  selectedPlans?: Readonly<Record<string, string>>;
  /** Saved workspace MCP calls share the same bounded project discovery. */
  boundedDiscovery?: boolean;
  /** Cap sessions sent this run; the rest are reported as `remaining`. */
  maxSessions?: number;
  ratePerMinute?: number;
  timeLimitMs?: number;
  importTool?: ImportTool;
  // Injection points (tests / embedding).
  claudeDir?: string;
  codexDir?: string;
  ledgerPath?: string;
  nowMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Human-facing progress lines (already masked). */
  logger?: (msg: string) => void;
};

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export async function runImport(opts: ImportRunOptions): Promise<ImportRunResult> {
  const key = assertKey(opts.key);
  const hash = keyHash(key);
  const endpoints = resolveEndpoints(opts.endpoints);
  const now = opts.nowMs ?? Date.now();
  const clock = () => (opts.nowMs === undefined ? Date.now() : opts.nowMs);
  const dryRun = !!opts.dryRun || !!opts.previewOnly;
  const warnings: string[] = [];
  const content = contentOrDefault(opts.content);
  const window = resolveWindow(now, opts.sinceMs, opts.untilMs);
  if (window.warning) warnings.push(window.warning);

  const ledger = LedgerStore.open(opts.ledgerPath ?? resolveLedgerPath());
  if (ledger.readOnly) warnings.push("the import ledger was written by a newer importer; it is used read-only this run");

  // 1. Scan (stat only).
  const wantClaude = !opts.source || opts.source === "all" || opts.source === "claude-code";
  const wantCodex = !opts.source || opts.source === "all" || opts.source === "codex";
  const summaries = new Map<ImportSource, ImportSourceSummary>();
  const found: SessionCandidate[] = [];
  const boundedSelection = Boolean(opts.previewOnly || opts.selectedPlans || opts.boundedDiscovery);
  const scanBudget = boundedSelection ? { remainingEntries: 10_000, deadline: Date.now() + 120_000 } : undefined;
  const readBudget = scanBudget ? { remainingBytes: 128 * 1024 * 1024, deadline: scanBudget.deadline } : undefined;
  const parseLimits = scanBudget ? { deadline: scanBudget.deadline, maxBytes: 64 * 1024 * 1024, budget: readBudget } : undefined;
  if (wantClaude) {
    const s = emptySummary("claude-code");
    summaries.set("claude-code", s);
    const files = scanClaudeSessions(opts.claudeDir ?? defaultClaudeProjectsDir(), scanBudget);
    s.filesFound = files.length;
    found.push(...files);
  }
  if (wantCodex) {
    const s = emptySummary("codex");
    summaries.set("codex", s);
    const files = scanCodexSessions(opts.codexDir ?? defaultCodexSessionsDir(), scanBudget);
    s.filesFound = files.length;
    found.push(...files);
  }

  // 2. Cheap filters on file metadata, then stream-parse and plan. Records are
  //    dropped right after planning; sending re-reads the files.
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  const prepareOpts = {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    project: opts.project,
    caseInsensitivePaths: process.platform === "win32" || process.platform === "darwin",
    content,
    email: opts.email,
    identity: opts.identity,
    sha256Hex,
  };
  for (const c of found) {
    if ((opts.previewOnly || opts.selectedPlans) && clock() - now > 120_000) throw new Error("History scan reached its two-minute bound; narrow the date window and preview again.");
    const s = summaries.get(c.source)!;
    if (c.mtimeMs < window.sinceMs) {
      bump(s, "older"); // no event can be newer than the file's last write
      continue;
    }
    if (c.mtimeMs > now - ACTIVE_GRACE_MS) {
      bump(s, "active");
      continue;
    }
    if (readBudget && opts.project) {
      const cwd = candidateProjectDirectory(c, readBudget);
      if (cwd && !underProject(cwd, opts.project, prepareOpts.caseInsensitivePaths)) { bump(s, "filtered"); continue; }
    }
    const parsed = await parseCandidate(c, content[c.source], parseLimits);
    if (!parsed.ok) {
      bump(s, parsed.reason);
      warnings.push(`${c.source} ${c.file}: ${parsed.detail}; not imported`);
      continue;
    }
    if (!parsed.session) {
      bump(s, "empty");
      continue;
    }
    s.sessionsParsed++;
    const sessionKey = sessionKeyOf(parsed.session.source, parsed.session.sessionId);
    if (opts.selectedPlans && !Object.prototype.hasOwnProperty.call(opts.selectedPlans, sessionKey)) continue;
    const done = ledger.get(hash, sessionKey);
    if (done && done.state === "complete" && done.fileSig === c.fileSig) {
      bump(s, "ledger");
      continue;
    }
    const reload = async () => {
      const again = await parseCandidate(c, content[c.source], parseLimits);
      return again.ok ? again.session : null;
    };
    const p = await prepareSession(parsed.session, c.fileSig, reload, prepareOpts);
    if (typeof p === "string") {
      bump(s, p);
      continue;
    }
    if (opts.selectedPlans && opts.selectedPlans[sessionKey] !== p.plan.id)
      throw new Error("A selected session changed since preview. Preview it again before importing.");
    if (seen.has(sessionKey)) {
      warnings.push(`${sessionKey} appears in more than one file; only the first is imported`);
      continue;
    }
    seen.add(sessionKey);
    s.candidates++;
    prepared.push(p);
  }

  // 3. Status → decide → send.
  if (opts.previewOnly) {
    const selected = prepared.sort((a, b) => b.endMs - a.endMs).slice(0, 100);
    return {
      ok: true, run: randomUUID(), dryRun: true, key: { masked: mask(key), keyHash: hash },
      window: { sinceIso: new Date(window.sinceMs).toISOString(), untilIso: new Date(window.untilMs).toISOString(), clamped: window.clamped },
      content, sources: [...summaries.values()],
      totals: { sessions: selected.length, events: selected.reduce((n, p) => n + p.plan.events, 0),
        metricPoints: selected.reduce((n, p) => n + p.plan.metricPoints, 0) },
      remaining: Math.max(0, prepared.length - selected.length), stoppedBy: null, cleanup: [], warnings, errors: [],
      previewSessions: selected.map(p => ({ source: p.source, sessionId: p.sessionId, planId: p.plan.id,
        startMs: p.startMs, endMs: p.endMs, events: p.plan.events })),
    };
  }
  try {
    return await importPrepared(prepared, {
      ...prepareOpts,
      key,
      keyHash: hash,
      keyMasked: mask(key),
      statusUrl: endpoints.agentImportStatusUrl,
      reportUrl: endpoints.agentImportReportUrl,
      ingestEndpoint: endpoints.ingestEndpoint,
      dryRun,
      run: randomUUID(),
      importTool: opts.importTool ?? "connect-cli",
      maxSessions: opts.maxSessions,
      ratePerMinute: opts.ratePerMinute,
      timeLimitMs: opts.timeLimitMs,
      clamped: window.clamped,
      now,
      clock,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep,
      ledger,
      summaries,
      warnings,
      logger: opts.logger,
    });
  } finally {
    if (!dryRun) ledger.compact();
  }
}

export type EstimateRunOptions = {
  source?: ImportSource | "all";
  /** Window start (epoch ms). Default: the retained year (364 days). */
  sinceMs?: number;
  nowMs?: number;
  claudeDir?: string;
  codexDir?: string;
  /** Where Claude Code's cleanupPeriodDays is read (default: user settings.json). */
  claudeSettingsPath?: string;
  /** Wall-clock bound (the MCP tool's); sessions not reached are skipped as `time_limit`. */
  timeLimitMs?: number;
};

/**
 * `codetelemetry-connect estimate` and the MCP `estimate_history` tool: what
 * the local history would add up to if imported. No key, no network, nothing
 * written; files are streamed through the importer's parsers without content.
 */
export async function runEstimate(opts: EstimateRunOptions = {}): Promise<HistoryEstimate> {
  const now = opts.nowMs ?? Date.now();
  const window = estimateWindow(now, opts.sinceMs);
  const wantClaude = !opts.source || opts.source === "all" || opts.source === "claude-code";
  const wantCodex = !opts.source || opts.source === "all" || opts.source === "codex";
  const sources: ImportSource[] = [...(wantClaude ? ["claude-code" as const] : []), ...(wantCodex ? ["codex" as const] : [])];
  const builder = new EstimateBuilder({ sinceMs: window.sinceMs, untilMs: window.untilMs, nowMs: now, sources });
  if (window.warning) builder.warn(window.warning);

  const found: SessionCandidate[] = [];
  if (wantClaude) {
    const files = scanClaudeSessions(opts.claudeDir ?? defaultClaudeProjectsDir());
    builder.found("claude-code", files.length);
    found.push(...files);
  }
  if (wantCodex) {
    const files = scanCodexSessions(opts.codexDir ?? defaultCodexSessionsDir());
    builder.found("codex", files.length);
    found.push(...files);
  }

  const deadline = opts.timeLimitMs ? Date.now() + opts.timeLimitMs : Infinity;
  const limits = Number.isFinite(deadline) ? { deadline, maxBytes: MAX_SESSION_FILE_BYTES } : undefined;
  const seen = new Set<string>();
  let timedOut = false;
  for (const c of found) {
    if (timedOut || Date.now() >= deadline) {
      timedOut = true;
      builder.skip(c.source, "time_limit");
      continue;
    }
    if (c.mtimeMs < window.sinceMs) {
      builder.skip(c.source, "older");
      continue;
    }
    if (c.mtimeMs > now - ACTIVE_GRACE_MS) {
      builder.skip(c.source, "active");
      continue;
    }
    let parsed: Awaited<ReturnType<typeof parseCandidate>>;
    try {
      parsed = await parseCandidate(c, NO_CONTENT, limits);
    } catch (err) {
      if (!(err instanceof HistoryReadBudgetError)) throw err;
      timedOut = true;
      builder.skip(c.source, "time_limit");
      continue;
    }
    if (!parsed.ok) {
      builder.skip(c.source, parsed.reason);
      builder.warn(`${c.source} ${c.file}: ${parsed.detail}; not counted`);
      continue;
    }
    if (!parsed.session) {
      builder.skip(c.source, "empty");
      continue;
    }
    const sessionKey = sessionKeyOf(parsed.session.source, parsed.session.sessionId);
    if (seen.has(sessionKey)) {
      builder.warn(`${sessionKey} appears in more than one file; only the first is counted`);
      continue;
    }
    const outcome = builder.add(parsed.session);
    if (outcome !== "added") {
      builder.skip(c.source, outcome);
      continue;
    }
    // As runImport: only a session counted in the window claims its key, so
    // an out-of-window copy never hides an in-window one.
    seen.add(sessionKey);
  }
  if (timedOut) builder.warn("The estimate reached its time bound; the totals cover only the sessions read (see skipped.time_limit).");
  return builder.finish({
    claudeCleanupPeriodDays: wantClaude ? readClaudeCleanupPeriodDays(opts.claudeSettingsPath ?? defaultClaudeSettingsPath()) : null,
  });
}
