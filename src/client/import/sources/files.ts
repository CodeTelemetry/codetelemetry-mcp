// Filesystem half of the session-history importers: find the local session
// files, describe them cheaply (size + mtime, no reads), and stream their lines
// into the pure parsers. Streaming keeps memory bounded by the parsed events,
// never by file size — real Claude transcripts exceed 100 MB.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { ContentPolicy, ImportSource, ImportedSession } from "../model.ts";
import { ClaudeSessionAccumulator } from "./claudeCodeText.ts";
import { CodexSessionAccumulator, codexSessionIdFromName } from "./codexText.ts";

/** A file larger than this is refused (reported, never partially imported). */
export const MAX_SESSION_FILE_BYTES = 512 * 1024 * 1024;
/** Subagent transcripts folded into one Claude session, at most. */
export const MAX_SUBAGENT_FILES = 2_000;

/** One importable session as found on disk, before any file is read. */
export type SessionCandidate = {
  source: ImportSource;
  /** The main file (Claude transcript / Codex rollout). */
  file: string;
  /** Claude subagent transcripts that belong to the same session. */
  extraFiles: string[];
  /** Newest mtime across the files: no event can be newer than this. */
  mtimeMs: number;
  bytes: number;
  /** `${bytes}:${mtimeMs}` — changes whenever any file of the session changes. */
  fileSig: string;
};

export function defaultClaudeProjectsDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".claude", "projects");
}

export function defaultCodexSessionsDir(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!home && env.CODEX_HOME) return path.join(env.CODEX_HOME, "sessions");
  return path.join(home ?? os.homedir(), ".codex", "sessions");
}

const statOrNull = (p: string): fs.Stats | null => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

export type ScanBudget = { remainingEntries: number; deadline: number };
export type HistoryReadBudget = { remainingBytes: number; deadline: number };
export class HistoryReadBudgetError extends Error {}

/** Read only enough metadata to identify the same first cwd as the parser.
 * Unknown or truncated headers fall back to the full parser, never omission.
 * This prevents unrelated multi-megabyte transcripts consuming a project's
 * entire read budget. Header bytes count against that same shared budget. */
export function candidateProjectDirectory(c: SessionCandidate, budget: HistoryReadBudget): string | null {
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(4096);
  let pending = "", consumed = 0;
  const cwdOf = (line: string): string | null => {
    try {
      const row = JSON.parse(line);
      const cwd = c.source === "claude-code" ? row?.cwd
        : row?.type === "session_meta" || row?.type === "turn_context" ? row?.payload?.cwd : null;
      return typeof cwd === "string" && cwd ? cwd : null;
    } catch { return null; }
  };
  let fd: number;
  try { fd = fs.openSync(c.file, "r"); } catch { return null; }
  try {
    while (consumed < Math.min(c.bytes, 256 * 1024)) {
      if (Date.now() >= budget.deadline) throw new HistoryReadBudgetError("History discovery reached its time bound; narrow --since and preview again.");
      if (budget.remainingBytes <= 0) throw new HistoryReadBudgetError("History preview reached its 128 MiB read bound; narrow --since and preview again.");
      const take = Math.min(buffer.length, c.bytes - consumed, 256 * 1024 - consumed, budget.remainingBytes);
      const count = fs.readSync(fd, buffer, 0, take, consumed);
      if (!count) break;
      consumed += count; budget.remainingBytes -= count;
      pending += decoder.write(buffer.subarray(0, count));
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const cwd = cwdOf(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (cwd) return cwd;
      }
    }
    return cwdOf(pending + decoder.end());
  } finally { fs.closeSync(fd); }
}
const readDir = (dir: string, budget?: ScanBudget): fs.Dirent[] => {
  if (budget) {
    let handle: fs.Dir;
    try { handle = fs.opendirSync(dir); } catch { return []; }
    const rows: fs.Dirent[] = [];
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        if (--budget.remainingEntries < 0 || Date.now() >= budget.deadline) throw new Error("History discovery reached its file/time bound; narrow the local history directory and preview again.");
        rows.push(entry);
      }
    } finally { handle.closeSync(); }
    return rows;
  }
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

