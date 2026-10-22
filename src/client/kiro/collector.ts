import fs from "node:fs/promises";
import { constants, type Dir } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { NO_CONTENT, type ContentPolicy, type ImportLog } from "../import/model.ts";
import { toOtlpLogs } from "../import/otlpImport.ts";
import { applyKiroRecord, emptyRecordState, emptyRecordCounters, KIRO_LIMITS, KiroSourceConflictError } from "./records.ts";
import { cleanKiroState, claimKiroState, KIRO_SESSION_ID, KIRO_WORKSPACE, readBoundedJson, validateSession, writeAtomicJson, normalizeKiroCheckpoint,
  type KiroCheckpoint, type KiroPending, type KiroSessionCheckpoint } from "./state.ts";
import type { KiroPost } from "./transport.ts";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const RESOURCE = {"service.name": "kiro-cli"};
const SCOPE = {name: "codetelemetry-connect.kiro-source", version: "1"};
type Carry = {mtime:number; physical: string; readOffset: number; buffer: Buffer; skipping: boolean; initialSkip: boolean};
type Pending = KiroPending & {rootHash: string; destinationHash: string; policyHash: string; lastOutcome?: string};
export type KiroHealth = {version: 1; status: string; trackedSessions: number; parkedSessions: number; skippingOversizeSessions:number; cachedTailBytes:number; cachedTailSessions:number; carryEvictions: number; discoveryBacklog: number; backloggedSessions: number; unsupportedSessions: number;
  sourceConflicts: number; sourceErrors: number; ignoredRecords: number; malformedRecords: number; duplicateRecords: number; evictedCalls: number; missingCalls: number; unsupportedToolDetails: number; discoveryOverflow: number; oversizeRecords: number; readBytes: number;
  logsAcknowledged: number; requests: number; pending: boolean; lastTickAt: number};
export type KiroCollectorOptions = {sourceRoot: string; stateDir: string; destinationHash: string; post: KiroPost; policy?: ContentPolicy;
  now?: () => number; tickBudgetMs?: number; bootstrap?: "start" | "end"};

/** Fixed-depth discovery keeps directory cursors open across ticks. A huge
 * workspace gets one fair share beside other open workspace cursors. */
export class KiroDiscovery {
  overflow=0;
  root: Dir | null = null;
  workspaces = new Map<string, Dir>();
  nextPassAt = 0;
  cursor = 0;
  async scan(root: string, now: number, deadline: number, clock: () => number): Promise<{relative: string; id: string}[]> {
    const found: {relative: string; id: string}[] = [];
    if (!this.root && now >= this.nextPassAt) {
      try {this.root = await fs.opendir(root, {bufferSize: 16});}
      catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {this.nextPassAt = now + 5000; return found;} throw new Error("Kiro source discovery failed");}
    }
    let entries = 0;
    for (let i = 0; this.root && i < 16 && entries < KIRO_LIMITS.directoryEntriesPerTick && clock() < deadline; i++) {
      const entry = await this.root.read(); entries++;
      if (!entry) {await this.root.close(); this.root = null; this.nextPassAt = now + 2000; break;}
      if (entry.isDirectory() && KIRO_WORKSPACE.test(entry.name) && !this.workspaces.has(entry.name) && this.workspaces.size < KIRO_LIMITS.sessions) {
        this.workspaces.set(entry.name, await fs.opendir(path.join(root, entry.name), {bufferSize: 16}));
      } else if(entry.isDirectory() && KIRO_WORKSPACE.test(entry.name) && !this.workspaces.has(entry.name)) this.overflow++;
    }
    while (this.workspaces.size && entries < KIRO_LIMITS.directoryEntriesPerTick && clock() < deadline) {
      const names = [...this.workspaces.keys()];
      const name = names[this.cursor++ % names.length];
      const dir = this.workspaces.get(name)!;
      const entry = await dir.read(); entries++;
      if (!entry) {await dir.close(); this.workspaces.delete(name); continue;}
      if (entry.isDirectory() && KIRO_SESSION_ID.test(entry.name)) found.push({relative: `${name}/${entry.name}`, id: entry.name});
    }
    return found;
  }
  async close() {if (this.root) await this.root.close(); for (const dir of this.workspaces.values()) await dir.close(); this.workspaces.clear(); this.root = null;}
}

