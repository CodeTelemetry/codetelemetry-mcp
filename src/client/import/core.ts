// The session-history import core: plan → server status → decide → send, with
// a commit marker last. Pure and browser-safe (no node: imports, no process):
// the CLI (`run.ts`, which adds file scanning and the on-disk ledger), the MCP
// tool and the in-browser upload all drive exactly this. Design:
// apps/code-telemetry-web/docs/history-import.md.
//
// Invariants:
//  - Nothing is sent unless the server's import-status read answered for the
//    session (live overlap would otherwise double count).
//  - A token-metric part is sent at most once per plan: it is recorded in the
//    ledger the moment ingest accepts it, and a part with an unknown outcome is
//    verified against the server before any resend.
//  - A session is either imported whole (marker last) or left resumable; a run
//    stops at the first billing / auth / rate refusal instead of hammering.
//  - Work is bounded: paced requests (the key's 600/min ingest limit is shared
//    with live exporters), a wall-clock deadline, and a session cap.
// The result is model-safe: masked key, ids and counts — never content.

import type { ContentPolicy, ImportAttributes, ImportLog, ImportMetric, ImportSource, ImportedSession } from "./model.ts";
import { NO_CONTENT, sessionKeyOf, trimSessionToWindow } from "./model.ts";
import { CLAUDE_SERVICE, CODEX_SERVICE, completionMarker, convertSession } from "./convert.ts";
import { chunkForPost, toOtlpLogs, toOtlpMetrics } from "./otlpImport.ts";
import type { JournalEvent, LedgerEntry } from "./ledger.ts";
import { COMMIT_PART_LABEL, decide, logPartLabel, metricPartLabel, type Decision, type SessionStatus, type SkipReason } from "./protocol.ts";
import { fetchStatus, makePacer, postOtlp, sleepMs, type StatusRequestSession } from "./transport.ts";
import type { FetchLike } from "../otlp.ts";

/** Raw telemetry retention (clickhouse-tiering-runtime.sh DELETE_DAYS), keyed
 *  on EVENT time. Older rows would be deleted by the next TTL merge. */
export const RETENTION_DAYS = 365;
/** One day of margin under the TTL so a just-imported day can't vanish at once. */
export const RETENTION_MARGIN_DAYS = 1;
export const DEFAULT_SINCE_DAYS = 30;
/** A session file written this recently may still be in progress (and may be
 *  exporting live); it is left for a later run. */
export const ACTIVE_GRACE_MS = 15 * 60_000;
/** Bumped whenever conversion output changes; part of every plan id. */
export const IMPORT_VERSION = "1";
export const DEFAULT_RATE_PER_MINUTE = 120;
export const MAX_RATE_PER_MINUTE = 300;
export const DEFAULT_TIME_LIMIT_MS = 60 * 60_000;

export const DAY_MS = 86_400_000;
const LOG_PART_MAX_RECORDS = 500;
const LOG_PART_MAX_BYTES = 1_000_000;
const METRIC_PART_MAX_RECORDS = 2_000;
const METRIC_PART_MAX_BYTES = 1_000_000;
const STATUS_BATCH = 100;
/** Twin of MAX_STATUS_PROBES in packages/api/src/import/importStatus.ts. */
const MAX_STATUS_PROBES = 10;
const STATUS_BATCH_SPAN_MS = 30 * DAY_MS;

export type ContentBySource = Record<ImportSource, ContentPolicy>;
export type ImportTool = "connect-cli" | "mcp" | "web-upload";

export type SkipCounts = Partial<Record<
  | SkipReason
  | "older" | "newer" | "active" | "filtered" | "ledger" | "empty"
  | "too_large" | "too_many_events" | "unreadable" | "changed_during_run" | "deferred",
  number
>>;

export type ImportSourceSummary = {
  source: ImportSource;
  filesFound: number;
  sessionsParsed: number;
  candidates: number;
  imported: number;
  resumed: number;
  skipped: SkipCounts;
  events: number;
  metricPoints: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
};

export type StopReason = "budget" | "auth" | "busy" | "time_limit" | "status_unavailable";

