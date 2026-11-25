// In-browser session-history import: the web app's drag-and-drop upload. The
// dropped transcripts are parsed IN THE PAGE with the same parsers the CLI
// streams through, planned and sent by the same core (core.ts) — files never
// reach our servers; only the converted telemetry goes to the ingest endpoint
// under the user's own key (which the ingest front door answers with CORS for
// the web app's origin only).
//
// Browser-safe: no node: imports (keys.ts is node-only, so the key helpers this
// needs are local), Web Crypto for hashing, and an in-memory ledger — without
// a durable ledger the commit protocol leans on the server status read and its
// per-plan probe, which is exactly what it was built to allow.

import type { ContentPolicy, ImportSource, ImportedSession } from "./model.ts";
import { NO_CONTENT } from "./model.ts";
import { ClaudeSessionAccumulator } from "./sources/claudeCodeText.ts";
import { CodexSessionAccumulator, codexSessionIdFromName } from "./sources/codexText.ts";
import {
  ACTIVE_GRACE_MS,
  bump,
  contentOrDefault,
  emptySummary,
  importPrepared,
  memoryLedger,
  prepareSession,
  resolveWindow,
  type ContentBySource,
  type ImportRunResult,
  type ImportSourceSummary,
  type Prepared,
  type SkipCounts,
} from "./core.ts";
import { EstimateBuilder, estimateWindow, type HistoryEstimate } from "./estimate.ts";
import type { FetchLike } from "../otlp.ts";

/** The browser's File, or anything shaped like it. */
export type UploadFile = {
  name: string;
  size: number;
  lastModified: number;
  text(): Promise<string>;
  slice?(start: number, end: number): { text(): Promise<string> };
};

/** One file the page holds as a string at a time: keep it well inside a tab's memory. */
export const MAX_UPLOAD_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 2_000;

const KEY_RE = /^cot_[A-Za-z0-9_-]{16,}$/;
export const looksLikeBrowserKey = (v: string): boolean => KEY_RE.test(v.trim());
const maskKey = (k: string): string => `cot_…${k.slice(-4)}`;

export async function sha256HexWeb(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type BrowserImportOptions = {
  key: string;
  /** The SPA's API base ("" for same origin). */
  apiBase: string;
  ingestEndpoint: string;
  dryRun: boolean;
  sinceMs?: number;
  content?: Partial<ContentBySource>;
  maxSessions?: number;
  /** Stamped as user.email on every imported record (the only identity a page knows). */
  identity?: { email?: string };
  fetchImpl?: FetchLike;
  nowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
};

type Group = { source: ImportSource; sessionId: string; files: UploadFile[] };

/** Which assistant wrote this file, and the session it belongs to — from its
 *  name and first records. Claude subagent transcripts carry their parent's
 *  sessionId, so they group with it. */
function classify(name: string, head: string): { source: ImportSource; sessionId: string } | null {
  for (const line of head.split("\n").slice(0, 50)) {
    if (!line.trim()) continue;
    let r: Record<string, any>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type === "session_meta") {
      const id = r.payload?.id ?? r.payload?.session_id;
      return { source: "codex", sessionId: typeof id === "string" && id ? id : codexSessionIdFromName(name) ?? name };
    }
    if (typeof r?.sessionId === "string" && r.sessionId) return { source: "claude-code", sessionId: r.sessionId };
  }
  if (/^rollout-/i.test(name)) return { source: "codex", sessionId: codexSessionIdFromName(name) ?? name };
  return null;
}

async function parseGroup(g: Group, keep: ContentPolicy): Promise<ImportedSession | null | "too_many_events"> {
  const acc = g.source === "claude-code" ? new ClaudeSessionAccumulator({ keep }) : new CodexSessionAccumulator({ keep });
  for (const f of g.files) {
    const text = await f.text();
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      acc.line(text.slice(start, end === -1 ? text.length : end));
      if (acc.overflowed) return "too_many_events";
      start = end === -1 ? text.length : end + 1;
    }
  }
  const bytes = g.files.reduce((n, f) => n + f.size, 0);
  const mtime = Math.max(...g.files.map((f) => f.lastModified));
  return acc.finish({ files: g.files.map((f) => f.name), fileSig: `${bytes}:${mtime}:${g.files.length}`, fallbackSessionId: g.sessionId });
}

type UploadVisitor = {
  found(source: ImportSource): void;
  skip(source: ImportSource, reason: keyof SkipCounts): void;
  session(session: ImportedSession, group: Group): Promise<void>;
};

/**
 * The classify → group → parse loop both upload paths share: files are
 * grouped into sessions within the page's memory bounds, cheap mtime filters
 * run first, then each session is parsed and handed to `visit.session`.
 */
