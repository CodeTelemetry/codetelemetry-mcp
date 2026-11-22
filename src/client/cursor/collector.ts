// The Cursor hooks collector. It reads the spool the hook program appends to,
// frames settled records into source envelopes and delivers each envelope with
// the exact bytes and idempotency key it was first given. It runs as a
// background service, never inside the editor.
//
// Durable state, all under the collector's state directory:
//   checkpoint.json  what has been consumed: an offset per spool segment with
//                    the file it was read from, the per-conversation context,
//                    and running totals
//   pending.json     the one envelope in flight, written before its first
//                    request and resent unchanged until it is answered
//   rejected/        envelopes the service kept refusing, inside a byte budget
//   retry-rejected   a request, left by the command of that name, to send the
//                    quarantined envelopes again
//
// The checkpoint moves in two cases only: an envelope is answered, or a tick
// read records and none of them is uploaded. Unanswered records stay in the
// spool, so the pending file can always be discarded and framed again. Every
// loop is bounded per tick and no answer parks the queue: an envelope the
// service keeps refusing is set aside after a day and delivery moves on.

import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { claimCollectorState, cleanCollectorState, collectorBootId, readBoundedJson, writeAtomicJson } from "../collector/state.ts";
import { collectorTransport, type CollectorErrorClass, type CollectorPost, type CollectorPostDetail, type CollectorPostOutcome,
  type CollectorPostResult } from "../collector/transport.ts";
import type { ImportLog } from "../import/model.ts";
import type { FetchLike } from "../otlp.ts";
import { cursorStateFiles, type CursorPolicy } from "./config.ts";
import { CURSOR_HOOK_LIMITS, type CursorSpoolLine } from "./hookProgram.ts";
import { CURSOR_LIMITS, CURSOR_SOURCE_FORMAT, CURSOR_UPLOADED_HOOKS, CursorContext, cursorEnvelope, cursorRecordBytes, cursorTimeMs,
  frameCursorRecord, parseCursorSpoolLine, type CursorConversation, type CursorLimits } from "./records.ts";

const LABEL = "Cursor";
/** Written by `cursor retry-rejected`; the running collector acts on it. */
const RETRY_MARKER = "retry-rejected";
/** `seg-<bucket>.jsonl`, and `seg-<bucket>-<n>.jsonl` for what a full segment's bucket wrote next. */
const SEGMENT = /^seg-(\d{1,12})(?:-([1-9]\d{0,3}))?[.]jsonl$/;
const INODE = /^\d{1,20}$/;
const ENVELOPE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUARANTINED = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[.]json$/;
const OUTCOMES: readonly CollectorPostOutcome[] = ["ok", "retry", "network", "auth", "budget", "unsupported", "rejected"];
const DETAILS: readonly CollectorPostDetail[] = ["accepted", "rate_limited", "server", "auth", "budget", "unsupported", "invalid", "conflict",
  "partial", "refused", "proxy", "tls", "dns", "connect", "timeout", "network"];
const ERROR_CLASSES: readonly CollectorErrorClass[] = ["proxy", "tls", "dns", "connect", "timeout", "network"];
const TOTALS = ["spooled", "acknowledged", "malformed", "expired", "rejected", "lost", "reframed", "requests"] as const;

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isPolicy = (value: unknown): value is CursorPolicy => isRecord(value) && typeof value.prompts === "boolean" &&
  typeof value.toolDetails === "boolean" && typeof value.email === "boolean";
/** True when an option that was on for `framed` is off in `current`. */
const reduced = (framed: CursorPolicy, current: CursorPolicy): boolean =>
  (framed.prompts && !current.prompts) || (framed.toolDetails && !current.toolDetails) || (framed.email && !current.email);

/** Running totals since the state directory was created. */
export type CursorTotals = Record<(typeof TOTALS)[number], number>;
export type CursorCheckpoint = {
  version: 1;
  /** Bytes consumed from each spool segment still on disk. */
  offsets: Record<string, number>;
  /** The file each offset was counted in. A segment of the same name that is
   *  another file is read from its start. */
  inodes: Record<string, string>;
  conversations: CursorConversation[];
  totals: CursorTotals;
  /** Idempotency key of the last envelope whose answer was committed. */
  lastEnvelope?: string;
  /** Start of the last committed request, so a restart keeps the request gap. */
  lastPostAt?: number;
  lastAckAt?: number;
};
/** What an answered envelope commits: every record consumed up to the framing
 *  point, uploaded or not. */
export type CursorAdvance = {
  offsets: Record<string, number>;
  inodes: Record<string, string>;
  conversations: CursorConversation[];
  counts: { spooled: number; malformed: number; expired: number };
};
export type CursorPending = {
  version: 1;
  /** Idempotency key, minted once when the envelope was framed. */
  id: string;
  /** The exact request body. */
  body: string;
  digest: string;
  records: number;
  destinationHash: string;
  /** The capture options the envelope was framed under. */
  policy: CursorPolicy;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  lastOutcome?: CollectorPostOutcome;
  lastDetail?: CollectorPostDetail;
  lastErrorClass?: CollectorErrorClass;
  /** Consecutive answers of the same kind as the last one. */
  streak: number;
  rejections: number;
  rejectedSince?: number;
  /** Absent on an envelope returned from quarantine: its records were committed when it was set aside. */
  advance?: CursorAdvance;
  /** Id of the quarantined envelope this one was returned from. */
  requeued?: string;
};
type Quarantined = Pick<CursorPending, "version" | "id" | "body" | "digest" | "records" | "destinationHash" | "policy" | "createdAt"> & { rejectedAt: number };

export type CursorHealth = {
  version: 1;
  /** idle: nothing to send. waiting: records are settling, lingering or held by
   *  the request gap. retrying: an envelope awaits its next attempt. */
  status: "idle" | "waiting" | "retrying";
  lastTickAt: number;
  lastOutcome: CollectorPostOutcome | null;
  lastDetail: CollectorPostDetail | null;
  lastErrorClass: CollectorErrorClass | null;
  lastAckAt: number | null;
  nextAttemptAt: number | null;
  /** Records in the envelope in flight. */
  pendingRecords: number;
  /** Well-formed records consumed from the spool, context records included. */
  recordsSpooled: number;
  recordsAcknowledged: number;
  /** Lines skipped: unparsable, of the wrong shape or over a size bound. */
  recordsMalformed: number;
  recordsExpired: number;
  /** Records in envelopes set aside after a day of refusals. */
  recordsRejected: number;
  /** Records in quarantined envelopes deleted for the byte budget or a capture downgrade. */
  recordsLost: number;
  /** Envelopes framed again from the spool under a new key. */
  envelopesReframed: number;
  requests: number;
  requestsLastMinute: number;
  rejectedBytes: number;
  rejectedEnvelopes: number;
  /** Events the hook could not spool. */
  hookDrops: number;
  spoolBytes: number;
  spoolSegments: number;
  /** Spool bytes not yet consumed. */
  backlogBytes: number;
};
export type CursorHealthFile = CursorHealth & { running: boolean; pid: number };