export type ImportRunResult = {
  ok: boolean;
  run: string;
  dryRun: boolean;
  key: { masked: string; keyHash: string };
  window: { sinceIso: string; untilIso: string; clamped: boolean };
  content: ContentBySource;
  sources: ImportSourceSummary[];
  totals: { sessions: number; events: number; metricPoints: number };
  /** Eligible sessions not sent this run (session cap / deadline / stop). */
  remaining: number;
  stoppedBy: StopReason | null;
  /** Billing top-up link when ingest refused for budget. */
  topup?: string | null;
  /** Sessions holding an uncommitted import of a different plan: rows an
   *  operator must remove (by import.plan) before they can be re-imported. */
  cleanup: Array<{ source: ImportSource; sessionId: string; plans: string[] }>;
  warnings: string[];
  errors: string[];
};

/** sha256 hex of a string — node:crypto in the CLI, SubtleCrypto in a browser. */
export type Sha256Hex = (text: string) => string | Promise<string>;

/** What the core needs from a ledger. The CLI's is durable (ledger.ts); a
 *  browser upload runs with an in-memory one and relies on the server probe. */
export type LedgerLike = {
  get(keyHash: string, sessionKey: string): LedgerEntry | undefined;
  record(e: JournalEvent): void;
};

export function memoryLedger(): LedgerLike {
  const entries = new Map<string, LedgerEntry>();
  return {
    get: (k, s) => entries.get(`${k}\u0000${s}`),
    record(e) {
      const id = `${e.k}\u0000${e.s}`;
      if (e.ev === "begin") {
        const prev = entries.get(id);
        if (prev && prev.plan === e.plan) return;
        entries.set(id, {
          plan: e.plan, fileSig: e.fileSig, state: "partial", logParts: [], metricParts: [], uncertainMetricParts: [],
          logPartCount: e.logPartCount, metricPartCount: e.metricPartCount, run: e.run, atMs: e.atMs,
        });
        return;
      }
      const entry = entries.get(id);
      if (!entry || entry.plan !== e.plan) return;
      entry.atMs = e.atMs;
      if (e.ev === "log" && !entry.logParts.includes(e.part)) entry.logParts.push(e.part);
      if (e.ev === "metric" && !entry.metricParts.includes(e.part)) {
        entry.metricParts.push(e.part);
        entry.uncertainMetricParts = entry.uncertainMetricParts.filter((p) => p !== e.part);
      }
      if (e.ev === "uncertain" && !entry.uncertainMetricParts.includes(e.part)) entry.uncertainMetricParts.push(e.part);
      if (e.ev === "complete") entry.state = "complete";
    },
  };
}

export type Plan = {
  id: string;
  logParts: ImportLog[][];
  metricParts: ImportMetric[][];
  events: number;
  metricPoints: number;
};

/** A session ready for the status check. `reload` re-reads it for sending, so
 *  converted records never have to be held for every session at once. */
export type Prepared = {
  source: ImportSource;
  sessionId: string;
  fileSig: string;
  startMs: number;
  endMs: number;
  plan: { id: string; logParts: number; metricParts: number; events: number; metricPoints: number };
  tokens: ImportSourceSummary["tokens"];
  warnings: string[];
  reload: () => Promise<ImportedSession | null>;
};

export const emptySummary = (source: ImportSource): ImportSourceSummary => ({
  source,
  filesFound: 0,
  sessionsParsed: 0,
  candidates: 0,
  imported: 0,
  resumed: 0,
  skipped: {},
  events: 0,
  metricPoints: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
});

export const bump = (s: ImportSourceSummary, reason: keyof SkipCounts, n = 1): void => {
  s.skipped[reason] = (s.skipped[reason] ?? 0) + n;
};

/** Case folding only where paths ARE case-insensitive (Windows, macOS): on a
 *  case-sensitive filesystem /work/App and /work/app are different projects. */
export const underProject = (cwd: string | null, project: string, caseInsensitive: boolean): boolean => {
  if (!cwd) return false;
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return caseInsensitive ? s.toLowerCase() : s;
  };
  const a = norm(cwd);
  const b = norm(project);
  return a === b || a.startsWith(b + "/");
};

export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** The import window: default the last 30 UTC days, never past the retention floor. */
export function resolveWindow(now: number, sinceMs?: number, untilMs?: number): {
  sinceMs: number; untilMs: number; clamped: boolean; warning?: string;
} {
  const floorMs = startOfUtcDay(now - (RETENTION_DAYS - RETENTION_MARGIN_DAYS) * DAY_MS);
  const requested = sinceMs ?? startOfUtcDay(now - DEFAULT_SINCE_DAYS * DAY_MS);
  const clamped = requested < floorMs;
  const since = Math.max(requested, floorMs);
  return {
    sinceMs: since,
    untilMs: Math.min(untilMs ?? now, now),
    clamped,
    ...(clamped
      ? {
        warning: `--since was moved forward to ${new Date(since).toISOString().slice(0, 10)}: raw telemetry is kept ` +
          `${RETENTION_DAYS} days by event time, so older events would be deleted as soon as they landed`,
      }
      : {}),
  };
}