async function visitUploads(
  files: UploadFile[],
  o: { now: number; sinceMs: number; keep: (source: ImportSource) => ContentPolicy; warnings: string[] },
  visit: UploadVisitor,
): Promise<void> {
  const groups = new Map<string, Group>();
  let total = 0;
  for (const f of files.slice(0, MAX_UPLOAD_FILES)) {
    if (!f.name.endsWith(".jsonl")) {
      o.warnings.push(`${f.name}: not a .jsonl session file; skipped`);
      continue;
    }
    if (f.size > MAX_UPLOAD_FILE_BYTES || total + f.size > MAX_UPLOAD_TOTAL_BYTES) {
      o.warnings.push(`${f.name}: too large to read in the browser; use \`npx @codetelemetry/connect import\``);
      continue;
    }
    total += f.size;
    const head = await (f.slice ? f.slice(0, 256 * 1024).text() : f.text().then((t) => t.slice(0, 256 * 1024)));
    const kind = classify(f.name, head);
    if (!kind) {
      o.warnings.push(`${f.name}: not a Claude Code transcript or Codex rollout; skipped`);
      continue;
    }
    const id = `${kind.source}:${kind.sessionId}`;
    const g = groups.get(id) ?? { ...kind, files: [] };
    g.files.push(f);
    groups.set(id, g);
    visit.found(kind.source);
  }
  if (files.length > MAX_UPLOAD_FILES) o.warnings.push(`only the first ${MAX_UPLOAD_FILES} files were read`);

  for (const g of groups.values()) {
    const mtime = Math.max(...g.files.map((f) => f.lastModified));
    if (mtime < o.sinceMs) {
      visit.skip(g.source, "older");
      continue;
    }
    if (mtime > o.now - ACTIVE_GRACE_MS) {
      visit.skip(g.source, "active");
      continue;
    }
    const session = await parseGroup(g, o.keep(g.source));
    if (session === "too_many_events") {
      visit.skip(g.source, "too_many_events");
      continue;
    }
    if (!session) {
      visit.skip(g.source, "empty");
      continue;
    }
    await visit.session(session, g);
  }
}

/** Import dropped Claude Code transcripts and Codex rollouts. */
export async function importFiles(files: UploadFile[], opts: BrowserImportOptions): Promise<ImportRunResult> {
  const key = opts.key.trim();
  if (!looksLikeBrowserKey(key)) throw new Error("not a CodeTelemetry ingest key (expected cot_…)");
  const now = opts.nowMs ?? Date.now();
  const content = contentOrDefault(opts.content);
  const warnings: string[] = [];
  const window = resolveWindow(now, opts.sinceMs);
  if (window.warning) warnings.push(window.warning);
  const summaries = new Map<ImportSource, ImportSourceSummary>([
    ["claude-code", emptySummary("claude-code")],
    ["codex", emptySummary("codex")],
  ]);
  const email = opts.identity?.email?.trim();
  const identity = email ? { "claude-code": { "user.email": email }, codex: { "user.email": email } } : undefined;

  const prepareOpts = {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    caseInsensitivePaths: false,
    content,
    identity,
    sha256Hex: sha256HexWeb,
  };
  const prepared: Prepared[] = [];
  await visitUploads(files, { now, sinceMs: window.sinceMs, keep: (source) => content[source], warnings }, {
    found: (source) => {
      summaries.get(source)!.filesFound++;
    },
    skip: (source, reason) => bump(summaries.get(source)!, reason),
    session: async (session, g) => {
      const s = summaries.get(g.source)!;
      s.sessionsParsed++;
      const reload = async () => {
        const again = await parseGroup(g, content[g.source]);
        return again === "too_many_events" ? null : again;
      };
      const p = await prepareSession(session, session.fileSig, reload, prepareOpts);
      if (typeof p === "string") {
        bump(s, p);
        return;
      }
      s.candidates++;
      prepared.push(p);
    },
  });

  const keyHash = await sha256HexWeb(key);
  return importPrepared(prepared, {
    ...prepareOpts,
    key,
    keyHash,
    keyMasked: maskKey(key),
    statusUrl: `${opts.apiBase.replace(/\/$/, "")}/api/agent/import-status`,
    reportUrl: `${opts.apiBase.replace(/\/$/, "")}/api/agent/import-report`,
    ingestEndpoint: opts.ingestEndpoint.replace(/\/$/, ""),
    dryRun: opts.dryRun,
    run: crypto.randomUUID(),
    importTool: "web-upload",
    maxSessions: opts.maxSessions,
    clamped: window.clamped,
    now,
    clock: () => (opts.nowMs === undefined ? Date.now() : opts.nowMs),
    fetchImpl: opts.fetchImpl ?? ((input, init) => fetch(input, init)),
    sleep: opts.sleep,
    ledger: memoryLedger(),
    summaries,
    warnings,
    logger: opts.logger,
  });
}

/**
 * Estimate dropped transcripts / rollouts without a key and without sending
 * anything: sessions and tokens per source, month and day over the window
 * (default the retained year). Same grouping, filters and parsers as
 * `importFiles`, so the estimate covers what an upload would read.
 */
export async function estimateFiles(files: UploadFile[], opts: { nowMs?: number; sinceMs?: number } = {}): Promise<HistoryEstimate> {
  const now = opts.nowMs ?? Date.now();
  const window = estimateWindow(now, opts.sinceMs);
  const builder = new EstimateBuilder({ sinceMs: window.sinceMs, untilMs: window.untilMs, nowMs: now, sources: ["claude-code", "codex"] });
  const warnings: string[] = [];
  if (window.warning) warnings.push(window.warning);
  await visitUploads(files, { now, sinceMs: window.sinceMs, keep: () => NO_CONTENT, warnings }, {
    found: (source) => builder.found(source),
    skip: (source, reason) => builder.skip(source, reason),
    session: async (session) => {
      const outcome = builder.add(session);
      if (outcome !== "added") builder.skip(session.source, outcome);
    },
  });
  for (const w of warnings) builder.warn(w);
  return builder.finish({ claudeCleanupPeriodDays: null });
}