export type CursorCollectorOptions = {
  stateDir: string;
  /** `cursorDestinationHash` of the key and endpoint the transport posts to. */
  destinationHash: string;
  /** The capture options in force now. */
  policy: CursorPolicy;
  post: CollectorPost;
  /** Sent as `codetelemetry.connect.version`. */
  connectVersion?: string;
  now?: () => number;
  /** Source of the request-gap jitter, in [0, 1). */
  random?: () => number;
  /** Identifier of the current boot; the kernel's own where it has one. */
  bootId?: string;
  limits?: Partial<CursorLimits>;
};

type Segment = { name: string; bucket: number; part: number; size: number; ino: string };
/** One line of a read. `end` is the segment offset after it, `ino` the file it
 *  was read from; `timeMs` is the capture time that settling and lingering are
 *  measured from. */
type Entry = { segment: string; end: number; ino: string } &
  ({ kind: "record"; line: CursorSpoolLine; timeMs: number } | { kind: "malformed" | "expired" | "blank" });
type RecordEntry = Extract<Entry, { kind: "record" }>;
const isRecordEntry = (entry: Entry): entry is RecordEntry => entry.kind === "record";
const UPLOADED: ReadonlySet<string> = new Set(CURSOR_UPLOADED_HOOKS);
const isUpload = (entry: Entry): entry is RecordEntry => entry.kind === "record" && UPLOADED.has(entry.line.hook);

/** What binds an envelope to where it was meant to go. */
export function cursorDestinationHash(config: { key: string; ingestEndpoint: string }): string {
  return digest(JSON.stringify([config.key, config.ingestEndpoint]));
}

/** The shared transport with the Cursor format: every body carries the source
 *  header, the onboarding probe `{"resourceLogs":[]}` included. */
export function cursorTransport(opts: {
  endpoint: string; key: string; fetchImpl?: FetchLike; allowHttp?: boolean; env?: NodeJS.ProcessEnv; now?: () => number;
}): CollectorPost {
  return collectorTransport({ ...opts, format: CURSOR_SOURCE_FORMAT, envelopeBytes: CURSOR_LIMITS.envelopeBytes,
    requestMs: CURSOR_LIMITS.requestMs, label: LABEL });
}

/** Claim one of the collector's directories. The lease names the boot it was
 *  taken under, so one that a crash or a power loss left behind never blocks a
 *  start after the machine has restarted, even if its pid is in use again. */
export function claimCursorState(directory: string, bootId: string | undefined = collectorBootId()): Promise<() => Promise<void>> {
  return claimCollectorState(directory, LABEL, { boot: bootId });
}