function stableResource(session: ImportedSession, email: string | undefined): ImportAttributes {
  return {
    "service.name": session.source === "claude-code" ? CLAUDE_SERVICE : CODEX_SERVICE,
    "ingest.source": "history-import",
    "import.source": session.source,
    "import.version": IMPORT_VERSION,
    ...(session.cwd ? { "project.path": session.cwd } : {}),
    ...(email ? { "user.email": email } : {}),
  };
}

/** Convert + chunk + hash. The id covers everything that reaches storage
 *  except the per-run id, so the same input always yields the same plan. */
export async function buildPlan(
  session: ImportedSession,
  content: ContentPolicy,
  email: string | undefined,
  sha256Hex: Sha256Hex,
): Promise<{ plan: Plan; stable: ImportAttributes }> {
  const { logs, metrics } = convertSession(session, content);
  const stable = stableResource(session, email);
  const id = (await sha256Hex(JSON.stringify({ v: IMPORT_VERSION, stable, sessionId: session.sessionId, logs, metrics }))).slice(0, 32);
  return {
    stable,
    plan: {
      id,
      logParts: chunkForPost(logs, LOG_PART_MAX_RECORDS, LOG_PART_MAX_BYTES),
      metricParts: chunkForPost(metrics, METRIC_PART_MAX_RECORDS, METRIC_PART_MAX_BYTES),
      events: logs.length,
      metricPoints: metrics.length,
    },
  };
}

function tokensOf(session: ImportedSession): ImportSourceSummary["tokens"] {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const c of session.modelCalls) {
    t.input += c.inputTokens;
    t.output += c.outputTokens;
    t.cacheRead += c.cacheReadTokens;
    t.cacheCreation += c.cacheCreationTokens;
  }
  return t;
}

export type PrepareOptions = {
  sinceMs: number;
  untilMs: number;
  project?: string;
  caseInsensitivePaths: boolean;
  content: ContentBySource;
  email?: string;
  sha256Hex: Sha256Hex;
};

/** Filter, trim and plan one parsed session; a skip reason when it is out. */
export async function prepareSession(
  session: ImportedSession,
  fileSig: string,
  reload: () => Promise<ImportedSession | null>,
  opts: PrepareOptions,
): Promise<Prepared | keyof SkipCounts> {
  if (opts.project && !underProject(session.cwd, opts.project, opts.caseInsensitivePaths)) return "filtered";
  if (session.endMs < opts.sinceMs) return "older";
  if (session.startMs > opts.untilMs) return "newer";
  const trimmed = trimSessionToWindow(session, opts.sinceMs, opts.untilMs);
  if (!trimmed) return "older";
  const { plan } = await buildPlan(trimmed, opts.content[session.source], opts.email, opts.sha256Hex);
  return {
    source: session.source,
    sessionId: trimmed.sessionId,
    fileSig,
    startMs: trimmed.startMs,
    endMs: trimmed.endMs,
    plan: {
      id: plan.id,
      logParts: plan.logParts.length,
      metricParts: plan.metricParts.length,
      events: plan.events,
      metricPoints: plan.metricPoints,
    },
    tokens: tokensOf(trimmed),
    warnings: trimmed.warnings,
    reload,
  };
}

/** Group sessions (sorted by start) into status batches of bounded count and span. */
function statusBatches(items: Prepared[]): Prepared[][] {
  const out: Prepared[][] = [];
  let batch: Prepared[] = [];
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const p of [...items].sort((a, b) => a.startMs - b.startMs)) {
    const lo = Math.min(minStart, p.startMs);
    const hi = Math.max(maxEnd, p.endMs);
    if (batch.length > 0 && (batch.length >= STATUS_BATCH || hi - lo > STATUS_BATCH_SPAN_MS)) {
      out.push(batch);
      batch = [];
      minStart = Infinity;
      maxEnd = -Infinity;
    }
    batch.push(p);
    minStart = Math.min(minStart, p.startMs);
    maxEnd = Math.max(maxEnd, p.endMs);
  }
  if (batch.length) out.push(batch);
  return out;
}

