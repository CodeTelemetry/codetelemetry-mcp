// Local import ledger: per ingest key (by hash), which sessions were imported,
// under which plan, and which parts of an unfinished plan were accepted.
//
// Token METRIC points are not idempotent downstream (see convert.ts), so a
// metric part must never be sent twice: every accepted part is appended to the
// ledger's journal (one small line, fsynced) before the next request goes out.
// The server's import-status read stays the authority for "captured live" and
// "already imported"; the ledger is what makes an interrupted session resumable
// on this machine and lets a re-run skip finished, unchanged sessions without
// re-reading their files.
//
// Layout: `import-ledger.json` (snapshot) + `import-ledger.journal` (JSON lines
// appended since the snapshot). Opening replays the journal over the snapshot;
// `compact()` folds it back. The files hold no secrets and no content — key
// hashes, session ids, plan ids, part numbers, counts. Size is bounded: at most
// MAX_LEDGER_KEYS keys and MAX_LEDGER_SESSIONS sessions per key (oldest
// complete entries pruned first; partial entries are kept because they are what
// prevents a resend). A snapshot from a newer importer version is never
// rewritten: the store runs read-only in memory instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LEDGER_VERSION = 1;
export const MAX_LEDGER_SESSIONS = 50_000;
export const MAX_LEDGER_KEYS = 16;
const COMPACT_AFTER_LINES = 5_000;

export type LedgerEntry = {
  plan: string;
  fileSig: string;
  state: "partial" | "complete";
  logParts: number[];
  metricParts: number[];
  /** Metric parts whose outcome is unknown (sent, no definitive answer). They
   *  are never resent blind: the next run asks the server whether they landed. */
  uncertainMetricParts: number[];
  logPartCount: number;
  metricPartCount: number;
  run: string;
  /** Last update, epoch ms. */
  atMs: number;
};

type Snapshot = {
  version: typeof LEDGER_VERSION;
  keys: Record<string, Record<string, LedgerEntry>>;
};

export type JournalEvent =
  | { k: string; s: string; ev: "begin"; plan: string; fileSig: string; logPartCount: number; metricPartCount: number; run: string; atMs: number }
  | { k: string; s: string; ev: "log" | "metric" | "uncertain"; plan: string; part: number; atMs: number }
  | { k: string; s: string; ev: "complete"; plan: string; atMs: number };

export function resolveLedgerPath(home?: string): string {
  return path.join(home ?? os.homedir(), ".codetelemetry", "import-ledger.json");
}

const journalPathOf = (ledgerPath: string): string => ledgerPath.replace(/\.json$/, "") + ".journal";

const addUnique = (list: number[], n: number): void => {
  if (!list.includes(n)) list.push(n);
};

export class LedgerStore {
  readonly path: string;
  readonly journalPath: string;
  /** True when the snapshot belongs to a newer importer: nothing is written. */
  readonly readOnly: boolean;
  #snap: Snapshot;
  #journalLines = 0;

  private constructor(ledgerPath: string, snap: Snapshot, readOnly: boolean) {
    this.path = ledgerPath;
    this.journalPath = journalPathOf(ledgerPath);
    this.#snap = snap;
    this.readOnly = readOnly;
  }

  static open(ledgerPath: string): LedgerStore {
    let snap: Snapshot = { version: LEDGER_VERSION, keys: {} };
    let readOnly = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      if (parsed && parsed.version === LEDGER_VERSION && parsed.keys && typeof parsed.keys === "object") {
        snap = parsed as Snapshot;
      } else if (parsed && typeof parsed.version === "number" && parsed.version > LEDGER_VERSION) {
        readOnly = true;
      }
    } catch {
      /* missing or corrupt → fresh; the server status read still guards duplicates */
    }
    const store = new LedgerStore(ledgerPath, snap, readOnly);
    if (!readOnly) {
      let raw = "";
      try {
        raw = fs.readFileSync(store.journalPath, "utf8");
      } catch {
        /* no journal */
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          store.#apply(JSON.parse(line) as JournalEvent);
          store.#journalLines++;
        } catch {
          /* a torn last line from a crash — everything before it applied */
        }
      }
    }
    return store;
  }

  entries(keyHash: string): Record<string, LedgerEntry> {
    return this.#snap.keys[keyHash] ?? {};
  }

  get(keyHash: string, sessionKey: string): LedgerEntry | undefined {
    return this.#snap.keys[keyHash]?.[sessionKey];
  }

  #apply(e: JournalEvent): void {
    const bucket = (this.#snap.keys[e.k] ??= {});
    if (e.ev === "begin") {
      const prev = bucket[e.s];
      if (prev && prev.plan === e.plan) {
        prev.run = e.run;
        prev.atMs = e.atMs;
        prev.fileSig = e.fileSig;
        return;
      }
      bucket[e.s] = {
        plan: e.plan,
        fileSig: e.fileSig,
        state: "partial",
        logParts: [],
        metricParts: [],
        uncertainMetricParts: [],
        logPartCount: e.logPartCount,
        metricPartCount: e.metricPartCount,
        run: e.run,
        atMs: e.atMs,
      };
      return;
    }
    const entry = bucket[e.s];
    if (!entry || entry.plan !== e.plan) return;
    entry.atMs = e.atMs;
    if (e.ev === "log") addUnique(entry.logParts, e.part);
    else if (e.ev === "metric") {
      addUnique(entry.metricParts, e.part);
      entry.uncertainMetricParts = entry.uncertainMetricParts.filter((p) => p !== e.part);
    } else if (e.ev === "uncertain") addUnique(entry.uncertainMetricParts, e.part);
    else if (e.ev === "complete") entry.state = "complete";
  }

  /** Apply and durably append one event (fsync) before returning. */
  record(e: JournalEvent): void {
    this.#apply(e);
    if (this.readOnly) return;
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
    const fd = fs.openSync(this.journalPath, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(e) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (++this.#journalLines >= COMPACT_AFTER_LINES) this.compact();
  }

  /** Fold the journal into a bounded snapshot (atomic tmp + rename). */
  compact(): void {
    if (this.readOnly) return;
    prune(this.#snap);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#snap) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.path);
    try {
      fs.chmodSync(this.path, 0o600);
    } catch {
      /* non-POSIX filesystem */
    }
    try {
      fs.rmSync(this.journalPath, { force: true });
    } catch {
      /* best effort: replaying an already-folded journal is idempotent */
    }
    this.#journalLines = 0;
  }
}

function prune(snap: Snapshot): void {
  const newest = (k: string): number =>
    Object.values(snap.keys[k]).reduce((m, e) => Math.max(m, e.atMs), 0);
  const keys = Object.keys(snap.keys);
  if (keys.length > MAX_LEDGER_KEYS) {
    for (const k of keys.sort((a, b) => newest(a) - newest(b)).slice(0, keys.length - MAX_LEDGER_KEYS)) {
      delete snap.keys[k];
    }
  }
  for (const bucket of Object.values(snap.keys)) {
    const entries = Object.entries(bucket);
    if (entries.length <= MAX_LEDGER_SESSIONS) continue;
    const complete = entries.filter(([, e]) => e.state === "complete").sort(([, a], [, b]) => a.atMs - b.atMs);
    for (const [k] of complete.slice(0, entries.length - MAX_LEDGER_SESSIONS)) delete bucket[k];
  }
}