function describe(source: ImportSource, file: string, extraFiles: string[]): SessionCandidate | null {
  const main = statOrNull(file);
  if (!main) return null;
  let bytes = main.size;
  let mtimeMs = Math.floor(main.mtimeMs);
  const kept: string[] = [];
  for (const f of extraFiles) {
    const s = statOrNull(f);
    if (!s) continue;
    kept.push(f);
    bytes += s.size;
    mtimeMs = Math.max(mtimeMs, Math.floor(s.mtimeMs));
  }
  return { source, file, extraFiles: kept, mtimeMs, bytes, fileSig: `${bytes}:${mtimeMs}:${kept.length}` };
}

/**
 * Claude Code sessions: `<projects>/<encoded-cwd>/<sessionId>.jsonl`, plus the
 * session's `<sessionId>/subagents/*.jsonl`. Other nested directories hold tool
 * artifacts and memory, not transcripts.
 */
export function scanClaudeSessions(projectsDir: string, budget?: ScanBudget): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  for (const project of readDir(projectsDir, budget)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    for (const entry of readDir(dir, budget)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionDir = path.join(dir, entry.name.slice(0, -".jsonl".length), "subagents");
      const extras = readDir(sessionDir, budget)
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(sessionDir, e.name))
        .sort()
        .slice(0, MAX_SUBAGENT_FILES);
      const c = describe("claude-code", path.join(dir, entry.name), extras);
      if (c) out.push(c);
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Codex rollouts: `<sessions>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. */
export function scanCodexSessions(sessionsDir: string, budget?: ScanBudget): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const e of readDir(dir, budget)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        const c = describe("codex", full, []);
        if (c) out.push(c);
      }
    }
  };
  walk(sessionsDir, 0);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

async function feedLines(file: string, onLine: (line: string) => void, remaining: { bytes: number }, limits?: { deadline: number; budget?: HistoryReadBudget }): Promise<void> {
  // One overflow byte detects a growing file without accepting a truncated
  // session. Physical reads and readline's longest line remain bounded too.
  const stream = fs.createReadStream(file, { highWaterMark: 16 * 1024,
    end: Math.min(remaining.bytes, limits?.budget?.remainingBytes ?? remaining.bytes) });
  stream.on("data", (chunk) => {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    remaining.bytes -= bytes;
    if (limits?.budget) limits.budget.remainingBytes -= bytes;
    if (limits?.budget && limits.budget.remainingBytes < 0)
      stream.destroy(new HistoryReadBudgetError("History preview reached its 128 MiB read bound; narrow --since and preview again."));
    else if (remaining.bytes < 0) stream.destroy(new Error("Session grew beyond its byte bound; preview it again."));
    else if (limits && Date.now() >= limits.deadline)
      stream.destroy(new HistoryReadBudgetError("History parsing reached its time bound; narrow --since and preview again."));
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (limits && Date.now() >= limits.deadline) throw new HistoryReadBudgetError("History parsing reached its time bound.");
      onLine(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export type ParseOutcome =
  | { ok: true; session: ImportedSession | null }
  | { ok: false; reason: "too_large" | "too_many_events" | "unreadable"; detail: string };

/** Stream one candidate's files through its parser. */
export async function parseCandidate(c: SessionCandidate, keep: ContentPolicy, limits?: { deadline: number; maxBytes: number; budget?: HistoryReadBudget }): Promise<ParseOutcome> {
  const byteLimit = Math.min(MAX_SESSION_FILE_BYTES, limits?.maxBytes ?? MAX_SESSION_FILE_BYTES);
  if (c.bytes > byteLimit) {
    return { ok: false, reason: "too_large", detail: `${c.bytes} bytes exceeds the ${byteLimit}-byte session bound` };
  }
  const acc = c.source === "claude-code" ? new ClaudeSessionAccumulator({ keep }) : new CodexSessionAccumulator({ keep });
  const remaining = { bytes: byteLimit };
  try {
    for (const f of [c.file, ...c.extraFiles]) {
      await feedLines(f, (line) => acc.line(line), remaining, limits);
      if (acc.overflowed) break;
    }
  } catch (err) {
    if (err instanceof HistoryReadBudgetError) throw err;
    return { ok: false, reason: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (acc.overflowed) return { ok: false, reason: "too_many_events", detail: "session exceeds the per-session event bound" };
  const base = path.basename(c.file, ".jsonl");
  return {
    ok: true,
    session: acc.finish({
      files: [c.file, ...c.extraFiles],
      fileSig: c.fileSig,
      fallbackSessionId: c.source === "codex" ? codexSessionIdFromName(c.file) : base,
    }),
  };
}
