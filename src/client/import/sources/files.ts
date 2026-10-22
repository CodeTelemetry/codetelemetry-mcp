// Filesystem half of the session-history importers: find the local session
// files, describe them cheaply (size + mtime, no reads), and stream their lines
// into the pure parsers. Streaming keeps memory bounded by the parsed events,
// never by file size — real Claude transcripts exceed 100 MB.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

const readDir = (dir: string): fs.Dirent[] => {
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
export function scanClaudeSessions(projectsDir: string): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  for (const project of readDir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    for (const entry of readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionDir = path.join(dir, entry.name.slice(0, -".jsonl".length), "subagents");
      const extras = readDir(sessionDir)
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
export function scanCodexSessions(sessionsDir: string): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const e of readDir(dir)) {
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

async function feedLines(file: string, onLine: (line: string) => void): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) onLine(line);
  } finally {
    rl.close();
    stream.destroy();
  }
}

export type ParseOutcome =
  | { ok: true; session: ImportedSession | null }
  | { ok: false; reason: "too_large" | "too_many_events" | "unreadable"; detail: string };

/** Stream one candidate's files through its parser. */
export async function parseCandidate(c: SessionCandidate, keep: ContentPolicy): Promise<ParseOutcome> {
  if (c.bytes > MAX_SESSION_FILE_BYTES) {
    return { ok: false, reason: "too_large", detail: `${c.bytes} bytes exceeds the ${MAX_SESSION_FILE_BYTES}-byte session bound` };
  }
  const acc = c.source === "claude-code" ? new ClaudeSessionAccumulator({ keep }) : new CodexSessionAccumulator({ keep });
  try {
    for (const f of [c.file, ...c.extraFiles]) {
      await feedLines(f, (line) => acc.line(line));
      if (acc.overflowed) break;
    }
  } catch (err) {
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