export class KiroCollector {
  private options: KiroCollectorOptions;
  private checkpoint!: KiroCheckpoint;
  private pending: Pending | null = null;
  private release: (() => Promise<void>) | null = null;
  private discovery = new KiroDiscovery();
  private carries = new Map<string, Carry>();
  private candidates: Array<{relative:string;id:string}> = [];
  private candidateCursor = 0;
  private capacityBlocked = false;
  private stateBytesBlocked = false;
  private running = false;
  private lastPostAt = -Infinity;
  private startedAt: number;
  private health: KiroHealth = {version: 1, status: "idle", trackedSessions: 0, parkedSessions: 0, skippingOversizeSessions:0, cachedTailBytes:0, cachedTailSessions:0, carryEvictions: 0, discoveryBacklog: 0, backloggedSessions: 0, unsupportedSessions: 0,
    sourceConflicts: 0, sourceErrors: 0, ignoredRecords: 0, malformedRecords: 0, duplicateRecords: 0, evictedCalls: 0, missingCalls: 0, unsupportedToolDetails: 0, discoveryOverflow: 0, oversizeRecords: 0, readBytes: 0, logsAcknowledged: 0,
    requests: 0, pending: false, lastTickAt: 0};
  readonly recordCounters = emptyRecordCounters();
  constructor(options: KiroCollectorOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.destinationHash)) throw new Error("Kiro destination fingerprint is required");
    const policy = options.policy ?? NO_CONTENT;
    if (typeof policy.prompts !== "boolean" || typeof policy.toolDetails !== "boolean") throw new Error("invalid Kiro content policy");
    this.options = {...options, policy: Object.freeze({...policy})};
    this.startedAt = (options.now ?? Date.now)();
  }
  private policyHash() {const policy = this.policy(); return digest(JSON.stringify([policy.prompts, policy.toolDetails]));}
  private now() {return (this.options.now ?? Date.now)();}
  private file(name: string) {return path.join(this.options.stateDir, name);}
  private policy() {return this.options.policy ?? NO_CONTENT;}
  private fits(checkpoint:KiroCheckpoint) {return Buffer.byteLength(JSON.stringify(checkpoint))+1<=KIRO_LIMITS.checkpointBytes;}
  private async save() {await writeAtomicJson(this.file("checkpoint.json"), this.checkpoint, KIRO_LIMITS.checkpointBytes);}
  async open(): Promise<void> {
    this.release = await claimKiroState(this.options.stateDir);
    try {
      const rootHash = digest(path.resolve(this.options.sourceRoot));
      this.checkpoint = normalizeKiroCheckpoint(await readBoundedJson(this.file("checkpoint.json"), KIRO_LIMITS.checkpointBytes),rootHash,this.options.destinationHash);
      const pending = await readBoundedJson(this.file("pending.json"), KIRO_LIMITS.spoolBytes) as Pending | null;
      if (pending) {
        if((pending.privacyVersion!==undefined && pending.privacyVersion!==2) ||
          (pending.privacyVersion!==2 && (this.policy().prompts || this.policy().toolDetails))) {
          throw new Error("Kiro pending content uses an older privacy contract; original retry bytes and offsets are preserved");
        }
        if (pending.version !== 1 || pending.rootHash !== rootHash || pending.destinationHash !== this.options.destinationHash || typeof pending.body !== "string" ||
          Buffer.byteLength(pending.body) > KIRO_LIMITS.envelopeBytes || pending.digest !== digest(pending.body) ||
          !/^[a-f0-9-]{36}$/.test(pending.id) || !Number.isSafeInteger(pending.createdAt) ||
          !Number.isSafeInteger(pending.attempts) || pending.attempts < 0 || pending.attempts > KIRO_LIMITS.maxAttempts ||
          !Number.isSafeInteger(pending.nextAttemptAt) || !Array.isArray(pending.updates) || pending.updates.length > KIRO_LIMITS.sessionsPerTick ||
          pending.policyHash !== this.policyHash()) throw new Error("invalid Kiro retry spool contract");
        pending.updates.forEach(validateSession);
        if (!pending.updates.length || new Set(pending.updates.map(update => update.id)).size !== pending.updates.length ||
          pending.updates.some(update => !this.checkpoint.sessions.some(session => session.id === update.id && session.relative === update.relative))) throw new Error("invalid Kiro spool source ownership");
        this.pending = pending;
      }
      await cleanKiroState(this.options.stateDir);
      if(this.fits(this.checkpoint)) await this.save();
      else {this.stateBytesBlocked=true;this.capacityBlocked=true;}
    } catch (error) {await this.close(); throw error;}
  }
  async close(): Promise<void> {
    await this.discovery.close(); this.carries.clear();
    if (this.release) {await this.release(); this.release = null;}
  }
  snapshot(): KiroHealth {return {...this.health};}
  private async metadata(session: KiroSessionCheckpoint): Promise<Record<string, unknown> | null> {
    const metadata = await readBoundedJson(path.join(this.options.sourceRoot, session.relative, "session.json"), 16 * 1024) as Record<string, unknown> | null;
    return metadata?.id === session.id && metadata.schemaVersion === "1.0.0" && metadata.dataModelVersion === 1 ? metadata : null;
  }
  /** Keep a bounded RAM-only LRU of unread tails, avoiding repeated disk reads
   * when a backfill yields its parser slot. Uncommitted tails are never persisted. */
  private keepCarry(id:string,carry:Carry) {
    carry.buffer=Buffer.from(carry.buffer);
    this.carries.delete(id);this.carries.set(id,carry);
    let bytes=[...this.carries.values()].reduce((n,row)=>n+row.buffer.length,0);
    const active=new Set(this.checkpoint.sessions.map(row=>row.id));
    while(this.carries.size>KIRO_LIMITS.carrySessions || bytes>KIRO_LIMITS.carryBytes) {
      const key=[...this.carries.keys()].find(key=>!active.has(key))??this.carries.keys().next().value!;
      bytes-=this.carries.get(key)!.buffer.length;this.carries.delete(key);this.health.carryEvictions++;
    }
  }
  /** At most two 64-byte anchors and one stat per probe; never read a transcript
   * body just to decide whether its dormant cursor has more work. */
  private async observe(session: KiroSessionCheckpoint) {
    const file=await fs.open(path.join(this.options.sourceRoot,session.relative,"messages.jsonl"),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const stat=await file.stat();
      if(!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error("invalid Kiro source file");
      const physical=`${stat.dev}:${stat.ino}`;
      const tail=Buffer.alloc(Math.min(64,stat.size));
      if(tail.length && (await file.read(tail,0,tail.length,stat.size-tail.length)).bytesRead!==tail.length) throw new Error("Kiro source changed during probe");
      let prefix=true;
      if(session.offset>0 && session.anchor && stat.size>=session.offset) {
        const anchor=session.offset===stat.size?tail:Buffer.alloc(Math.min(64,session.offset));
        if(session.offset!==stat.size && (await file.read(anchor,0,anchor.length,session.offset-anchor.length)).bytesRead!==anchor.length) prefix=false;
        if(digest(anchor.toString("base64"))!==session.anchor) prefix=false;
      }
      return {physical,size:stat.size,mtime:stat.mtimeMs,anchor:tail.length?digest(tail.toString("base64")):undefined,last:tail.at(-1),samePrefix:physical===session.physical && stat.size>=session.offset && prefix};
    } finally {await file.close();}
  }
  /** Yield acknowledged parser quanta, including caught-up partial frames. Any
   * unread bytes are reread from the committed offset; pending call pairs survive.
   * A larger incomplete frame stays active until its bounded read reaches EOF. */
  private async rotateSessions(deadline:number):Promise<boolean> {
    const snapshot=this.checkpoint.sessions.slice(); let changed=false;
    for(let i=0;i<Math.min(snapshot.length,KIRO_LIMITS.sessionsPerTick) && this.now()<deadline;i++) {
      const session=snapshot[this.checkpoint.retirementCursor++%snapshot.length];
      const carry=this.carries.get(session.id);
      let observation:Awaited<ReturnType<KiroCollector["observe"]>>|undefined;
      try {observation=await this.observe(session);} catch {if(!session.blocked) continue;}
      const partialEnd=!!observation && !!carry && carry.readOffset===observation.size && carry.buffer.indexOf(10)<0;
      const progressed=session.offset>(session.activationOffset??session.offset);
      if(!session.blocked && (!observation?.samePrefix || !(progressed || session.offset===observation.size || partialEnd))) continue;
      const parked:KiroSessionCheckpoint={...session,records:{seen:session.records.seen.slice(-KIRO_LIMITS.parkedReplayEntries),calls:session.records.calls.slice()},
        ...(observation?{observedSize:observation.size,observedMtimeMs:observation.mtime,awaitingMore:session.offset===observation.size || partialEnd}:{}),
        ...(carry?.skipping?{skipInitialLine:true,...(!carry.initialSkip?{skippingOversize:true as const}:{})}:{})};
      delete parked.activationOffset;
      this.checkpoint.sessions=this.checkpoint.sessions.filter(row=>row.id!==session.id);
      this.checkpoint.parked.push(parked);
      if(!session.blocked && carry && (carry.buffer.length || carry.skipping)) this.keepCarry(session.id,carry);else this.carries.delete(session.id);
      changed=true;
    }
    this.checkpoint.retirementCursor%=Math.max(1,this.checkpoint.sessions.length);
    return changed;
  }
  private async admitCandidates(deadline:number):Promise<boolean> {
    let changed=false,checked=0;
    const known=new Map([...this.checkpoint.sessions,...this.checkpoint.parked].map(row=>[row.id,row]));
    while(this.candidateCursor<this.candidates.length && checked++<KIRO_LIMITS.candidateChecksPerTick && this.now()<deadline) {
      const candidate=this.candidates[this.candidateCursor];
      const existing=known.get(candidate.id);
      if(existing) {
        if(existing.relative!==candidate.relative) {existing.blocked="source_conflict";changed=true;this.candidateCursor++;continue;}
        if(this.checkpoint.sessions.includes(existing) || existing.blocked==="source_conflict") {this.candidateCursor++;continue;}
        let activate=!!existing.blocked;
        try {
          const stat=await this.observe(existing);
          activate ||= !stat.samePrefix || stat.size!==existing.observedSize || stat.mtime!==existing.observedMtimeMs || (!existing.awaitingMore && stat.size>existing.offset);
        } catch {this.candidateCursor++;continue;}
        if(activate) {
          if(this.checkpoint.sessions.length>=KIRO_LIMITS.sessions) break;
          this.checkpoint.parked=this.checkpoint.parked.filter(row=>row.id!==existing.id);
          const promoted={...existing,activationOffset:existing.offset};
          this.checkpoint.sessions.push(promoted);known.set(promoted.id,promoted);changed=true;
        }
        this.candidateCursor++;continue;
      }
      if(known.size>=KIRO_LIMITS.registeredSessions) {this.capacityBlocked=true;this.health.discoveryOverflow++;this.candidateCursor++;continue;}
      const initial:KiroSessionCheckpoint={...candidate,physical:"",offset:0,activationOffset:0,records:emptyRecordState()};
      // Historical new-activity baselines do not consume a parser slot. The
      // existing contract starts that session at its first discovered EOF.
      if(this.options.bootstrap==="end") {
        try {
          const metadata=await this.metadata(initial);
          if(!metadata) initial.blocked="unsupported_schema";
          else {
            const createdAt=typeof metadata.createdAt==="string"?Date.parse(metadata.createdAt):NaN;
            if(!Number.isFinite(createdAt)) initial.blocked="source_error";
            else if(createdAt<this.startedAt) {
              const stat=await this.observe(initial);
              Object.assign(initial,{physical:stat.physical,offset:stat.size,generation:1,observedSize:stat.size,observedMtimeMs:stat.mtime,awaitingMore:true,...(stat.anchor?{anchor:stat.anchor}:{}),...(stat.size && stat.last!==10?{skipInitialLine:true}:{})});
              delete initial.activationOffset;
              this.checkpoint.parked.push(initial);known.set(initial.id,initial);changed=true;this.candidateCursor++;continue;
            }
          }
        } catch {initial.blocked="source_error";}
        if(initial.blocked) {delete initial.activationOffset;this.checkpoint.parked.push(initial);known.set(initial.id,initial);changed=true;this.candidateCursor++;continue;}
      }
      if(this.checkpoint.sessions.length>=KIRO_LIMITS.sessions) break;
      this.checkpoint.sessions.push(initial);known.set(initial.id,initial);changed=true;this.candidateCursor++;
    }
    return changed;
  }
  private async flush(): Promise<void> {
    const pending = this.pending!;
    const now = this.now();
    // A durable acknowledgment remains valid even after the retry horizon.
    if (pending.updates.every(update => this.checkpoint.sessions.some(session => session.id === update.id && session.physical === update.physical && (session.generation ?? 0) === (update.generation ?? 0) && session.offset >= update.offset))) {
      await fs.unlink(this.file("pending.json")); this.pending = null; this.health.status = "idle"; return;
    }
    if (now - pending.createdAt >= KIRO_LIMITS.retryHorizonMs || pending.attempts >= KIRO_LIMITS.maxAttempts) {this.health.status = "retry_horizon_exhausted"; return;}
    if (now < pending.createdAt) {this.health.status = "clock_rollback"; return;}
    if (now < pending.nextAttemptAt || now - this.lastPostAt < KIRO_LIMITS.requestGapMs) {this.health.status = pending.lastOutcome ?? "pending"; return;}
    const sessions = new Map(this.checkpoint.sessions.map(session => [session.id, session]));
    pending.updates.forEach(update => sessions.set(update.id, {...update,activationOffset:update.activationOffset??sessions.get(update.id)?.activationOffset??update.offset}));
    const committed = {...this.checkpoint, sessions: [...sessions.values()]};
    if(!this.fits(committed)) {this.stateBytesBlocked=true;this.capacityBlocked=true;this.health.status="capacity";return;}
    this.lastPostAt = now; pending.attempts++; this.health.requests++;
    // Persist the attempt before network I/O so an ambiguous crash retains exact bytes/key.
    pending.nextAttemptAt = now + Math.min(60_000, KIRO_LIMITS.requestGapMs * 2 ** Math.min(6, pending.attempts - 1));
    await writeAtomicJson(this.file("pending.json"), pending, KIRO_LIMITS.spoolBytes);
    const outcome = await this.options.post(pending.body, pending.id);
    this.health.status = outcome; pending.lastOutcome = outcome;
    if (outcome !== "ok") {
      if (outcome === "rejected") pending.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      else if (outcome === "auth" || outcome === "budget") pending.nextAttemptAt = now + 60_000;
      await writeAtomicJson(this.file("pending.json"), pending, KIRO_LIMITS.spoolBytes);
      return;
    }
    await writeAtomicJson(this.file("checkpoint.json"), committed, KIRO_LIMITS.checkpointBytes);
    this.checkpoint = committed;
    const body = JSON.parse(pending.body);
    this.health.logsAcknowledged += body.resourceLogs[0].scopeLogs[0].logRecords.length;
    await fs.unlink(this.file("pending.json")); this.pending = null; this.health.status = "idle";
  }
  async tick(): Promise<KiroHealth> {
    if (!this.release) throw new Error("Kiro collector is not open");
    if (this.running) throw new Error("Kiro collector ticks must not overlap");
    this.running = true;
    try {
      this.health.lastTickAt = this.now();
      if(this.stateBytesBlocked) return this.finish();
      if (this.pending) {await this.flush(); return this.finish();}
      const deadline = this.now() + Math.min(2000, this.options.tickBudgetMs ?? 500);
      let changed = await this.rotateSessions(deadline);
      if(this.candidateCursor>=this.candidates.length) {
        const overflow=this.discovery.overflow;
        this.candidates=await this.discovery.scan(this.options.sourceRoot,this.now(),Math.min(deadline,this.now()+100),()=>this.now()); this.candidateCursor=0;
        if(this.discovery.overflow>overflow) {this.health.discoveryOverflow+=this.discovery.overflow-overflow;this.capacityBlocked=true;}
      }
      changed = await this.admitCandidates(deadline) || changed;
      const logs: ImportLog[] = [], updates: KiroSessionCheckpoint[] = [];
      let encodedBytes = 4096, sourceRecords = 0;
      const total = this.checkpoint.sessions.length;
      const selected = Math.min(total, KIRO_LIMITS.sessionsPerTick);
      for (let i = 0; i < selected && this.now() < deadline && sourceRecords < KIRO_LIMITS.recordsPerTick; i++) {
        const original = this.checkpoint.sessions[this.checkpoint.cursor % total];
        this.checkpoint.cursor = (this.checkpoint.cursor + 1) % Math.max(total, 1);
        if (original.blocked === "source_conflict") continue;
        const staged = structuredClone(original);
        const logsBefore = logs.length;
        try {
          const metadata = await this.metadata(staged);
          if (!metadata) {original.blocked = "unsupported_schema"; changed = true; continue;}
          delete staged.blocked;
          const file = await fs.open(path.join(this.options.sourceRoot, staged.relative, "messages.jsonl"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = await file.stat();
            if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error("invalid Kiro source file");
            const physical = `${stat.dev}:${stat.ino}`;
            staged.observedSize=stat.size; staged.observedMtimeMs=stat.mtimeMs; delete staged.awaitingMore;
            const createdAt = typeof metadata.createdAt === "string" ? Date.parse(metadata.createdAt) : NaN;
            const bootstrapEnd = !staged.physical && this.options.bootstrap === "end";
            if (bootstrapEnd && !Number.isFinite(createdAt)) throw new Error("Kiro source creation time is unavailable");
            let rewritten = false;
            if (staged.offset > 0 && staged.anchor && stat.size >= staged.offset) {
              const anchor = Buffer.alloc(Math.min(64, staged.offset));
              const {bytesRead} = await file.read(anchor, 0, anchor.length, staged.offset - anchor.length);
              rewritten = bytesRead !== anchor.length || digest(anchor.toString("base64")) !== staged.anchor;
            }
            if (staged.physical !== physical || stat.size < staged.offset || rewritten) {
              staged.physical = physical; staged.offset = 0; staged.generation = (staged.generation ?? 0) + 1;
              delete staged.anchor; delete staged.skipInitialLine; delete staged.skippingOversize; this.carries.delete(staged.id);
            }
            if (bootstrapEnd && createdAt < this.startedAt) {
              staged.offset = stat.size;
              if (stat.size > 0) {
                const last = Buffer.alloc(1);
                await file.read(last, 0, 1, stat.size - 1);
                if (last[0] !== 10) staged.skipInitialLine = true;
              }
            }
            let carry = this.carries.get(staged.id);
            if (!carry || carry.mtime !== stat.mtimeMs || carry.physical !== physical || carry.readOffset > stat.size) carry = {mtime:stat.mtimeMs,physical, readOffset: staged.offset, buffer: Buffer.alloc(0), skipping: staged.skipInitialLine === true, initialSkip: staged.skipInitialLine === true && !staged.skippingOversize};
            const chunk = Buffer.alloc(carry.buffer.indexOf(10) >= 0 ? 0 : Math.min(KIRO_LIMITS.readBytesPerSession, Math.max(0, stat.size - carry.readOffset)));
            const {bytesRead} = chunk.length ? await file.read(chunk, 0, chunk.length, carry.readOffset) : {bytesRead: 0};
            this.health.readBytes += bytesRead;
            const startOffset = carry.readOffset - carry.buffer.length;
            carry.readOffset += bytesRead;
            const buffer = Buffer.concat([carry.buffer, chunk.subarray(0, bytesRead)]);
            let cursor = 0, perSession = 0;
            while (cursor < buffer.length && perSession < 128 && sourceRecords < KIRO_LIMITS.recordsPerTick && this.now() < deadline) {
              const newline = buffer.indexOf(10, cursor);
              if (newline < 0) break;
              if (carry.skipping || newline - cursor > KIRO_LIMITS.recordBytes) {
                if (!carry.initialSkip) this.health.oversizeRecords++;
                carry.skipping = false; carry.initialSkip = false; delete staged.skipInitialLine; delete staged.skippingOversize;
              }
              else {
                const before = {seen: staged.records.seen.slice(), calls: staged.records.calls.slice()};
                const counters = {...this.recordCounters};
                const emitted = applyKiroRecord(staged.records, buffer.subarray(cursor, newline), staged.id, this.policy(), this.recordCounters);
                const bytes = emitted.reduce((sum, log) => sum + Buffer.byteLength(JSON.stringify(toOtlpLogs([log], {}, SCOPE))), 0);
                if (logs.length + emitted.length > KIRO_LIMITS.logsPerBatch || encodedBytes + bytes > KIRO_LIMITS.envelopeBytes) {
                  staged.records = before; Object.assign(this.recordCounters, counters); break;
                }
                logs.push(...emitted); encodedBytes += bytes;
              }
              cursor = newline + 1; staged.offset = startOffset + cursor; perSession++; sourceRecords++;
            }
            carry.buffer = buffer.subarray(cursor);
            if (carry.buffer.indexOf(10)<0 && (carry.skipping || carry.buffer.length>KIRO_LIMITS.recordBytes)) {
              carry.buffer=Buffer.alloc(0);carry.skipping=true;
              // This frame is already excluded by the record bound. Commit its
              // discarded prefix with the skip marker so it can yield before EOF.
              staged.offset=carry.readOffset;staged.skipInitialLine=true;
              if(!carry.initialSkip) staged.skippingOversize=true;
            }
            this.keepCarry(staged.id, carry);
            if (staged.offset > 0) {
              const anchor = Buffer.alloc(Math.min(64, staged.offset));
              const {bytesRead} = await file.read(anchor, 0, anchor.length, staged.offset - anchor.length);
              if (bytesRead !== anchor.length) throw new Error("Kiro source changed during read");
              staged.anchor = digest(anchor.toString("base64"));
            }
            if (staged.offset !== original.offset || staged.physical !== original.physical || staged.observedSize !== original.observedSize || staged.observedMtimeMs !== original.observedMtimeMs || original.blocked) updates.push(staged);
          } finally {await file.close();}
        } catch (error) {
          const blocked = error instanceof KiroSourceConflictError ? "source_conflict" : "source_error";
          original.blocked = blocked; staged.blocked = blocked;
          if (logs.length > logsBefore || staged.offset > original.offset) {
            const prior = updates.findIndex(update => update.id === staged.id);
            if (prior >= 0) updates[prior] = staged; else updates.push(staged);
          }
          changed = true; this.carries.delete(original.id);
        }
      }
      // Reserve the eventual acknowledged checkpoint before sending anything.
      // A byte-capacity stop keeps prior disk offsets and uncertain retry bytes.
      const prospective=new Map(this.checkpoint.sessions.map(session=>[session.id,session]));
      updates.forEach(update=>prospective.set(update.id,update));
      if(!this.fits(this.checkpoint) || !this.fits({...this.checkpoint,sessions:[...prospective.values()]})) {
        this.stateBytesBlocked=true;this.capacityBlocked=true;this.carries.clear();return this.finish();
      }
      if (logs.length) {
        const body = JSON.stringify(toOtlpLogs(logs, RESOURCE, SCOPE));
        if (Buffer.byteLength(body) > KIRO_LIMITS.envelopeBytes) throw new Error("Kiro encoded envelope exceeds bound");
        this.pending = {version: 1, privacyVersion: 2, rootHash: this.checkpoint.rootHash, destinationHash: this.options.destinationHash, policyHash: this.policyHash(), id: randomUUID(),
          body, digest: digest(body), createdAt: this.now(), attempts: 0, nextAttemptAt: this.now(), updates};
        // Publish discovery/ownership first, without moving any source offsets.
        await this.save();
        await writeAtomicJson(this.file("pending.json"), this.pending, KIRO_LIMITS.spoolBytes);
        this.health.status = "pending";
      } else {
        const sessions = new Map(this.checkpoint.sessions.map(session => [session.id, session]));
        updates.forEach(update => sessions.set(update.id, update));
        this.checkpoint.sessions = [...sessions.values()];
        if (changed || updates.length) await this.save();
        this.health.status = "idle";
      }
      return this.finish();
    } finally {this.running = false;}
  }
  private finish(): KiroHealth {
    this.health.pending = this.pending !== null;
    this.health.trackedSessions = this.checkpoint.sessions.length;
    this.health.parkedSessions = this.checkpoint.parked.length;
    this.health.cachedTailSessions=this.carries.size;
    this.health.cachedTailBytes=[...this.carries.values()].reduce((n,row)=>n+row.buffer.length,0);
    this.health.discoveryBacklog = this.candidates.length-this.candidateCursor;
    const known=[...this.checkpoint.sessions,...this.checkpoint.parked];
    this.health.skippingOversizeSessions=known.filter(row=>row.skippingOversize).length;
    this.health.backloggedSessions=known.filter(row=>row.observedSize!==undefined && row.observedSize>row.offset && !row.awaitingMore).length;
    if(this.stateBytesBlocked || (this.capacityBlocked && !this.pending)) this.health.status="capacity";
    this.health.unsupportedSessions = known.filter(session => session.blocked === "unsupported_schema").length;
    this.health.sourceConflicts = known.filter(session => session.blocked === "source_conflict").length;
    this.health.sourceErrors = known.filter(session => session.blocked === "source_error").length;
    this.health.ignoredRecords = this.recordCounters.unknown;
    this.health.malformedRecords = this.recordCounters.malformed;
    this.health.duplicateRecords = this.recordCounters.duplicates;
    this.health.evictedCalls = this.recordCounters.callsEvicted;
    this.health.missingCalls = this.recordCounters.missingCalls;
    this.health.unsupportedToolDetails = this.recordCounters.unsupportedDetails;
    return this.snapshot();
  }
}
