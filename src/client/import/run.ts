// `codetelemetry-connect import` (and the MCP `import_history` tool): scan the
// local Claude Code / Codex history, stream-parse it, and hand the planned
// sessions to the shared import core (core.ts) with the durable on-disk
// ledger. Design: apps/code-telemetry-web/docs/history-import.md.

import { createHash, randomUUID } from "node:crypto";
import { assertKey, keyHash, mask } from "../keys.ts";
import { resolveEndpoints } from "../config.ts";
import type { FetchLike } from "../otlp.ts";
import type { ImportSource } from "./model.ts";
import { sessionKeyOf } from "./model.ts";
import {
  ACTIVE_GRACE_MS,
  bump,
  contentOrDefault,
  emptySummary,
  importPrepared,
  prepareSession,
  resolveWindow,
  type ContentBySource,
  type ImportRunResult,
  type ImportSourceSummary,
  type ImportTool,
  type Prepared,
} from "./core.ts";
import {
  defaultClaudeProjectsDir,
  defaultCodexSessionsDir,
  parseCandidate,
  scanClaudeSessions,
  scanCodexSessions,
  type SessionCandidate,
} from "./sources/files.ts";
import { LedgerStore, resolveLedgerPath } from "./ledger.ts";

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
} from "./core.ts";

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
  /** Stamped as resource-level user.email on imported rows. */
  email?: string;
  /** Content each source may export. Default: none (counts / sizes / names only). */
  content?: Partial<ContentBySource>;
  /** Parse, check and summarize; send nothing, write nothing. */
  dryRun?: boolean;
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
  const dryRun = !!opts.dryRun;
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
  if (wantClaude) {
    const s = emptySummary("claude-code");
    summaries.set("claude-code", s);
    const files = scanClaudeSessions(opts.claudeDir ?? defaultClaudeProjectsDir());
    s.filesFound = files.length;
    found.push(...files);
  }
  if (wantCodex) {
    const s = emptySummary("codex");
    summaries.set("codex", s);
    const files = scanCodexSessions(opts.codexDir ?? defaultCodexSessionsDir());
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
    sha256Hex,
  };
  for (const c of found) {
    const s = summaries.get(c.source)!;
    if (c.mtimeMs < window.sinceMs) {
      bump(s, "older"); // no event can be newer than the file's last write
      continue;
    }
    if (c.mtimeMs > now - ACTIVE_GRACE_MS) {
      bump(s, "active");
      continue;
    }
    const parsed = await parseCandidate(c, content[c.source]);
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
    const done = ledger.get(hash, sessionKey);
    if (done && done.state === "complete" && done.fileSig === c.fileSig) {
      bump(s, "ledger");
      continue;
    }
    const reload = async () => {
      const again = await parseCandidate(c, content[c.source]);
      return again.ok ? again.session : null;
    };
    const p = await prepareSession(parsed.session, c.fileSig, reload, prepareOpts);
    if (typeof p === "string") {
      bump(s, p);
      continue;
    }
    if (seen.has(sessionKey)) {
      warnings.push(`${sessionKey} appears in more than one file; only the first is imported`);
      continue;
    }
    seen.add(sessionKey);
    s.candidates++;
    prepared.push(p);
  }

  // 3. Status → decide → send.
  try {
    return await importPrepared(prepared, {
      ...prepareOpts,
      key,
      keyHash: hash,
      keyMasked: mask(key),
      statusUrl: endpoints.agentImportStatusUrl,
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