async function ownedDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${LABEL} state directory must not be a symlink`);
}

async function remove(file: string): Promise<void> {
  await fs.unlink(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

function restoreOffsets(value: unknown, limits: CursorLimits): Record<string, number> {
  if (!isRecord(value)) throw new Error("invalid Cursor checkpoint offsets");
  const entries = Object.entries(value);
  if (entries.length > limits.spoolEntries || !entries.every(([name, offset]) => SEGMENT.test(name) && isCount(offset))) {
    throw new Error("invalid Cursor checkpoint offsets");
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

/** The files the offsets were counted in. Absent in state written before they
 *  were recorded; an offset without one is trusted as it was then. */
function restoreInodes(value: unknown, limits: CursorLimits): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("invalid Cursor checkpoint offsets");
  const entries = Object.entries(value);
  if (entries.length > limits.spoolEntries || !entries.every(([name, ino]) => SEGMENT.test(name) && typeof ino === "string" && INODE.test(ino))) {
    throw new Error("invalid Cursor checkpoint offsets");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function restoreCheckpoint(value: unknown, limits: CursorLimits): CursorCheckpoint {
  const totals = Object.fromEntries(TOTALS.map(name => [name, 0])) as CursorTotals;
  if (value === null) return { version: 1, offsets: {}, inodes: {}, conversations: [], totals };
  // A newer contract is refused, never reset: its offsets are what keeps records from being sent twice.
  if (!isRecord(value) || value.version !== 1) throw new Error("unsupported Cursor checkpoint contract");
  if (!isRecord(value.totals) || (value.lastEnvelope !== undefined && (typeof value.lastEnvelope !== "string" || !ENVELOPE_ID.test(value.lastEnvelope))) ||
    [value.lastPostAt, value.lastAckAt].some(time => time !== undefined && !isCount(time))) throw new Error("invalid Cursor checkpoint");
  for (const name of TOTALS) {
    const total = value.totals[name];
    if (total !== undefined && !isCount(total)) throw new Error("invalid Cursor checkpoint");
    totals[name] = total ?? 0;
  }
  return {
    version: 1,
    offsets: restoreOffsets(value.offsets, limits),
    inodes: restoreInodes(value.inodes, limits),
    conversations: new CursorContext(value.conversations, limits).snapshot(),
    totals,
    ...(value.lastEnvelope !== undefined ? { lastEnvelope: value.lastEnvelope as string } : {}),
    ...(value.lastPostAt !== undefined ? { lastPostAt: value.lastPostAt as number } : {}),
    ...(value.lastAckAt !== undefined ? { lastAckAt: value.lastAckAt as number } : {}),
  };
}

/** The envelope fields shared by a pending and a quarantined file, or null. */
function restoreEnvelope(value: Record<string, unknown>, limits: CursorLimits): Quarantined | null {
  if (typeof value.id !== "string" || !ENVELOPE_ID.test(value.id) || typeof value.body !== "string" ||
    Buffer.byteLength(value.body) > limits.envelopeBytes || value.digest !== digest(value.body) ||
    !isCount(value.records) || value.records < 1 || value.records > limits.envelopeRecords ||
    typeof value.destinationHash !== "string" || !/^[a-f0-9]{64}$/.test(value.destinationHash) || !isPolicy(value.policy) ||
    !isCount(value.createdAt)) return null;
  return { version: 1, id: value.id, body: value.body, digest: value.digest as string, records: value.records,
    destinationHash: value.destinationHash, policy: { prompts: value.policy.prompts, toolDetails: value.policy.toolDetails, email: value.policy.email },
    createdAt: value.createdAt, rejectedAt: isCount(value.rejectedAt) ? value.rejectedAt : 0 };
}

/** A pending envelope read back from disk, or null when it cannot be trusted.
 *  Discarding it is safe: its records are still in the spool. */
function restorePending(value: unknown, limits: CursorLimits): CursorPending | null {
  if (isRecord(value) && typeof value.version === "number" && value.version > 1) throw new Error("unsupported Cursor pending contract");
  if (!isRecord(value) || value.version !== 1) return null;
  const envelope = restoreEnvelope(value, limits);
  if (!envelope || ![value.attempts, value.lastAttemptAt, value.nextAttemptAt, value.streak, value.rejections].every(isCount) ||
    (value.rejectedSince !== undefined && !isCount(value.rejectedSince)) ||
    (value.lastOutcome !== undefined && !OUTCOMES.includes(value.lastOutcome as CollectorPostOutcome)) ||
    (value.lastDetail !== undefined && !DETAILS.includes(value.lastDetail as CollectorPostDetail)) ||
    (value.lastErrorClass !== undefined && !ERROR_CLASSES.includes(value.lastErrorClass as CollectorErrorClass)) ||
    (value.requeued !== undefined && (typeof value.requeued !== "string" || !ENVELOPE_ID.test(value.requeued))) ||
    (value.advance === undefined) === (value.requeued === undefined)) return null;
  let advance: CursorAdvance | undefined;
  if (value.advance !== undefined) {
    const raw = value.advance;
    try {
      if (!isRecord(raw) || !isRecord(raw.counts) || ![raw.counts.spooled, raw.counts.malformed, raw.counts.expired].every(isCount)) return null;
      advance = { offsets: restoreOffsets(raw.offsets, limits), inodes: restoreInodes(raw.inodes, limits), conversations: new CursorContext(raw.conversations, limits).snapshot(),
        counts: { spooled: raw.counts.spooled as number, malformed: raw.counts.malformed as number, expired: raw.counts.expired as number } };
    } catch {
      return null;
    }
  }
  const { rejectedAt: _unused, ...shared } = envelope;
  return {
    ...shared,
    attempts: value.attempts as number,
    lastAttemptAt: value.lastAttemptAt as number,
    nextAttemptAt: value.nextAttemptAt as number,
    streak: value.streak as number,
    rejections: value.rejections as number,
    ...(value.lastOutcome !== undefined ? { lastOutcome: value.lastOutcome as CollectorPostOutcome } : {}),
    ...(value.lastDetail !== undefined ? { lastDetail: value.lastDetail as CollectorPostDetail } : {}),
    ...(value.lastErrorClass !== undefined ? { lastErrorClass: value.lastErrorClass as CollectorErrorClass } : {}),
    ...(value.rejectedSince !== undefined ? { rejectedSince: value.rejectedSince as number } : {}),
    ...(advance ? { advance } : {}),
    ...(value.requeued !== undefined ? { requeued: value.requeued as string } : {}),
  };
}

export class CursorCollector {
  private options: CursorCollectorOptions;
  private limits: CursorLimits;
  private files: ReturnType<typeof cursorStateFiles>;
  private envelopeBase: number;
  private checkpoint!: CursorCheckpoint;
  private pending: CursorPending | null = null;
  /** Quarantined envelopes, oldest first. This process is their only writer. */
  private quarantine: Array<{ id: string; bytes: number; records: number; rejectedAt: number }> = [];
  private release: (() => Promise<void>) | null = null;
  private running = false;
  private nextPostAt = 0;
  private posts: number[] = [];
  private segmentsSeen: Segment[] = [];
  /** An offset was forgotten in memory and the checkpoint on disk still holds it. */
  private forgotten = false;
  private hookDrops = 0;
  /** `requestedAt` of the retry request already applied to the envelope in flight. */
  private retryRequest: number | null = null;
  private lastTickAt = 0;
  private last: { outcome: CollectorPostOutcome | null; detail: CollectorPostDetail | null; errorClass: CollectorErrorClass | null } =
    { outcome: null, detail: null, errorClass: null };

  constructor(options: CursorCollectorOptions) {
    if (!path.isAbsolute(options.stateDir)) throw new Error("Cursor state directory must be absolute");
    if (!/^[a-f0-9]{64}$/.test(options.destinationHash)) throw new Error("Cursor destination fingerprint is required");
    if (!isPolicy(options.policy)) throw new Error("invalid Cursor capture options");
    this.options = { ...options, policy: Object.freeze({ prompts: options.policy.prompts, toolDetails: options.policy.toolDetails, email: options.policy.email }) };
    this.limits = Object.freeze({ ...CURSOR_LIMITS, ...options.limits });
    this.files = cursorStateFiles(options.stateDir);
    // Refuses a version the envelope cannot carry before any state is touched.
    this.envelopeBase = Buffer.byteLength(cursorEnvelope([], options.connectVersion));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private gap(): number {
    const jitter = Math.min(Math.max((this.options.random ?? Math.random)(), 0), 1);
    return this.limits.postGapMs + Math.floor(jitter * this.limits.postJitterMs);
  }

  private quarantinePath(id: string): string {
    return path.join(this.files.rejected, `${id}.json`);
  }

  async open(): Promise<void> {
    if (this.release) throw new Error("Cursor collector is already open");
    this.release = await claimCursorState(this.options.stateDir, this.options.bootId);
    try {
      const { limits } = this;
      await cleanCollectorState(this.options.stateDir, {
        files: ["collector.lock", "collector.recovery", "checkpoint.json", "pending.json", "health.json", "dropped", "spool-size", "node-path", "node-stale", RETRY_MARKER],
        temporaries: { "checkpoint.json.tmp": limits.checkpointBytes, "pending.json.tmp": limits.pendingBytes, "health.json.tmp": limits.healthBytes,
          [`${RETRY_MARKER}.tmp`]: 1024 },
        directories: ["spool", "rejected"],
        maxEntries: limits.spoolEntries,
        // A stray file must not stop collection.
        unknown: "ignore",
      }, LABEL);
      await ownedDirectory(this.files.spool);
      await ownedDirectory(this.files.rejected);
      this.checkpoint = restoreCheckpoint(await readBoundedJson(this.files.checkpoint, limits.checkpointBytes, LABEL), limits);
      const before = JSON.stringify(this.checkpoint.totals);
      await this.sweepQuarantine();
      await this.recoverPending();
      if (JSON.stringify(this.checkpoint.totals) !== before) await this.commit(undefined);
      const lastPost = Math.max(this.checkpoint.lastPostAt ?? 0, this.pending?.lastAttemptAt ?? 0);
      this.nextPostAt = lastPost ? lastPost + this.gap() : 0;
      if (this.pending?.lastOutcome) {
        this.last = { outcome: this.pending.lastOutcome, detail: this.pending.lastDetail ?? null, errorClass: this.pending.lastErrorClass ?? null };
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.release) return;
    const release = this.release;
    this.release = null;
    await release();
  }

  /** One quarantined envelope, or null when the file is gone or cannot be trusted. */
  private async readQuarantined(id: string): Promise<Quarantined | null> {
    try {
      const value = await readBoundedJson(this.quarantinePath(id), this.limits.pendingBytes, LABEL);
      return isRecord(value) && value.version === 1 ? restoreEnvelope(value, this.limits) : null;
    } catch {
      return null;
    }
  }

  /** At start: index the quarantine, remove what a crash left behind, and
   *  delete every envelope framed under a capture option that is now off. An
   *  envelope that cannot be read cannot be sent again and may hold such
   *  content, so it goes too. */
  private async sweepQuarantine(): Promise<void> {
    this.quarantine = [];
    const directory = await fs.opendir(this.files.rejected, { bufferSize: 64 });
    let seen = 0;
    try {
      for await (const entry of directory) {
        if (++seen > this.limits.rejectedFiles * 4) break;
        if (!entry.isFile()) continue;
        const file = path.join(this.files.rejected, entry.name);
        if (entry.name.endsWith(".tmp")) {
          await remove(file);
          continue;
        }
        const id = QUARANTINED.exec(entry.name)?.[1];
        if (!id) continue;
        const envelope = await this.readQuarantined(id);
        if (!envelope || envelope.id !== id || reduced(envelope.policy, this.options.policy)) {
          await remove(file);
          if (envelope) this.checkpoint.totals.lost += envelope.records;
          continue;
        }
        this.quarantine.push({ id, bytes: (await fs.lstat(file)).size, records: envelope.records, rejectedAt: envelope.rejectedAt });
      }
    } finally {
      await directory.close().catch(() => {});
    }
    this.quarantine.sort((a, b) => a.rejectedAt - b.rejectedAt || (a.id < b.id ? -1 : 1));
    this.checkpoint.totals.lost += await this.pruneQuarantine();
  }

  /** Keep the quarantine inside its budget, oldest out first. Returns the records deleted. */
  private async pruneQuarantine(): Promise<number> {
    let lost = 0;
    const bytes = () => this.quarantine.reduce((sum, item) => sum + item.bytes, 0);
    while (this.quarantine.length > this.limits.rejectedFiles || (this.quarantine.length && bytes() > this.limits.rejectedBytes)) {
      const oldest = this.quarantine.shift()!;
      await remove(this.quarantinePath(oldest.id));
      lost += oldest.records;
    }
    return lost;
  }

  /** At start: decide what the envelope a previous process left in flight is
   *  worth. Its exact bytes and key are kept unless the answer was already
   *  committed, the file cannot be trusted, the destination changed, or a
   *  capture option it was framed under is now off; in each of those cases the
   *  records are framed again. An option that was turned on changes nothing
   *  here: the service may already hold these bytes under this key, and a
   *  second key would make it count them twice. */
  private async recoverPending(): Promise<void> {
    const { totals } = this.checkpoint, policy = this.options.policy;
    let raw: unknown;
    try {
      raw = await readBoundedJson(this.files.pending, this.limits.pendingBytes, LABEL);
    } catch {
      raw = undefined;
    }
    if (raw === null) return;
    const pending = raw === undefined ? null : restorePending(raw, this.limits);
    if (pending && pending.id === this.checkpoint.lastEnvelope) {
      // Answered and committed; only the removal of this file was interrupted.
      await remove(this.files.pending);
      return;
    }
    // A crash between two writes can leave an envelope both in flight and in
    // quarantine. The one in flight is the one whose answer is still owed.
    if (pending) for (const id of new Set([pending.id, pending.requeued ?? pending.id])) await this.forget(id);
    if (pending?.requeued !== undefined) {
      if (reduced(pending.policy, policy)) {
        totals.lost += pending.records;
        totals.requests += pending.attempts;
        await remove(this.files.pending);
        return;
      }
      if (pending.destinationHash !== this.options.destinationHash) this.rekey(pending, this.now());
      this.pending = pending;
      return;
    }
    if (!pending || pending.destinationHash !== this.options.destinationHash || reduced(pending.policy, policy)) {
      totals.reframed++;
      totals.requests += pending?.attempts ?? 0;
      // Its last request still counts toward the request gap. A file that
      // cannot be read was last written no earlier than that request started.
      const lastAttemptAt = pending ? pending.lastAttemptAt : await this.writtenAt(this.files.pending);
      this.checkpoint.lastPostAt = Math.max(this.checkpoint.lastPostAt ?? 0, lastAttemptAt);
      await remove(this.files.pending);
      return;
    }
    this.pending = pending;
  }

  /** When a state file was last written, never later than now; 0 when unknown. */
  private async writtenAt(file: string): Promise<number> {
    try {
      return Math.max(0, Math.min(this.now(), Math.floor((await fs.lstat(file)).mtimeMs)));
    } catch {
      return 0;
    }
  }

  /** Drop one envelope from quarantine. */
  private async forget(id: string): Promise<void> {
    await remove(this.quarantinePath(id));
    this.quarantine = this.quarantine.filter(item => item.id !== id);
  }

  /** The same bytes under a new key, for the destination in force now. */
  private rekey(pending: CursorPending, now: number): void {
    pending.id = randomUUID();
    pending.createdAt = now;
    pending.destinationHash = this.options.destinationHash;
  }

  private async savePending(): Promise<void> {
    await writeAtomicJson(this.files.pending, this.pending, this.limits.pendingBytes, LABEL);
  }

  /** Write the checkpoint, then adopt it. */
  private async commit(advance: CursorAdvance | undefined, change: Partial<CursorTotals> = {},
    marks: Partial<Pick<CursorCheckpoint, "lastEnvelope" | "lastPostAt" | "lastAckAt">> = {}): Promise<void> {
    const totals = { ...this.checkpoint.totals };
    if (advance) {
      totals.spooled += advance.counts.spooled;
      totals.malformed += advance.counts.malformed;
      totals.expired += advance.counts.expired;
    }
    for (const name of TOTALS) totals[name] += change[name] ?? 0;
    const next: CursorCheckpoint = { ...this.checkpoint,
      ...(advance ? { offsets: advance.offsets, inodes: advance.inodes, conversations: advance.conversations } : {}), totals, ...marks };
    await writeAtomicJson(this.files.checkpoint, next, this.limits.checkpointBytes, LABEL);
    this.checkpoint = next;
    this.forgotten = false;
  }

  /** Spool segments in the order they were written, with their sizes, from a
   *  bounded look at the directory. An offset is forgotten when its segment is
   *  gone, is another file than the one the offset was counted in, or is
   *  shorter than the offset: in each case what is there now was never read.
   *  A segment that could not be looked at keeps its offset. */
  private async listSegments(): Promise<Segment[]> {
    const names: Array<{ name: string; bucket: number; part: number }> = [];
    let seen = 0;
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(this.files.spool, { bufferSize: 64 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Cursor spool is unreadable");
    }
    try {
      for await (const entry of directory) {
        if (++seen > this.limits.spoolEntries) break;
        const match = SEGMENT.exec(entry.name);
        if (match && entry.isFile() && String(Number(match[1])) === match[1]) names.push({ name: entry.name, bucket: Number(match[1]), part: Number(match[2] ?? 0) });
      }
    } finally {
      await directory.close().catch(() => {});
    }
    names.sort((a, b) => a.bucket - b.bucket || a.part - b.part);
    const segments: Segment[] = [], unknown = new Set<string>();
    for (const { name, bucket, part } of names) {
      try {
        const stat = await fs.lstat(path.join(this.files.spool, name));
        if (stat.isFile()) segments.push({ name, bucket, part, size: stat.size, ino: String(stat.ino) });
      } catch (error) {
        // Only a file that is gone has nothing left to resume.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown.add(name);
      }
    }
    const present = new Map(segments.map(segment => [segment.name, segment]));
    const { offsets, inodes } = this.checkpoint;
    for (const name of Object.keys(offsets)) {
      if (unknown.has(name)) continue;
      const segment = present.get(name), ino = inodes[name];
      if (segment && (ino === undefined || ino === segment.ino) && offsets[name] <= segment.size) continue;
      delete offsets[name];
      this.forgotten = true;
    }
    for (const name of Object.keys(inodes)) if (!Object.hasOwn(offsets, name)) delete inodes[name];
    return segments;
  }

  /** A segment is closed once its bucket is older than the one before the
   *  current: no hook can still be appending to it. */
  private closed(segment: Segment, now: number): boolean {
    return segment.bucket < Math.floor(now / CURSOR_HOOK_LIMITS.segmentMs) - 1;
  }

  /** Count and consume what is left of segments whose every record is past the
   *  expiry age, without reading the records: `retire` then deletes them. This
   *  runs whether or not an envelope is in flight, so a service that keeps
   *  refusing does not keep fourteen-day-old records on disk. A stretch the
   *  envelope in flight covers is left to that envelope's answer: it is
   *  reclaimed by the pass in which the envelope is answered or given up,
   *  which is at most the reframing age later. */
  private async expire(segments: Segment[], now: number): Promise<void> {
    const horizon = now - this.limits.expireMs, covered = this.pending?.advance?.offsets ?? {}, deadline = now + this.limits.tickBudgetMs;
    const offsets = { ...this.checkpoint.offsets }, inodes = { ...this.checkpoint.inodes };
    let expired = 0, moved = false, budget = this.limits.expireSegmentsPerTick;
    for (const segment of segments) {
      // A record is stamped before the end of its bucket; one more bucket allows for a slow hook.
      if ((segment.bucket + 2) * CURSOR_HOOK_LIMITS.segmentMs > horizon) break;
      const from = offsets[segment.name] ?? 0;
      if (from >= segment.size || (covered[segment.name] ?? 0) > from) continue;
      // The time budget ends the pass only after its first read, as it does for a window.
      if (budget-- <= 0 || (moved && this.now() >= deadline)) break;
      const chunk = await this.readChunk(segment.name, from, Math.min(segment.size - from, CURSOR_HOOK_LIMITS.segmentBytes));
      if (!chunk?.length) continue;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
        if (end > start) expired++;
        start = end + 1;
      }
      offsets[segment.name] = from + chunk.length;
      inodes[segment.name] = segment.ino;
      moved = true;
    }
    if (moved) await this.commit({ offsets, inodes, conversations: this.checkpoint.conversations, counts: { spooled: 0, malformed: 0, expired } });
  }

  /** Delete every segment that is closed and consumed to its end. */
  private async retire(segments: Segment[], now: number): Promise<Segment[]> {
    const kept: Segment[] = [];
    for (const segment of segments) {
      if (!this.closed(segment, now) || (this.checkpoint.offsets[segment.name] ?? 0) !== segment.size) {
        kept.push(segment);
        continue;
      }
      try {
        await remove(path.join(this.files.spool, segment.name));
        delete this.checkpoint.offsets[segment.name];
        delete this.checkpoint.inodes[segment.name];
        this.forgotten = true;
      } catch {
        kept.push(segment);
      }
    }
    // The removal is written down at once: a segment the hook creates under
    // the same name later must not be resumed at the old file's offset.
    if (this.forgotten) await this.commit(undefined);
    return kept;
  }

  /** Up to `length` bytes of a segment, or null when it is no longer a regular
   *  file. Never through a link, and never waiting on a FIFO put in its place. */
  private async readChunk(name: string, offset: number, length: number): Promise<Buffer | null> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(path.join(this.files.spool, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch {
      return null;
    }
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  }

  private classify(bytes: Buffer, now: number): { kind: "malformed" | "expired" | "blank" } | { kind: "record"; line: CursorSpoolLine; timeMs: number } {
    if (!bytes.length) return { kind: "blank" };
    const line = parseCursorSpoolLine(bytes);
    if (!line) return { kind: "malformed" };
    const timeMs = cursorTimeMs(line);
    if (timeMs - now > this.limits.futureMs) return { kind: "malformed" };
    if (now - timeMs > this.limits.expireMs) return { kind: "expired" };
    // A stamp ahead of the clock means the clock was set back since. Waiting
    // for it would hold everything behind it, so it counts as long settled.
    return { kind: "record", line, timeMs: timeMs - now > this.limits.settleMs ? -Infinity : timeMs };
  }

  /** Read forward from the committed offsets, in segment order, inside the
   *  tick's bounds. `more` says the reading stopped at a bound, not at the end
   *  of the spool. Nothing read here is consumed yet. */
  private async readWindow(segments: Segment[], now: number): Promise<{ entries: Entry[]; more: boolean }> {
    const { limits } = this, entries: Entry[] = [], deadline = now + limits.tickBudgetMs;
    let budget = limits.readBytes, records = 0, more = false, chunks = 0;
    for (const segment of segments) {
      const offset = this.checkpoint.offsets[segment.name] ?? 0;
      if (offset >= segment.size) continue;
      // The time budget ends a pass only after its first read, so a slow disk still makes progress.
      if (budget < CURSOR_HOOK_LIMITS.lineBytes || records >= limits.recordsPerTick || entries.length >= limits.linesPerTick ||
        (chunks > 0 && this.now() >= deadline)) {
        more = true;
        break;
      }
      const chunk = await this.readChunk(segment.name, offset, Math.min(segment.size - offset, budget));
      if (!chunk) continue;
      chunks++;
      budget -= chunk.length;
      let cursor = 0;
      while (cursor < chunk.length) {
        if (records >= limits.recordsPerTick || entries.length >= limits.linesPerTick) {
          more = true;
          break;
        }
        const newline = chunk.indexOf(10, cursor);
        if (newline < 0) break;
        const entry = this.classify(chunk.subarray(cursor, newline), now);
        cursor = newline + 1;
        entries.push({ ...entry, segment: segment.name, end: offset + cursor, ino: segment.ino });
        if (entry.kind === "record") records++;
      }
      if (more) break;
      const tail = chunk.length - cursor, atEnd = offset + chunk.length >= segment.size;
      // What follows the last newline: longer than any line, or the unfinished
      // end of a closed segment, is skipped and counted. The unfinished end of
      // an open segment waits for its writer; a line cut by the read budget
      // waits for the next tick.
      if (tail >= CURSOR_HOOK_LIMITS.lineBytes || (tail > 0 && atEnd && this.closed(segment, now))) {
        entries.push({ kind: "malformed", segment: segment.name, end: offset + chunk.length, ino: segment.ino });
      }
      if (!atEnd) {
        more = true;
        break;
      }
    }
    return { entries, more };
  }

  /** Walk the window up to `limit`, building the envelope and the state its
   *  answer would commit. Stops early where the envelope is full. */
  private stage(entries: Entry[], limit: number): { logs: ImportLog[]; advance: CursorAdvance } {
    const { limits } = this, context = new CursorContext(this.checkpoint.conversations, limits);
    const offsets = { ...this.checkpoint.offsets }, inodes = { ...this.checkpoint.inodes };
    const counts = { spooled: 0, malformed: 0, expired: 0 }, logs: ImportLog[] = [];
    let bytes = this.envelopeBase;
    const ahead = function* (from: number): Generator<CursorSpoolLine> {
      for (let index = from; index < entries.length; index++) {
        const entry = entries[index];
        if (entry.kind === "record") yield entry.line;
      }
    };
    for (let index = 0; index < limit; index++) {
      const entry = entries[index];
      if (entry.kind === "record" && UPLOADED.has(entry.line.hook)) {
        if (logs.length >= limits.envelopeRecords) break;
        const attached = context.attach(entry.line, ahead(index + 1));
        const log = frameCursorRecord(entry.line, this.options.policy, attached.context);
        const size = log ? cursorRecordBytes(log) : 0;
        if (bytes + size > limits.frameBytes) break;
        attached.settle();
        context.observe(entry.line);
        if (log) {
          logs.push(log);
          bytes += size;
          counts.spooled++;
        } else counts.malformed++;
      } else if (entry.kind === "record") {
        context.observe(entry.line);
        counts.spooled++;
      } else if (entry.kind !== "blank") counts[entry.kind]++;
      offsets[entry.segment] = entry.end;
      inodes[entry.segment] = entry.ino;
    }
    return { logs, advance: { offsets, inodes, conversations: context.snapshot(), counts } };
  }

  /** Read the spool and either frame an envelope, commit a stretch that holds
   *  nothing to upload, or leave everything for a later tick. */
  private async collect(segments: Segment[], now: number, immediate: boolean): Promise<void> {
    const { limits } = this, { entries, more } = await this.readWindow(segments, now);
    if (!entries.length) return;
    // Consumption ends before the first record that has not settled.
    const before = (latest: number): number => {
      const index = entries.findIndex(entry => entry.kind === "record" && entry.timeMs > latest);
      return index < 0 ? entries.length : index;
    };
    const settled = immediate ? Infinity : now - limits.settleMs;
    let limit = before(settled);
    if (more) {
      // The window ends where the read bound did. Its last moments may have
      // companions that were not read, so they wait too, unless nothing else
      // in the window could move.
      let last: RecordEntry | undefined;
      for (let index = entries.length - 1; index >= 0 && !last; index--) {
        const entry = entries[index];
        if (entry.kind === "record" && Number.isFinite(entry.timeMs)) last = entry;
      }
      const held = last ? before(Math.min(settled, last.timeMs - limits.settleMs)) : limit;
      if (entries.slice(0, held).some(isRecordEntry)) limit = held;
    }
    const uploads = entries.slice(0, limit).filter(isUpload);
    if (uploads.length) {
      const oldest = uploads.reduce((least, entry) => Math.min(least, entry.timeMs), Infinity);
      if (!immediate && uploads.length < limits.lingerRecords && now - oldest < limits.lingerMs) return;
      if (now < this.nextPostAt) return;
    }
    if (!limit) return;
    const { logs, advance } = this.stage(entries, limit);
    if (!logs.length) {
      await this.commit(advance);
      return;
    }
    const body = cursorEnvelope(logs, this.options.connectVersion);
    if (Buffer.byteLength(body) > limits.frameBytes) throw new Error("Cursor envelope exceeds its bound");
    this.pending = { version: 1, id: randomUUID(), body, digest: digest(body), records: logs.length, destinationHash: this.options.destinationHash,
      policy: { ...this.options.policy }, createdAt: now, attempts: 0, lastAttemptAt: 0, nextAttemptAt: now, streak: 0, rejections: 0, advance };
    await this.deliver(now);
  }

  /** Give up the framing in flight; its records are framed again from the spool. */
  private async reframe(pending: CursorPending): Promise<void> {
    await this.commit(undefined, { reframed: 1, requests: pending.attempts }, { lastPostAt: Math.max(this.checkpoint.lastPostAt ?? 0, pending.lastAttemptAt) });
    await remove(this.files.pending);
    this.pending = null;
  }

  /** One request for the envelope in flight, if one may start now. The attempt
   *  is on disk before the request leaves, so a crash at any point resends the
   *  same bytes under the same key. */
  private async deliver(now: number): Promise<void> {
    const { limits } = this, pending = this.pending!;
    if (now - pending.createdAt >= limits.reframeMs) {
      // Past this age the service may have forgotten the key.
      if (pending.advance) return this.reframe(pending);
      this.rekey(pending, now);
    }
    // A clock set back must not stretch a wait.
    pending.nextAttemptAt = Math.min(pending.nextAttemptAt, now + limits.maxWaitMs);
    if (now < Math.max(pending.nextAttemptAt, this.nextPostAt)) return;
    const gap = this.gap();
    pending.attempts++;
    pending.lastAttemptAt = now;
    pending.nextAttemptAt = now + gap;
    await this.savePending();
    this.nextPostAt = now + gap;
    this.posts = [...this.posts.filter(at => now - at < 60_000), now].slice(-8);
    let result: CollectorPostResult;
    try {
      result = await this.options.post(pending.body, pending.id);
    } catch {
      result = { outcome: "network", detail: "network", errorClass: "network" };
    }
    const family = (outcome: CollectorPostOutcome | undefined) => outcome === "network" ? "retry" : outcome;
    pending.streak = family(pending.lastOutcome) === family(result.outcome) ? pending.streak + 1 : 1;
    pending.lastOutcome = result.outcome;
    pending.lastDetail = result.detail;
    if (result.errorClass) pending.lastErrorClass = result.errorClass;
    else delete pending.lastErrorClass;
    this.last = { outcome: result.outcome, detail: result.detail, errorClass: result.errorClass ?? null };
    let wait: number;
    switch (result.outcome) {
      case "ok":
        await this.commit(pending.advance, { acknowledged: pending.records, requests: pending.attempts }, { lastEnvelope: pending.id, lastPostAt: now, lastAckAt: now });
        await remove(this.files.pending);
        this.pending = null;
        return;
      case "retry":
      case "network":
        wait = Math.max(result.retryAfterMs ?? 0, Math.min(limits.retryCapMs, 1000 * 2 ** Math.min(pending.streak, 20)));
        break;
      case "auth":
        wait = pending.streak === 1 ? limits.authRetryMs : limits.slowRetryMs;
        break;
      case "rejected":
        pending.rejections++;
        pending.rejectedSince ??= now;
        // An envelope back from quarantine has had its day already.
        if (pending.requeued !== undefined || now - pending.rejectedSince >= limits.quarantineMs) return this.setAside(pending, now);
        wait = limits.rejectedRetryMs[Math.min(pending.rejections, limits.rejectedRetryMs.length) - 1];
        break;
      default:
        // Out of credit, or a service that does not serve this format yet: the
        // records wait, however long it takes.
        wait = limits.slowRetryMs;
    }
    pending.nextAttemptAt = now + Math.min(Math.max(gap, wait), limits.maxWaitMs);
    await this.savePending();
  }

  /** Move a refused envelope to quarantine and let the queue move on. */
  private async setAside(pending: CursorPending, now: number): Promise<void> {
    const file = this.quarantinePath(pending.id);
    const envelope: Quarantined = { version: 1, id: pending.id, body: pending.body, digest: pending.digest, records: pending.records,
      destinationHash: pending.destinationHash, policy: pending.policy, createdAt: pending.createdAt, rejectedAt: now };
    await writeAtomicJson(file, envelope, this.limits.pendingBytes, LABEL);
    this.quarantine = [...this.quarantine.filter(item => item.id !== pending.id),
      { id: pending.id, bytes: (await fs.lstat(file)).size, records: pending.records, rejectedAt: now }];
    const lost = await this.pruneQuarantine();
    await this.commit(pending.advance, { rejected: pending.requeued === undefined ? pending.records : 0, lost, requests: pending.attempts },
      { lastEnvelope: pending.id, lastPostAt: now });
    await remove(this.files.pending);
    this.pending = null;
  }

  /** `cursor retry-rejected` left a marker. An envelope in flight is tried
   *  again now instead of waiting out its schedule; after it, the envelopes
   *  quarantined before the request are returned, oldest first, one at a time. */
  private async requeue(now: number): Promise<void> {
    const marker = path.join(this.options.stateDir, RETRY_MARKER);
    let request: unknown;
    try {
      request = await readBoundedJson(marker, 1024, LABEL);
    } catch {
      request = undefined;
    }
    if (request === null) return;
    const requestedAt = isRecord(request) && request.version === 1 && isCount(request.requestedAt) ? request.requestedAt : -1;
    if (this.pending) {
      if (this.retryRequest !== requestedAt) this.pending.nextAttemptAt = Math.min(this.pending.nextAttemptAt, now);
      this.retryRequest = requestedAt;
      return;
    }
    const next = this.quarantine.find(item => item.rejectedAt < requestedAt);
    if (!next) {
      // Nothing left to return. A marker that cannot be removed is asked again next tick.
      await fs.unlink(marker).catch(() => {});
      return;
    }
    const envelope = await this.readQuarantined(next.id);
    if (!envelope) return this.forget(next.id);
    // The original key while the service can still recognise it, a new one otherwise.
    const original = now - envelope.createdAt < this.limits.reframeMs && envelope.destinationHash === this.options.destinationHash;
    this.pending = { version: 1, id: original ? envelope.id : randomUUID(), body: envelope.body, digest: envelope.digest, records: envelope.records,
      destinationHash: this.options.destinationHash, policy: envelope.policy, createdAt: original ? envelope.createdAt : now,
      attempts: 0, lastAttemptAt: 0, nextAttemptAt: now, streak: 0, rejections: 0, requeued: next.id };
    // Setting it aside was the last thing committed under this key. It is in
    // flight again, and a restart must not take it for answered.
    if (this.checkpoint.lastEnvelope === this.pending.id) await this.commit(undefined, {}, { lastEnvelope: undefined });
    await this.savePending();
    await this.forget(next.id);
  }

  /** One pass. `immediate` frames what is on disk without waiting for records
   *  to settle or linger (`collect --once`, shutdown); the request gap and a
   *  retry's schedule still apply. */
  async tick(opts: { immediate?: boolean } = {}): Promise<CursorHealth> {
    if (!this.release) throw new Error("Cursor collector is not open");
    if (this.running) throw new Error("Cursor collector ticks must not overlap");
    this.running = true;
    try {
      const now = this.now();
      this.lastTickAt = now;
      this.nextPostAt = Math.min(this.nextPostAt, now + this.limits.postGapMs + this.limits.postJitterMs);
      let segments = await this.listSegments();
      await this.expire(segments, now);
      segments = await this.retire(segments, now);
      await this.requeue(now);
      if (this.pending) {
        await this.deliver(now);
        // Answered or given up: what it covered and has since passed the expiry age goes before anything is framed over it again.
        if (!this.pending) {
          await this.expire(segments, now);
          segments = await this.retire(segments, now);
        }
      }
      if (!this.pending) await this.collect(segments, now, opts.immediate === true);
      segments = await this.retire(segments, now);
      this.segmentsSeen = segments;
      try {
        const stat = await fs.lstat(this.files.dropped);
        this.hookDrops = stat.isFile() ? stat.size : 0;
      } catch {
        this.hookDrops = 0;
      }
      return this.snapshot();
    } finally {
      this.running = false;
    }
  }

  snapshot(): CursorHealth {
    const { totals, offsets } = this.checkpoint, pending = this.pending, now = this.lastTickAt;
    const backlogBytes = this.segmentsSeen.reduce((sum, segment) => sum + Math.max(0, segment.size - (offsets[segment.name] ?? 0)), 0);
    return {
      version: 1,
      status: pending ? "retrying" : backlogBytes ? "waiting" : "idle",
      lastTickAt: now,
      lastOutcome: this.last.outcome,
      lastDetail: this.last.detail,
      lastErrorClass: this.last.errorClass,
      lastAckAt: this.checkpoint.lastAckAt ?? null,
      nextAttemptAt: pending ? Math.max(pending.nextAttemptAt, this.nextPostAt) : null,
      pendingRecords: pending?.records ?? 0,
      recordsSpooled: totals.spooled,
      recordsAcknowledged: totals.acknowledged,
      recordsMalformed: totals.malformed,
      recordsExpired: totals.expired,
      recordsRejected: totals.rejected,
      recordsLost: totals.lost,
      envelopesReframed: totals.reframed,
      requests: totals.requests + (pending?.attempts ?? 0),
      requestsLastMinute: this.posts.filter(at => now - at < 60_000).length,
      rejectedBytes: this.quarantine.reduce((sum, item) => sum + item.bytes, 0),
      rejectedEnvelopes: this.quarantine.length,
      hookDrops: this.hookDrops,
      spoolBytes: this.segmentsSeen.reduce((sum, segment) => sum + segment.size, 0),
      spoolSegments: this.segmentsSeen.length,
      backlogBytes,
    };
  }
}

export type CursorRunOptions = {
  /** Aborted to stop: one last immediate pass, then the loop returns. */
  signal?: AbortSignal;
  /** A single immediate pass (`collect --once`). */
  once?: boolean;
  /** Asked before every pass, the last one included. False ends the loop
   *  without another pass: when the settings changed, the capture options this
   *  collector holds may be wider than the ones in force. */
  proceed?: () => boolean | Promise<boolean>;
  /** Called with the health after every pass. */
  report?: (health: CursorHealth) => void | Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** The collector's loop: a pass every tick until stopped. The caller opens and
 *  closes the collector. */
export async function runCursorCollector(collector: CursorCollector, opts: CursorRunOptions = {}): Promise<CursorHealth> {
  const sleep = opts.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }).catch(() => {}));
  while (true) {
    if (opts.proceed && !(await opts.proceed())) return collector.snapshot();
    const last = opts.once === true || opts.signal?.aborted === true;
    const health = await collector.tick({ immediate: last });
    await opts.report?.(health);
    if (last) return health;
    await sleep(CURSOR_LIMITS.tickMs, opts.signal);
  }
}

/** Ask the running collector to send every quarantined envelope again. No lock
 *  is taken: the collector acts on the marker at its next tick, or when it next
 *  starts. Returns how many envelopes are quarantined now. */
export async function requestCursorRetryRejected(stateDir: string, now: number = Date.now()): Promise<{ envelopes: number }> {
  let envelopes = 0;
  try {
    const directory = await fs.opendir(cursorStateFiles(stateDir).rejected, { bufferSize: 64 });
    try {
      for await (const entry of directory) {
        if (QUARANTINED.test(entry.name) && entry.isFile() && ++envelopes >= CURSOR_LIMITS.rejectedFiles) break;
      }
    } finally {
      await directory.close().catch(() => {});
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeAtomicJson(path.join(stateDir, RETRY_MARKER), { version: 1, requestedAt: now }, 1024, LABEL);
  return { envelopes };
}

export async function writeCursorHealth(stateDir: string, health: CursorHealth, service: { running: boolean; pid: number }): Promise<void> {
  await writeAtomicJson(cursorStateFiles(stateDir).health, { ...health, running: service.running, pid: service.pid }, CURSOR_LIMITS.healthBytes, LABEL);
}

/** The health file as a fixed set of counters and closed-set names, never an
 *  arbitrary document. Null when there is none or it cannot be read. */
export async function readCursorHealth(stateDir: string): Promise<CursorHealthFile | null> {
  let raw: unknown;
  try {
    raw = await readBoundedJson(cursorStateFiles(stateDir).health, CURSOR_LIMITS.healthBytes, LABEL);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== 1) return null;
  const count = (name: string): number => isCount(raw[name]) ? raw[name] : 0;
  const time = (name: string): number | null => isCount(raw[name]) ? raw[name] : null;
  const named = <T extends string>(name: string, allowed: readonly T[]): T | null => allowed.includes(raw[name] as T) ? raw[name] as T : null;
  return {
    version: 1,
    status: named("status", ["idle", "waiting", "retrying"] as const) ?? "idle",
    lastTickAt: count("lastTickAt"),
    lastOutcome: named("lastOutcome", OUTCOMES),
    lastDetail: named("lastDetail", DETAILS),
    lastErrorClass: named("lastErrorClass", ERROR_CLASSES),
    lastAckAt: time("lastAckAt"),
    nextAttemptAt: time("nextAttemptAt"),
    pendingRecords: count("pendingRecords"),
    recordsSpooled: count("recordsSpooled"),
    recordsAcknowledged: count("recordsAcknowledged"),
    recordsMalformed: count("recordsMalformed"),
    recordsExpired: count("recordsExpired"),
    recordsRejected: count("recordsRejected"),
    recordsLost: count("recordsLost"),
    envelopesReframed: count("envelopesReframed"),
    requests: count("requests"),
    requestsLastMinute: count("requestsLastMinute"),
    rejectedBytes: count("rejectedBytes"),
    rejectedEnvelopes: count("rejectedEnvelopes"),
    hookDrops: count("hookDrops"),
    spoolBytes: count("spoolBytes"),
    spoolSegments: count("spoolSegments"),
    backlogBytes: count("backlogBytes"),
    running: raw.running === true,
    pid: count("pid"),
  };
}