export type ImportPreparedOptions = PrepareOptions & {
  key: string;
  keyHash: string;
  keyMasked: string;
  statusUrl: string;
  ingestEndpoint: string;
  dryRun: boolean;
  run: string;
  importTool: ImportTool;
  maxSessions?: number;
  ratePerMinute?: number;
  timeLimitMs?: number;
  clamped: boolean;
  now: number;
  clock: () => number;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  ledger: LedgerLike;
  summaries: Map<ImportSource, ImportSourceSummary>;
  warnings: string[];
  logger?: (msg: string) => void;
};

/** Status → decide → send for prepared sessions, then the run's result. */
export async function importPrepared(prepared: Prepared[], o: ImportPreparedOptions): Promise<ImportRunResult> {
  const { key, keyHash: hash, ledger, summaries, warnings, dryRun, now, clock, fetchImpl } = o;
  const sleep = o.sleep ?? sleepMs;
  const log = o.logger ?? (() => {});
  const errors: string[] = [];
  const cleanup: ImportRunResult["cleanup"] = [];
  const ratePerMinute = Math.min(Math.max(1, o.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE), MAX_RATE_PER_MINUTE);
  const deadline = now + (o.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS);

  // 1. Server status (required before sending): live / imported / resumable.
  let stoppedBy = null as StopReason | null; // assigned inside closures too
  const statuses = new Map<string, SessionStatus>();
  let settleMs = 5 * 60_000;
  const askStatus = async (items: Prepared[], probe: boolean): Promise<boolean> => {
    // A probe costs the server one extra bounded read per session, so probe
    // batches are kept small (the route refuses more than MAX_STATUS_PROBES).
    const batches = statusBatches(items).flatMap((b) =>
      probe
        ? Array.from({ length: Math.ceil(b.length / MAX_STATUS_PROBES) }, (_, i) => b.slice(i * MAX_STATUS_PROBES, (i + 1) * MAX_STATUS_PROBES))
        : [b]);
    for (const batch of batches) {
      const sessions: StatusRequestSession[] = batch.map((p) => ({
        sessionId: p.sessionId,
        startMs: p.startMs,
        endMs: p.endMs,
        ...(probe ? { probePlan: p.plan.id } : {}),
      }));
      const r = await fetchStatus({ url: o.statusUrl, key, sessions, fetchImpl, sleep });
      if (r.kind === "auth") {
        errors.push(`The ingest key is invalid or revoked (import status returned HTTP ${r.status}).`);
        stoppedBy = "auth";
        return false;
      }
      if (r.kind === "unavailable") {
        const msg = `The server-side import status check is unavailable (${r.detail}).`;
        if (dryRun) warnings.push(msg + " Live-overlap and duplicate checks were skipped for this dry run.");
        else errors.push(msg + " Nothing was sent: without it, sessions already captured live could be counted twice.");
        stoppedBy = "status_unavailable";
        return false;
      }
      settleMs = r.value.settleMs;
      for (const st of r.value.sessions) statuses.set(st.sessionId, st);
    }
    return true;
  };
  const statusOk = prepared.length === 0 || (await askStatus(prepared, false));

  // 2. Decide per session (probe metric parts where a resume needs them).
  type Ready = { p: Prepared; decision: Extract<Decision, { action: "send" }> };
  const ready: Ready[] = [];
  if (statusOk) {
    const probes: Prepared[] = [];
    const settle = (p: Prepared, probed: boolean): Decision => decide(
      { id: p.plan.id, logParts: p.plan.logParts, metricParts: p.plan.metricParts },
      statuses.get(p.sessionId) ?? { sessionId: p.sessionId, live: false, plans: [] },
      ledger.get(hash, sessionKeyOf(p.source, p.sessionId)),
      now,
      settleMs,
      probed,
    );
    const apply = (p: Prepared, d: Decision): void => {
      const s = summaries.get(p.source)!;
      if (d.action === "skip") {
        bump(s, d.reason);
        if (d.reason === "conflicting_partial" && d.plans) cleanup.push({ source: p.source, sessionId: p.sessionId, plans: d.plans });
      } else if (d.action === "send") ready.push({ p, decision: d });
    };
    for (const p of prepared) {
      const d = settle(p, false);
      if (d.action === "probe") probes.push(p);
      else apply(p, d);
    }
    if (probes.length && (await askStatus(probes, true))) {
      for (const p of probes) {
        const d = settle(p, true);
        apply(p, d.action === "probe" ? { action: "skip", reason: "unverifiable" } : d);
      }
    } else {
      for (const p of probes) bump(summaries.get(p.source)!, "unverifiable");
    }
  } else if (dryRun && stoppedBy === "status_unavailable") {
    // A dry run still shows what the files hold; the warning above says the
    // duplicate / live-overlap checks did not run.
    stoppedBy = null;
    for (const p of prepared) ready.push({ p, decision: { action: "send", skipLogParts: [], skipMetricParts: [], resumed: false } });
  }

  ready.sort((a, b) => a.p.startMs - b.p.startMs);
  const cap = o.maxSessions && o.maxSessions > 0 ? o.maxSessions : Infinity;
  const toSend = ready.slice(0, cap === Infinity ? undefined : cap);
  const deferred = ready.length - toSend.length;
  for (const r of ready.slice(toSend.length)) bump(summaries.get(r.p.source)!, "deferred");

  // 3. Send (or, on a dry run, count what would be sent).
  const pacer = makePacer(ratePerMinute, sleep, clock);
  let topup: string | null | undefined;
  let sent = 0;
  let processed = 0;
  for (let i = 0; i < toSend.length; i++) {
    const { p, decision } = toSend[i];
    const s = summaries.get(p.source)!;
    const tally = () => {
      s.events += p.plan.events;
      s.metricPoints += p.plan.metricPoints;
      for (const k of ["input", "output", "cacheRead", "cacheCreation"] as const) s.tokens[k] += p.tokens[k];
    };
    if (dryRun) {
      s.imported++;
      if (decision.resumed) s.resumed++;
      tally();
      processed++;
      continue;
    }
    if (stoppedBy) break;
    if (clock() > deadline) {
      stoppedBy = "time_limit";
      break;
    }
    processed++;
    // Re-read: the plan must still be the one the server was asked about.
    const reloaded = await p.reload();
    const session = reloaded ? trimSessionToWindow(reloaded, o.sinceMs, o.untilMs) : null;
    const rebuilt = session ? await buildPlan(session, o.content[p.source], o.email, o.sha256Hex) : null;
    if (!session || !rebuilt || rebuilt.plan.id !== p.plan.id) {
      bump(s, "changed_during_run");
      continue;
    }
    const { plan, stable } = rebuilt;
    for (const w of p.warnings) warnings.push(`${p.source} ${p.sessionId}: ${w}`);
    const sessionKey = sessionKeyOf(p.source, p.sessionId);
    const resource = (part: string): ImportAttributes => ({
      ...stable,
      "import.tool": o.importTool,
      "import.plan": plan.id,
      "import.part": part,
      "import.run": o.run,
    });
    ledger.record({
      k: hash, s: sessionKey, ev: "begin", plan: plan.id, fileSig: p.fileSig,
      logPartCount: plan.logParts.length, metricPartCount: plan.metricParts.length, run: o.run, atMs: clock(),
    });

    let sessionFailed = false;
    const fail = (msg: string) => {
      errors.push(`${p.source} ${p.sessionId}: ${msg}`);
      sessionFailed = true;
    };
    const stopOn = (outcome: Awaited<ReturnType<typeof postOtlp>>): boolean => {
      if (outcome.kind === "budget") {
        stoppedBy = "budget";
        topup = outcome.topup;
        return true;
      }
      if (outcome.kind === "auth") {
        stoppedBy = "auth";
        errors.push(`The ingest key was refused (HTTP ${outcome.status}); nothing more was sent.`);
        return true;
      }
      if (outcome.kind === "busy") {
        stoppedBy = "busy";
        errors.push(`Ingest kept refusing as busy/rate-limited (${outcome.detail}); stopped to leave room for live telemetry.`);
        return true;
      }
      return false;
    };

    const skipLogs = new Set(decision.skipLogParts);
    for (let li = 0; li < plan.logParts.length && !sessionFailed && !stoppedBy; li++) {
      if (skipLogs.has(li)) continue;
      const outcome = await postOtlp({
        url: `${o.ingestEndpoint}/v1/logs`, key, fetchImpl, pacer, sleep, retryAmbiguous: true,
        body: toOtlpLogs(plan.logParts[li], resource(logPartLabel(li))),
      });
      if (outcome.kind === "ok") ledger.record({ k: hash, s: sessionKey, ev: "log", plan: plan.id, part: li, atMs: clock() });
      else if (!stopOn(outcome)) fail(`log part ${li} was refused (${outcome.kind === "rejected" ? `HTTP ${outcome.status}` : outcome.kind})`);
    }
    const skipMetrics = new Set(decision.skipMetricParts);
    for (let mi = 0; mi < plan.metricParts.length && !sessionFailed && !stoppedBy; mi++) {
      if (skipMetrics.has(mi)) continue;
      const outcome = await postOtlp({
        url: `${o.ingestEndpoint}/v1/metrics`, key, fetchImpl, pacer, sleep, retryAmbiguous: false,
        body: toOtlpMetrics(plan.metricParts[mi], resource(metricPartLabel(mi))),
      });
      if (outcome.kind === "ok") {
        ledger.record({ k: hash, s: sessionKey, ev: "metric", plan: plan.id, part: mi, atMs: clock() });
      } else if (outcome.kind === "uncertain") {
        ledger.record({ k: hash, s: sessionKey, ev: "uncertain", plan: plan.id, part: mi, atMs: clock() });
        fail(`token part ${mi} got no definitive answer (${outcome.detail}); it will be verified, never blindly resent, on the next run`);
      } else if (!stopOn(outcome)) {
        fail(`token part ${mi} was refused (${outcome.kind === "rejected" ? `HTTP ${outcome.status}` : outcome.kind})`);
      }
    }
    if (!sessionFailed && !stoppedBy) {
      const marker = completionMarker(session, {
        id: plan.id, logParts: plan.logParts.length, metricParts: plan.metricParts.length, events: plan.events + plan.metricPoints,
      });
      const outcome = await postOtlp({
        url: `${o.ingestEndpoint}/v1/logs`, key, fetchImpl, pacer, sleep, retryAmbiguous: true,
        body: toOtlpLogs([marker], resource(COMMIT_PART_LABEL)),
      });
      if (outcome.kind === "ok") {
        ledger.record({ k: hash, s: sessionKey, ev: "complete", plan: plan.id, atMs: clock() });
        s.imported++;
        if (decision.resumed) s.resumed++;
        tally();
        sent++;
        if (sent % 10 === 0) log(`…${sent}/${toSend.length} sessions imported`);
      } else if (!stopOn(outcome)) {
        fail("the completion marker was refused; the session will resume on the next run");
      }
    }
    if (stoppedBy) {
      processed--; // the interrupted session stays resumable
      break;
    }
  }
  const remaining = deferred + (toSend.length - processed);

  if (stoppedBy === "budget") {
    errors.push(
      "Ingest refused with HTTP 402: this workspace's prepaid credit is exhausted, so it is not accepting " +
        "telemetry (live sessions included). Add credit or seats" + (topup ? ` at ${topup}` : "") +
        ", then re-run the same command — finished sessions are skipped and the interrupted one resumes.",
    );
  }
  if (stoppedBy === "time_limit") warnings.push("Stopped at the run's time limit; re-run to continue where it left off.");
  if (cleanup.length) {
    warnings.push(
      `${cleanup.length} session(s) hold an unfinished import of a different version of the session and were ` +
        "skipped; see `cleanup` for the import.plan ids an operator must remove before they can be imported.",
    );
  }

  const sources = [...summaries.values()];
  return {
    ok: errors.length === 0 && stoppedBy === null,
    run: o.run,
    dryRun,
    key: { masked: o.keyMasked, keyHash: hash },
    window: { sinceIso: new Date(o.sinceMs).toISOString(), untilIso: new Date(o.untilMs).toISOString(), clamped: o.clamped },
    content: o.content,
    sources,
    totals: {
      sessions: sources.reduce((n, s) => n + s.imported, 0),
      events: sources.reduce((n, s) => n + s.events, 0),
      metricPoints: sources.reduce((n, s) => n + s.metricPoints, 0),
    },
    remaining,
    stoppedBy,
    ...(topup !== undefined ? { topup } : {}),
    cleanup,
    warnings,
    errors,
  };
}

export const contentOrDefault = (c: Partial<ContentBySource> | undefined): ContentBySource => ({
  "claude-code": c?.["claude-code"] ?? NO_CONTENT,
  codex: c?.codex ?? NO_CONTENT,
});
