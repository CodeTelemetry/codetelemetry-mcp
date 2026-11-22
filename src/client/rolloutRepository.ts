import fs from "node:fs";
import path from "node:path";
import { githubOrigin } from "./repositoryOrigin.ts";
import { assertKey } from "./keys.ts";
import { toOtlpLogs } from "./import/otlpImport.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Read only the rollout's opening metadata. A copied ancestor record in a fork
// must never supply the origin for the child named by the file.
export function rolloutRepository(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Expected a regular rollout file.");
    const bytes = Buffer.alloc(256 * 1024);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, length).indexOf(10);
    if (end < 0 && length === bytes.length) throw new Error("Rollout header exceeds 256 KiB.");
    const header = JSON.parse(bytes.toString("utf8", 0, end < 0 ? length : end));
    const meta = header.payload;
    const id = meta?.id;
    if (header.type !== "session_meta" || typeof id !== "string" || !uuid.test(id) ||
        !path.basename(file).endsWith("-" + id + ".jsonl")) throw new Error("Rollout header and filename must identify the same session.");
    const at = Date.parse(header.timestamp);
    if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 300000) throw new Error("Invalid rollout timestamp.");
    const url = githubOrigin(meta.git?.repository_url);
    const parent = meta.parent_thread_id;
    if (!url && !(typeof parent === "string" && uuid.test(parent) && parent !== id)) return null;
    return { timeUnixNano: String(BigInt(at) * 1000000n), attributes: {
      "event.name": "codetelemetry.repository_observed", "session.id": id,
      ...(url ? { "vcs.repository.url.full": url } : {}),
      ...(typeof parent === "string" && uuid.test(parent) && parent !== id ? { "codex.parent_thread_id": parent } : {}),
    } };
  } finally { fs.closeSync(fd); }
}

async function stateRepositories(file: string, ids: string[]) {
  if (ids.some(id => !uuid.test(id))) throw new Error("Select exact Codex thread UUIDs with --state.");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=500; BEGIN");
    // State storage can outlive its rollout files. Read only the indexed thread
    // identity, its observation time, and the Git origin recorded by Codex.
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='threads'").get() ||
        !db.prepare("SELECT count(*) FROM pragma_table_info('threads') WHERE pk>0 HAVING count(*)=1 AND max(name)='id'").get())
      throw new Error("Unrecognized Codex state database.");
    const read = db.prepare("SELECT updated_at, CASE WHEN length(CAST(git_origin_url AS BLOB)) <= 200 THEN git_origin_url END AS remote FROM threads WHERE id=?");
    return ids.flatMap(id => {
      const row = read.get(id);
      const url = githubOrigin(row?.remote);
      const seconds = Number(row?.updated_at);
      if (!url || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Date.now()/1000+300) return [];
      return [{ timeUnixNano: String(BigInt(seconds)*1000000000n), attributes: {
        "event.name": "codetelemetry.repository_observed", "session.id": id, "vcs.repository.url.full": url,
      }}];
    });
  } finally { db.close(); }
}

export async function reportRolloutRepositories(files: string[], send: boolean, stateFile?: string) {
  if (!files.length || files.length > 100) throw new Error("Select between 1 and 100 rollout files or thread IDs.");
  const rows = stateFile ? await stateRepositories(stateFile, files) : files.map(rolloutRepository).filter(row => row !== null);
  if (send && rows.length) {
    const key = assertKey(process.env.CODETELEMETRY_INGEST_KEY);
    const response = await fetch("https://ingest.codetelemetry.com/v1/logs", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(toOtlpLogs(rows, { "service.name": "codetelemetry-connect" }, { name: "codetelemetry.rollout-repository", version: "1" })),
    });
    if (!response.ok) throw new Error("Repository metadata delivery returned HTTP " + response.status);
    const body = await response.text();
    if (body && Number(JSON.parse(body).partialSuccess?.rejectedLogRecords || 0)) throw new Error("Collector rejected repository metadata.");
  }
  return { sent: send ? rows.length : 0, skipped: files.length - rows.length, observations: rows };
}
