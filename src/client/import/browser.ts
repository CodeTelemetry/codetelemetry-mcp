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
} from "./core.ts";
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

  // Group files into sessions, within the page's memory bounds.
  const groups = new Map<string, Group>();
  let total = 0;
  for (const f of files.slice(0, MAX_UPLOAD_FILES)) {
    if (!f.name.endsWith(".jsonl")) {
      warnings.push(`${f.name}: not a .jsonl session file; skipped`);
      continue;
    }
    if (f.size > MAX_UPLOAD_FILE_BYTES || total + f.size > MAX_UPLOAD_TOTAL_BYTES) {
      warnings.push(`${f.name}: too large to import in the browser; use \`npx @codetelemetry/connect import\``);
      continue;
    }
    total += f.size;
    const head = await (f.slice ? f.slice(0, 256 * 1024).text() : f.text().then((t) => t.slice(0, 256 * 1024)));
    const kind = classify(f.name, head);
    if (!kind) {
      warnings.push(`${f.name}: not a Claude Code transcript or Codex rollout; skipped`);
      continue;
    }
    const id = `${kind.source}:${kind.sessionId}`;
    const g = groups.get(id) ?? { ...kind, files: [] };
    g.files.push(f);
    groups.set(id, g);
    summaries.get(kind.source)!.filesFound++;
  }
  if (files.length > MAX_UPLOAD_FILES) warnings.push(`only the first ${MAX_UPLOAD_FILES} files were read`);

  const prepareOpts = {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    caseInsensitivePaths: false,
    content,
    sha256Hex: sha256HexWeb,
  };
  const prepared: Prepared[] = [];
  for (const g of groups.values()) {
    const s = summaries.get(g.source)!;
    const mtime = Math.max(...g.files.map((f) => f.lastModified));
    if (mtime < window.sinceMs) {
      bump(s, "older");
      continue;
    }
    if (mtime > now - ACTIVE_GRACE_MS) {
      bump(s, "active");
      continue;
    }
    const session = await parseGroup(g, content[g.source]);
    if (session === "too_many_events") {
      bump(s, "too_many_events");
      continue;
    }
    if (!session) {
      bump(s, "empty");
      continue;
    }
    s.sessionsParsed++;
    const reload = async () => {
      const again = await parseGroup(g, content[g.source]);
      return again === "too_many_events" ? null : again;
    };
    const p = await prepareSession(session, session.fileSig, reload, prepareOpts);
    if (typeof p === "string") {
      bump(s, p);
      continue;
    }
    s.candidates++;
    prepared.push(p);
  }

  const keyHash = await sha256HexWeb(key);
  return importPrepared(prepared, {
    ...prepareOpts,
    key,
    keyHash,
    keyMasked: maskKey(key),
    statusUrl: `${opts.apiBase.replace(/\/$/, "")}/api/agent/import-status`,
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
