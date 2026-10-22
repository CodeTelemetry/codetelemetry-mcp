// Client for the agent read tools (MCP use-cases plan). Authenticated by the
// ingest key — the same pattern as the connectivity check. The key is sent only
// as a Bearer header; callers (the MCP server) keep the plaintext out of the
// model's context and surface only the returned scalars.
import type { FetchLike } from "./otlp.ts";
import { assertKey } from "./keys.ts";

export type CostSignal = {
  windowDays: number;
  observedCostUsd: number;
  feeUsd: number;
  byModel: { model: string; observedCostUsd: number }[];
  topRepo: string | null;
  asOf: string | null;
  note: string;
};

export type CostSignalResult = { ok: boolean; cost: CostSignal | null; httpStatus: number };

export type AgentReadPerformance = {
  totalMs: number;
  queryMs: number;
  queryCount: number;
  readRows: number;
  readBytes: number;
  resultBytes: number;
  targetMs: number;
  meetsTarget: boolean;
  phases: {
    phase: string;
    queryId: string;
    durationMs: number;
    readRows?: number;
    readBytes?: number;
    resultBytes: number;
  }[];
  /** Which cache decision served this read (ELL-51): `hit`, `coalesced` (joined a
   *  load already in flight — no queries of its own, but it waited for a cold
   *  read), `miss`, `disabled`, or `bypass`. Present only for reads that have a
   *  cache in front of them — today the sizing routes.
   *
   *  Deliberately `string` and not a union: this type is the WIRE contract, so a
   *  NEWER server must be able to report a status this client has never heard of
   *  without failing to parse. Optional for the mirror-image reason — an older
   *  server does not send it at all. */
  cache?: string;
  /** The documented budget for a read that had to go to ClickHouse, and whether
   *  this one met it. `targetMs`/`meetsTarget` remain the interactive SLO on
   *  every request, warm or cold. */
  coldTargetMs?: number;
  meetsColdTarget?: boolean;
};

export type SessionPerformanceReport = {
  sessionId: string;
  present: boolean;
  sessionCount: number;
  eventCount: number;
  returnedEvents: number;
  turnCount: number;
  targetsMs: { fresh: number; cacheHit: number };
  samples: {
    mode: "fresh" | "dashboard-cache";
    cache: "hit" | "miss" | "disabled" | "bypass";
    performance: AgentReadPerformance;
  }[];
};

export type SimilarSessionErrorsReport = {
  sessionId: string;
  lookbackDays: number;
  targetFailures: number;
  targetSignatures: {
    signature: string;
    tool: string;
    category: string;
    occurrences: number;
    lastSeen: string;
  }[];
  targetSignaturesTruncated: boolean;
  matches: {
    sessionId: string;
    lastSeen: string;
    matchingFailures: number;
    exactSignatureMatches: number;
    familySignatureMatches: number;
    similarityPct: number;
    tools: string[];
    categories: string[];
  }[];
};

export type SessionPerformanceResult = {
  ok: boolean;
  report: SessionPerformanceReport | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

export type SessionSearchHit = {
  sessionId: string;
  /** Canonical Session Timeline link, when the server has a configured origin (ELL-231). */
  sessionUrl?: string;
  title: string;
  titleIsId: boolean;
  sessionName?: string;
  delegation?: { parentSessionId: string; parentSessionUrl?: string; at: string; source: "codex.agent_communication"; taskName?: string; taskNameSource?: "parent_spawn_agent" };
  repo: string;
  repoInferred?: boolean;
  user?: string;
  sourceService: string;
  models: string[];
  lastSeen: string | null;
  durationMs: number;
  /** Absent when this source did not measure billed tokens. */
  totalTokens?: number;
  /** Absent when this source did not measure USD cost. */
  costUsd?: number;
  prompts: number;
  /** Absent when this source did not measure model requests. */
  invocations?: number;
  tools: number;
  /** The session's output as the Sessions list shows it, where measured
   *  (ELL-277): Claude Code's own counters, or counts parsed from a Codex
   *  session's tool calls (lower bounds). Absent: unmeasured. */
  linesAdded?: number;
  linesRemoved?: number;
  commits?: number;
  pullRequests?: number;
  costPerCommit?: number;
  zeroOutput?: true;
  outcomeSource?: "claude_code_metrics" | "tool_event_parse";
  /** Evidence class (ELL-232): observed agent work, instrumentation only, or
   *  too little telemetry to tell. Never a success or failure verdict. */
  activity?: "substantive" | "instrumentation_only" | "insufficient_evidence";
  match?: { fields: string[] };
  measurements?: {
    version: 1;
    tokens: "measured" | "unmeasured" | "unavailable" | "conflict";
    usd: "measured" | "unmeasured" | "unavailable" | "conflict";
    modelCalls: "measured" | "unmeasured" | "unavailable" | "conflict";
    apiLatency: "measured" | "unmeasured" | "unavailable" | "conflict";
    toolDuration: "measured" | "unmeasured" | "unavailable" | "conflict";
    providerCredits: "measured" | "unmeasured" | "unavailable" | "conflict";
    reportedTurnElapsed: "measured" | "unmeasured" | "unavailable" | "conflict";
    turnCompletion?: "measured" | "unmeasured" | "unavailable" | "conflict";
  };
  providerUsageWindow?: {from: string; through: string; basis: "retained_provider_turns"};
  turnCompletion?: {turns: number; completed: number; cancelled: number; errors: number; unknown: number; successfulCompleted: number; reportedStatusTurns: number};
  providerTurnCoverage?: {turnsWithoutUsage: number; turnsWithoutCompletion: number};
  providerUsage?: {
    provider: "kiro"; unit: "credit"; amount: number; turns: number;
    reportedTurnElapsedMs?: number; reportedTurnCount: number;
  };
};

export type SessionSearchLegacyReport = {
  telemetrySnapshot?: { materializedAt: string; dataThrough: string | null; eventContent: "separate_snapshot" };
  results: SessionSearchHit[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  query: Record<string, unknown>;
  /** Present for `activity: "substantive"`: records matching every other filter,
   *  by class, including the ones the narrowing left out. */
  activityCounts?: { substantive: number; instrumentationOnly: number; insufficientEvidence: number };
  repos: string[];
  promptSearchAvailable: boolean;
  promptSearchTruncated?: boolean;
  promptSearchThrough?: string | null;
  contentRedacted: true;
  truncated?: boolean;
};

export type SessionPrecedentReport = {
  precedents: {
    mode: "semantic" | "lexical";
    degraded: boolean;
    reason?: "embedding_unavailable" | "embedding_failed";
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    candidates: number;
    lookbackDays: number;
    hits: Array<{
      sessionId: string;
      service: string;
      /** Canonical Session Timeline link, when the server has a configured origin (ELL-231). */
      sessionUrl?: string;
      sourceGeneration: string;
      outcome: "success" | "partial" | "failed" | "unknown";
      complexity: "low" | "medium" | "high" | "unknown";
      semanticScore: number;
      lexicalScore: number;
      reasons: string[];
      interpretationReadiness: "ready" | "partial";
    }>;
  };
};

/** Discriminated by the presence of `precedents` versus `results`. Callers must
 * narrow the report before reading mode-specific fields. */
export type SessionSearchReport = SessionSearchLegacyReport | SessionPrecedentReport;

export type SessionSearchResult<TReport extends SessionSearchReport = SessionSearchLegacyReport> = {
  ok: boolean;
  report: TReport | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

/** A t-shirt estimate built from the caller's own historical sessions (ELL-8).
 *  The size, its token range, and the ladder confidence come from the shared
 *  sizing model; the matches and the prediction come from the caller's history. */
export type TaskSize = "XS" | "S" | "M" | "L" | "XL";

/** Linear's four estimate scales, by their settings-page names. */
export type LinearEstimateScale = "exponential" | "fibonacci" | "linear" | "tShirt";

/** A size projected onto a Linear team's estimate scale.
 *
 *  Mirrors the server's shape in full, deliberately: the numeric `value` alone
 *  is ambiguous across scales (a 5 means different work on fibonacci vs linear),
 *  and in the `issueKey` flow the SERVER picks the scale from the issue's team —
 *  so without `scale`/`extended` a caller cannot tell what it was given. */
export type LinearEstimateProjection = {
  scale: LinearEstimateScale;
  extended: boolean;
  /** The value to write to Linear's `estimate` field. */
  value: number;
  /** What the team sees: the number, or the size letter on a t-shirt-scale team. */
  label: string;
  size: TaskSize;
};

export type TaskEffortEstimate = {
  task: { text: string; source: "text" | "issue"; issueKey: string | null; terms: string[] };
  /** Stable id for this sizing request — the anchor a calibration task and any
   *  telemetry its work later produces link back to (ELL-15). */
  sizingRequestId: string;
  size: TaskSize | null;
  range: { minTokens: number; maxTokens: number | null } | null;
  sizeRange?: { min: TaskSize; max: TaskSize };
  tokens: { point: number; low: number; high: number };
  basis: "matched" | "corpus-median" | "none";
  /** How many historical units (sessions and/or segments) backed the prediction. */
  sampleCount: number;
  confidence: {
    band: "high" | "medium" | "low";
    ladder: "high" | "medium" | "low";
    similarity: number;
    evidence: number;
    corpus: number;
    agreement: number;
    /** The confidence derivation — the four weighted inputs and the sample-count
     *  cap — so a caller can explain why the band is what it is. */
    scoring: {
      inputs: { key: string; label: string; value: number; weight: number; detail: string }[];
      weightedScore: number;
      cap: number;
      capBand: "high" | "medium" | "low";
      capped: boolean;
      /** Why the cap bit, when it did: too few comparisons ("samples") or matched
       *  costs that contradict each other ("disagreement"). */
      capReason: "samples" | "disagreement" | null;
      score: number;
    };
    reasons: string[];
  };
  matches: {
    sessionId: string;
    /** Whether this nearest example is a whole session or a conceptual segment. */
    kind: "session" | "segment";
    /** For a segment match, the raw session it was inferred from. */
    sourceSessionId?: string;
    title: string;
    useCase: string;
    similarityPct: number;
    totalTokens: number;
    lastSeen: string;
  }[];
  model: { rulesVersion: string; cohortKey: string; cohortSampleSize: number; observationCount: number } | null;
  evidence: {
    lookbackDays: number;
    sessions: number;
    describedSessions: number;
    truncated?: boolean;
    /** The optional enrichment read failed, so NO session could be described.
     *  Distinct from a tenant that genuinely has no labels — without this a
     *  consumer cannot tell a degraded estimate from an honest empty one. */
    descriptionsUnavailable?: boolean;
    /** How many sessions were compared at the conceptual-segment level (ELL-10)
     *  rather than as one whole session. Absent when no segment source was used. */
    segmentedSessions?: number;
  };
  linearEstimate: LinearEstimateProjection | null;
  /** The Linear issue this estimate was built from, when it came from one — the
   *  only place the issue's BODY is carried. Null for a text-sourced estimate.
   *
   *  `description` is capped on the agent routes (see `descriptionTruncated`)
   *  because Linear does not bound it and a tool result is serialized twice into
   *  the caller's context. Treat it as a preview, not the canonical body: read
   *  the issue itself when `descriptionTruncated` is true. */
  issueSource: {
    connectionId: string;
    workspace: { id: string; name: string; urlKey: string };
    identifier: string;
    url: string;
    title: string;
    /** Capped at the route's agent budget. */
    description: string;
    /** Length of the FULL body, before capping. */
    descriptionChars: number;
    descriptionTruncated: boolean;
    labels: string[];
    project: { id: string; name: string } | null;
    team: { id: string; key: string; name: string } | null;
    /** The estimate already on the issue in Linear, or null when unestimated. */
    estimate: number | null;
  } | null;
  /** A small XS/S task to collect the evidence a low-confidence estimate is
   *  missing (ELL-15): a focused question, bounded steps, the evidence to gather,
   *  exit criteria, and how finishing it should move the estimate — plus a
   *  self-contained Markdown rendering for copy/export. Null when the estimate is
   *  confident, or when nothing the user could do would move the band. */
  calibrationTask: {
    kind: "spike" | "slice" | "instrument";
    size: "XS" | "S";
    title: string;
    question: string;
    targetSignal: "similarity" | "evidence" | "corpus" | "agreement" | "ladder";
    why: string;
    steps: string[];
    expectedEvidence: string;
    exitCriteria: string[];
    expectedImprovement: string;
    expectedTokens: number;
    sizingRequestId: string;
    markdown: string;
    /** Server-issued signature over {sizingRequestId, title, description=markdown,
     *  size}. Echo it back to the create endpoint so the server can confirm the
     *  task is the one it generated (title/body/size/id unaltered). */
    signature: string;
  } | null;
  /**
   * @deprecated Renamed to `calibrationTask` (ELL-15). The API still returns this
   * alias with the same value, so code reading `confidenceTask` keeps working
   * during the deprecation window; prefer `calibrationTask` in new code.
   */
  confidenceTask: TaskEffortEstimate["calibrationTask"];
};

export type TaskEffortResult = {
  ok: boolean;
  estimate: TaskEffortEstimate | null;
  performance: AgentReadPerformance | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

/** Which Linear issue an estimate was built from, echoed back so a caller can
 *  show a human what was sized and from where (ELL-44). Carries no credential
 *  material — a connection id names a stored connection, it does not open one.
 *
 *  Deliberately has NO `description`: the issue's body is unbounded, it already
 *  rides (capped) on `TaskEffortEstimate.issueSource`, and every tool result is
 *  serialized twice into the caller's context. This mirrors the wire payload
 *  field for field, so a consumer cannot compile a read of a field the server
 *  does not send. */
export type LinearIssueSource = {
  /** The reference AS SUBMITTED (URL or identifier), so the echo can be matched
   *  against what the user asked for. */
  reference: string;
  /** The CodeTelemetry connection the issue was ACTUALLY resolved through. */
  connectionId: string;
  /** The Linear workspace that connection points at. An identifier is only
   *  unique WITHIN a workspace, so this says which `ENG-1` was sized. */
  workspace: { id: string; name: string; urlKey: string };
  identifier: string;
  url: string;
  title: string;
  labels: string[];
  project: { id: string; name: string } | null;
  team: { id: string; key: string; name: string } | null;
  /** The estimate already on the issue in Linear, or null when unestimated. */
  estimate: number | null;
  /** The normalized text actually matched against history. */
  normalizedText: string;
};

/** One connection the caller may choose between when a reference could resolve
 *  through more than one connected workspace. Deliberately narrow: no account
 *  identity, no capability detail, never a credential. */
export type LinearConnectionChoice = {
  connectionId: string;
  workspace: { id: string; name: string; urlKey: string };
  isDefault: boolean;
  status: string;
};

export type LinearIssueEstimateResult = {
  ok: boolean;
  estimate: TaskEffortEstimate | null;
  source: LinearIssueSource | null;
  /** Present on an ambiguous/unmatched connection refusal: what to name next. */
  connections: LinearConnectionChoice[] | null;
  performance: AgentReadPerformance | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

export type SimilarSessionErrorsResult = {
  ok: boolean;
  report: SimilarSessionErrorsReport | null;
  performance: AgentReadPerformance | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

// ── Host health & capacity (ELL-19 read; the ELL-24 gate's only input) ────────
//
// These types MIRROR the wire, field for field. Nothing validates the payload at
// runtime, so they are the contract: a field declared here but never sent lets a
// caller compile a read of something the server does not produce. Authority is
// `packages/api/src/agent/hostHealth.ts`; the shapes below must not drift from
// it, and must never grow a field the read deliberately withholds (device names,
// mount points, interface names, process command lines, pids).

export type HostState = "healthy" | "degraded" | "stale" | "offline";

/** Soft/hard capacity limits and the freshness policy, as resolved by the
 *  server. Utilization keys are fractions in (0,1]; the two `*AfterSec` keys are
 *  positive integer seconds with `staleAfterSec < offlineAfterSec`. */
export type HostThresholds = {
  cpuSoft: number;
  cpuHard: number;
  memSoft: number;
  memHard: number;
  swapHard: number;
  fsSoft: number;
  fsHard: number;
  staleAfterSec: number;
  offlineAfterSec: number;
};

export type HostAgentdProcess = {
  detected: boolean;
  cpuUtil: number | null;
  memUtil: number | null;
  threads: number | null;
};

export type HostSignals = {
  cpuUtil: number | null;
  memUtil: number | null;
  swapUtil: number | null;
  fsUtil: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  uptimeSec: number | null;
  networkErrors: number | null;
  agentd: HostAgentdProcess;
  /** Which watched coding-agent executables are present — a presence list, not a
   *  count, and never a pid. */
  codingAgentsPresent: string[];
};

export type HostHeadroom = {
  cpu: number | null;
  memory: number | null;
  swap: number | null;
  filesystem: number | null;
  limitingFactor: string | null;
};

/** The server's stateless RECOMMENDATION for new work on this host. Enforcement
 *  (hysteresis, cooldown, override) is the gate's — see dispatchAdmission.ts. */
export type HostAdmission = {
  admit: boolean;
  reason: string;
  limitingFactor: string | null;
};

export type HostHealth = {
  /** `service.instance.id` — the join key the gate keys its state on. */
  instance: string;
  host: string | null;
  os: string | null;
  arch: string | null;
  environment: string | null;
  state: HostState;
  /** The release smoke's synthetic canary rather than a machine (ELL-49). Its
   *  `admission.admit` is always false server-side; a consumer must never treat it
   *  as capacity. Optional: a deployment older than ELL-49 does not send it, and
   *  its absence must NOT be read as "confirmed real" — see isCanaryInstance in
   *  the gate, which falls back to the reserved id prefix. */
  synthetic?: boolean;
  reasons: string[];
  warnings: string[];
  lastSeen: string | null;
  ageSeconds: number | null;
  signals: HostSignals;
  /** Per-signal observation time (ELL-49). `lastSeen` is the newest datapoint of
   *  ANY metric, so it stays fresh for a host whose capacity scrapers died while
   *  uptime kept reporting; this says which signal went quiet and when. Optional:
   *  a deployment older than ELL-49 does not send it. */
  signalObservedAt?: Record<string, { at: string; ageSeconds: number }>;
  headroom: HostHeadroom;
  admission: HostAdmission;
};

export type HostHealthReport = {
  /** When the SERVER produced this response. The anchor a replayed or cached
   *  body is aged against — it does not move when one is handed back again, and
   *  unlike `lastSeen + ageSeconds` it is exact: the read clamps `ageSeconds` at
   *  zero for a host inside its tolerated clock skew, so that derivation
   *  over-states freshness by as much as the clamp. */
  generatedAt: string;
  asOf: string | null;
  /** Bumped when the server's thresholds or classification change. Recorded on
   *  every gate decision so an admit/defer can be traced to its policy. */
  policyVersion: string;
  lookbackMinutes: number;
  windowMinutes: number;
  signalMaxAgeSec: number;
  thresholds: HostThresholds;
  /** Unit of each signal in `hosts[].signals`, as an OTel unit string (`1` for a
   *  dimensionless ratio, `s`, `{thread}`, …). Optional because a deployment
   *  older than ELL-49 does not send it; never inferred when absent. */
  signalUnits?: Record<string, string>;
  hosts: HostHealth[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    stale: number;
    offline: number;
    admittable: number;
    /** How many of `total` are synthetic canaries. Optional (pre-ELL-49). */
    synthetic?: number;
  };
};

/** Which hop lost the telemetry, as the server narrowed it (ELL-49). `stage` is a
 *  bare string, not a union: a client that rejected an unknown future stage would
 *  turn a richer diagnosis into a protocol fault. */
export type HostPipelineDiagnosis = {
  stage: string;
  detail: string;
  hostFeedLastSeen: string | null;
  hostFeedLastSeenAgeSec: number | null;
  otherFeedsLastSeen: string | null;
  otherFeedsLastSeenAgeSec: number | null;
  horizonDays: number | null;
};

export type HostHealthResult = {
  ok: boolean;
  /** `null` means NO KNOWN HOSTS — never "all healthy". A caller must not read
   *  absence as a green light. */
  report: HostHealthReport | null;
  /** The server's own name for the state it answered: `"ok"` or `"no_hosts"`.
   *  Null on a pre-ELL-49 deployment or a failed read — never inferred from
   *  `report === null`, since that is the conflation ELL-49 removed. */
  status: string | null;
  /** Where the telemetry was lost. Present on a 200 with no hosts AND on the 503
   *  pipeline-fault body, which is what makes an operator able to tell a broken
   *  collector from a broken deployment. */
  diagnosis: HostPipelineDiagnosis | null;
  /** Which BUILD answered, when the deployment reports one (ELL-49). Read from any
   *  status, including the 503 path: knowing which build was broken is worth more
   *  than only recording the builds that worked. Provenance only — never used as
   *  evidence — so an odd value degrades to null rather than failing the read. */
  serverVersion: string | null;
  /** Set when the read SUCCEEDED but its body was not a host-health response at
   *  all — invalid JSON, a 204, an envelope with no `report` member. That is a
   *  protocol, version or proxy fault, and collapsing it into `report: null`
   *  would have the gate report "no known hosts" and retry it forever. */
  reportUnusable: string | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

/** Read the server's hop diagnosis defensively. Every field is optional and
 *  independently checked: this is operator-facing text on an error path, so a
 *  partially-shaped body must degrade to nulls rather than throw inside the read
 *  a dispatcher depends on. */
function parseDiagnosis(raw: unknown): HostPipelineDiagnosis | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.stage !== "string" || !d.stage) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    stage: d.stage,
    detail: str(d.detail) ?? "",
    hostFeedLastSeen: str(d.hostFeedLastSeen),
    hostFeedLastSeenAgeSec: num(d.hostFeedLastSeenAgeSec),
    otherFeedsLastSeen: str(d.otherFeedsLastSeen),
    otherFeedsLastSeenAgeSec: num(d.otherFeedsLastSeenAgeSec),
    horizonDays: num(d.horizonDays),
  };
}

async function postAgent<T>(opts: {
  key: string;
  url: string;
  body: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  value: T | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
  /** The response arrived but its BODY did not — set only for a transport
   *  failure while reading it, never for a body that simply is not JSON. */
  bodyError: string | null;
}> {
  const key = assertKey(opts.key);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(opts.body),
        signal: ac.signal,
      });
    } catch (error) {
      if (!ac.signal.aborted) throw error;
      return {
        ok: false,
        value: null,
        httpStatus: 0,
        error: "read_timeout",
        message: "Telemetry read timed out before the server responded.",
        bodyError: null,
      };
    }
    let value: T | null = null;
    let error: string | null = null;
    let message: string | null = null;
    let bodyError: string | null = null;
    try {
      const decoded = await res.json() as T & { error?: unknown; message?: unknown };
      value = decoded;
      error = typeof decoded?.error === "string" ? decoded.error : null;
      message = typeof decoded?.message === "string" ? decoded.message : null;
    } catch (err) {
      // Error bodies are allowed to be non-JSON. The HTTP status remains useful.
      // But a body that never ARRIVED is a transport failure, not a shape
      // problem: headers can land and the stream then stall until the abort
      // fires. Reported separately, because a caller that cannot tell them apart
      // must either retry a protocol fault forever or escalate a timeout that
      // would have cleared on its own. A SyntaxError is the body's shape and
      // stays a shape problem.
      bodyError = err instanceof SyntaxError
        ? null
        : ac.signal.aborted ? "read_timeout" : "read_unavailable";
    }
    return {
      bodyError,
      ok: res.status >= 200 && res.status < 300,
      value,
      httpStatus: res.status,
      error,
      message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the caller's own observed cost signal (POST /api/agent/cost). */
export async function getCostSignal(opts: {
  key: string;
  url: string; // endpoints.agentCostUrl
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<CostSignalResult> {
  const key = assertKey(opts.key);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: "{}",
      signal: ac.signal,
    });
    let cost: CostSignal | null = null;
    try {
      const json = (await res.json()) as { cost?: CostSignal | null };
      cost = json?.cost ?? null;
    } catch {
      /* non-JSON / error body */
    }
    return { ok: res.status >= 200 && res.status < 300, cost, httpStatus: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Measure the bounded session timeline read, including the real dashboard cache. */
export async function getSessionPerformance(opts: {
  key: string;
  url: string;
  sessionId: string;
  includeFresh?: boolean;
  cacheSamples?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<SessionPerformanceResult> {
  const result = await postAgent<{ report?: SessionPerformanceReport }>({
    ...opts,
    timeoutMs: opts.timeoutMs ?? 120_000,
    body: {
      sessionId: opts.sessionId,
      ...(opts.includeFresh === undefined ? {} : { includeFresh: opts.includeFresh }),
      ...(opts.cacheSamples === undefined ? {} : { cacheSamples: opts.cacheSamples }),
    },
  });
  return {
    ok: result.ok,
    report: result.value?.report ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Find other sessions with the same normalized failure families. */
export async function findSimilarSessionErrors(opts: {
  key: string;
  url: string;
  sessionId: string;
  lookbackDays?: number;
  limit?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<SimilarSessionErrorsResult> {
  const result = await postAgent<{
    report?: SimilarSessionErrorsReport;
    performance?: AgentReadPerformance;
  }>({
    ...opts,
    timeoutMs: opts.timeoutMs ?? 25_000,
    body: {
      sessionId: opts.sessionId,
      ...(opts.lookbackDays === undefined ? {} : { lookbackDays: opts.lookbackDays }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    },
  });
  return {
    ok: result.ok,
    report: result.value?.report ?? null,
    performance: result.value?.performance ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** The compatibility route may spend 30 seconds building the bounded session
 * cohort, followed by a separately bounded 25-second prompt read. Leave a small
 * transport margin so the client does not abandon legitimate work that the
 * server is still completing. */
export const SESSION_SEARCH_REQUEST_TIMEOUT_MS = 65_000;

/** Search the caller's bounded session projection using the UI's filter grammar. */
type SessionSearchOptions<TQuery extends Record<string, unknown>> = {
  key: string;
  url: string;
  query: TQuery;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export function searchCodingSessions(opts: SessionSearchOptions<Record<string, unknown> & { precedent: true }>): Promise<SessionSearchResult<SessionPrecedentReport>>;
export function searchCodingSessions(opts: SessionSearchOptions<Record<string, unknown> & { precedent?: false }>): Promise<SessionSearchResult>;
export async function searchCodingSessions(opts: SessionSearchOptions<Record<string, unknown>>): Promise<SessionSearchResult<SessionSearchReport>> {
  const result = await postAgent<{ report?: SessionSearchReport }>({
    key: opts.key,
    url: opts.url,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? SESSION_SEARCH_REQUEST_TIMEOUT_MS,
    body: opts.query,
  });
  if (result.bodyError) {
    return {
      ok: false,
      report: null,
      httpStatus: result.httpStatus,
      error: result.bodyError,
      message: `Session-search response headers arrived but its body did not (${result.bodyError}).`,
    };
  }
  const report = result.value?.report;
  if (result.ok && (!report || typeof report !== "object" || Array.isArray(report))) {
    return {
      ok: false,
      report: null,
      httpStatus: result.httpStatus,
      error: "read_unusable",
      message: "Session-search response did not contain a usable report.",
    };
  }
  return {
    ok: result.ok,
    report: result.ok ? report ?? null : null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

export type ReplyPhraseTrendsResult = {
  ok: boolean;
  trends: Record<string, unknown> | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

/** Count the caller's own phrases in their main-thread model replies
 *  (POST /api/agent/reply-phrases, ELL-392). Counts only; no reply text. */
export async function countReplyPhrases(opts: {
  key: string;
  url: string; // endpoints.agentReplyPhrasesUrl
  query: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<ReplyPhraseTrendsResult> {
  const result = await postAgent<{ trends?: Record<string, unknown> }>({
    key: opts.key, url: opts.url, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 20_000, body: opts.query,
  });
  if (result.bodyError) {
    return { ok: false, trends: null, httpStatus: result.httpStatus, error: result.bodyError, message: `Reply-phrase response headers arrived but its body did not (${result.bodyError}).` };
  }
  const trends = result.value?.trends;
  if (result.ok && (!trends || typeof trends !== "object" || Array.isArray(trends))) {
    return { ok: false, trends: null, httpStatus: result.httpStatus, error: "read_unusable", message: "Reply-phrase response did not contain usable counts." };
  }
  return { ok: result.ok, trends: result.ok ? trends ?? null : null, httpStatus: result.httpStatus, error: result.error, message: result.message };
}

/** Estimate the effort of a proposed task from the caller's own history. Accepts
 *  free-form text and/or a Linear-shaped issue — the caller's Linear connector
 *  resolves the issue; this client only forwards its fields. */
export async function estimateTaskSize(opts: {
  key: string;
  url: string;
  taskText?: string;
  issue?: { identifier?: string; title?: string; description?: string; labels?: string[] };
  /** Linear issue key to resolve server-side through the tenant's connection. */
  issueKey?: string;
  repo?: string;
  linearScale?: LinearEstimateScale;
  /** True when that scale is Linear's extended variant (different point values). */
  linearScaleExtended?: boolean;
  lookbackDays?: number;
  limit?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<TaskEffortResult> {
  const result = await postAgent<{
    estimate?: TaskEffortEstimate;
    performance?: AgentReadPerformance;
  }>({
    ...opts,
    // Above the server's worst-case successful path (a Linear read plus the
    // corpus read's own shared budget), so a slow-but-valid estimate is not
    // aborted client-side and misreported as a timeout.
    timeoutMs: opts.timeoutMs ?? 60_000,
    body: {
      ...(opts.taskText === undefined ? {} : { taskText: opts.taskText }),
      ...(opts.issue === undefined ? {} : { issue: opts.issue }),
      ...(opts.issueKey === undefined ? {} : { issueKey: opts.issueKey }),
      ...(opts.repo === undefined ? {} : { repo: opts.repo }),
      ...(opts.linearScale === undefined ? {} : { linearScale: opts.linearScale }),
      ...(opts.linearScaleExtended === undefined ? {} : { linearScaleExtended: opts.linearScaleExtended }),
      ...(opts.lookbackDays === undefined ? {} : { lookbackDays: opts.lookbackDays }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    },
  });
  return {
    ok: result.ok,
    estimate: result.value?.estimate ?? null,
    performance: result.value?.performance ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Host health + capacity snapshot over the caller's own agentd host-metrics
 *  feed (POST /api/agent/host-health).
 *
 *  Fails SAFE by construction: a transport failure, a timeout, a non-2xx, or a
 *  tenant with no host telemetry all yield `report: null`, and the dispatch gate
 *  treats every one of those as defer. Nothing here throws for a network fault —
 *  a dispatcher must not crash because the control plane blinked.
 *
 *  `lookbackMinutes` is OMITTED when undefined rather than defaulted: supplying
 *  a value is a deliberate narrowing that also caps signal validity, and the
 *  server's own default (`staleAfterSec`) is what keeps a slow-scraping
 *  collector admittable between scrapes. */
export async function getHostHealth(opts: {
  key: string;
  url: string; // endpoints.agentHostHealthUrl
  lookbackMinutes?: number;
  /** Per-request policy override. An unknown key or out-of-range value is a 400
   *  from the server, never a silent coercion. */
  thresholds?: Partial<HostThresholds>;
  /** Ask the server to probe WHERE the telemetry was lost when it finds no hosts
   *  (ELL-49). Off by default, and charged to the expensive rate bucket when set,
   *  because it scans a 30-day horizon — the dispatch gate must never set it, since
   *  a broken pipeline is exactly the state that keeps answering empty. */
  diagnose?: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<HostHealthResult> {
  // A malformed key is a caller bug, not a control-plane outage, and stays a
  // throw like the rest of this family. Everything after this point is a
  // transport condition and must resolve, not reject.
  assertKey(opts.key);
  type Body = {
    report?: HostHealthReport | null;
    status?: unknown;
    /** Carried on a 200-with-no-hosts AND on the 503 pipeline-fault body. */
    diagnosis?: unknown;
    serverVersion?: unknown;
  };
  let result: {
    ok: boolean;
    value: Body | null;
    httpStatus: number;
    error: string | null;
    message: string | null;
    bodyError: string | null;
  };
  try {
    result = await postAgent<Body>({
      ...opts,
      // Above the server's own 20s ClickHouse ceiling for this read, so a slow
      // but valid scan is not aborted client-side and misreported as a timeout.
      // Still bounded: an unreachable control plane must not wedge the dispatch
      // loop.
      timeoutMs: opts.timeoutMs ?? 25_000,
      body: {
        ...(opts.lookbackMinutes === undefined ? {} : { lookbackMinutes: opts.lookbackMinutes }),
        ...(opts.thresholds === undefined ? {} : { thresholds: opts.thresholds }),
        ...(opts.diagnose === undefined ? {} : { diagnose: opts.diagnose }),
      },
    });
  } catch (err) {
    // DNS failure, refused connection, TLS error, offline laptop. The gate turns
    // this into a defer; a thrown exception would instead surface as a crashed
    // dispatch loop, which is exactly the single point of failure this gate is
    // required not to be.
    return {
      ok: false,
      report: null,
      status: null,
      diagnosis: null,
      serverVersion: null,
      reportUnusable: null,
      httpStatus: 0,
      error: "read_unavailable",
      message: `Host-health read could not reach the control plane: ${(err as Error).message}`,
    };
  }
  // What separates a protocol fault from a genuinely quiet fleet. The server
  // answers `{ok: true, report: null}` when the tenant has no host telemetry in
  // the window, so an explicit null is the documented EMPTY result and stays a
  // retryable "no known hosts". A body with no `report` member at all — or one
  // that could not be decoded — is a response this client does not recognise.
  // A body that never arrived is a transport condition, and it is reported as
  // one: it defers RETRYABLY, like any other failure to reach the control plane.
  // Headers can land and the stream then stall until the abort fires, and
  // calling that a malformed report would exit 1 — which a supervisor is told
  // not to retry — halting dispatch on a hiccup that would have cleared itself.
  if (result.bodyError) {
    return {
      ok: false,
      report: null,
      status: null,
      diagnosis: null,
      serverVersion: null,
      reportUnusable: null,
      httpStatus: result.httpStatus,
      error: result.bodyError,
      message: `Host-health response headers arrived but its body did not (${result.bodyError}).`,
    };
  }
  const decoded = result.ok ? result.value : null;
  const reportUnusable = ((): string | null => {
    if (!result.ok) return null;
    if (decoded === null || typeof decoded !== "object") {
      return "the response body could not be read as JSON";
    }
    if (!("report" in decoded)) return "the response carried no report member";
    if (decoded.report === null) return null;
    if (typeof decoded.report !== "object" || Array.isArray(decoded.report)) {
      return "the response report is not an object";
    }
    return null;
  })();
  return {
    ok: result.ok,
    // Only a 2xx can carry a report. A 4xx/5xx body that happens to contain a
    // `report` key must never be read as capacity evidence.
    report: result.ok && reportUnusable === null ? result.value?.report ?? null : null,
    status: result.ok && typeof result.value?.status === "string" ? result.value.status : null,
    // Read from ANY status, unlike `report`: the 503 pipeline-fault body is where
    // the storage/query diagnosis lives, and suppressing it on non-2xx would hide
    // the one hop an operator cannot otherwise see. It is diagnostic text, never
    // capacity evidence, so it is not gated on `reportUnusable`.
    diagnosis: parseDiagnosis(result.value?.diagnosis),
    serverVersion:
      typeof result.value?.serverVersion === "string" && result.value.serverVersion.trim()
        ? result.value.serverVersion.trim()
        : null,
    reportUnusable,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Estimate an EXISTING Linear issue, named by URL or identifier and resolved
 *  server-side through the caller's own connected workspace (ELL-44).
 *
 *  No Linear credential is ever sent: the reference and an optional
 *  connection/workspace hint are all this client forwards, and the server uses
 *  the tenant's stored connection. Read-only — nothing is written back to Linear. */
export async function estimateLinearIssue(opts: {
  key: string;
  url: string; // endpoints.agentLinearIssueSizeUrl
  /** A Linear issue URL or identifier (e.g. `ELL-44`). */
  reference: string;
  /** A specific CodeTelemetry Linear connection id, when the caller knows one. */
  connectionId?: string;
  /** A workspace hint — url key, workspace name, or workspace id. */
  workspace?: string;
  repo?: string;
  linearScale?: LinearEstimateScale;
  linearScaleExtended?: boolean;
  lookbackDays?: number;
  limit?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<LinearIssueEstimateResult> {
  const result = await postAgent<{
    estimate?: TaskEffortEstimate;
    source?: LinearIssueSource;
    connections?: LinearConnectionChoice[];
    performance?: AgentReadPerformance;
  }>({
    ...opts,
    // Above the server's worst-case successful path: a Linear connection listing
    // and issue read ahead of the corpus scan's two sequential ClickHouse queries.
    timeoutMs: opts.timeoutMs ?? 60_000,
    body: {
      reference: opts.reference,
      ...(opts.connectionId === undefined ? {} : { connectionId: opts.connectionId }),
      ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
      ...(opts.repo === undefined ? {} : { repo: opts.repo }),
      ...(opts.linearScale === undefined ? {} : { linearScale: opts.linearScale }),
      ...(opts.linearScaleExtended === undefined ? {} : { linearScaleExtended: opts.linearScaleExtended }),
      ...(opts.lookbackDays === undefined ? {} : { lookbackDays: opts.lookbackDays }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    },
  });
  return {
    ok: result.ok,
    estimate: result.value?.estimate ?? null,
    source: result.value?.source ?? null,
    connections: result.value?.connections ?? null,
    performance: result.value?.performance ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Read ELL-198's projection-only interpretation surface. The caller sends an
 * ingest key in the Authorization header (via postAgent), never in the body;
 * evidence snippets require an explicit, bounded pointer selection. */
export async function interpretSession(opts: {
  key: string;
  url: string;
  sessionId: string;
  service?: string;
  evidenceIds?: string[];
  /** The interpretation snapshot the evidenceIds were issued under (ELL-257). */
  snapshot?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  value: Record<string, unknown> | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
}> {
  const result = await postAgent<Record<string, unknown>>({
    ...opts,
    timeoutMs: opts.timeoutMs ?? 15_000,
    body: {
      sessionId: opts.sessionId,
      ...(opts.service === undefined ? {} : { service: opts.service }),
      ...(opts.evidenceIds === undefined ? {} : { evidenceIds: opts.evidenceIds }),
      ...(opts.snapshot === undefined ? {} : { snapshot: opts.snapshot }),
    },
  });
  return {
    ok: result.ok,
    value: result.value ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Read one personal session's recorded events (ELL-272) from the materialized
 * source store. The body is the tool input as given; the route owns its one
 * validator, so the client and hosted MCP cannot disagree about it. */
export async function readSessionEvents(opts: {
  key: string;
  url: string;
  input: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  value: Record<string, unknown> | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
}> {
  const result = await postAgent<Record<string, unknown>>({ ...opts, timeoutMs: opts.timeoutMs ?? 15_000, body: opts.input });
  return {
    ok: result.ok,
    value: result.value ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

export type GitHubGateResult = {
  ok: boolean;
  /** The gate exactly as its settings page shows it; null on failure. */
  gate: Record<string, unknown> | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
};

/** Read the workspace's GitHub PR gate (POST /api/agent/github-gate). */
export async function readGitHubGate(opts: {
  key: string;
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<GitHubGateResult> {
  const result = await postAgent<{ gate?: Record<string, unknown> }>({ ...opts, body: {} });
  return {
    ok: result.ok,
    gate: result.ok ? result.value?.gate ?? null : null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Change the workspace's GitHub PR gate (POST /api/agent/github-gate/configure).
 *  The server applies the change as the agent: it can set the gate up and
 *  tighten it, and refuses (`requires_dashboard`) to loosen one that is on. */
export async function configureGitHubGate(opts: {
  key: string;
  url: string;
  change: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<GitHubGateResult> {
  const result = await postAgent<{ gate?: Record<string, unknown> }>({ ...opts, body: opts.change });
  return {
    ok: result.ok,
    gate: result.ok ? result.value?.gate ?? null : null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Compare a selected 2–10-session cohort through the projection-only agent
 * read.  Session identifiers travel in the authenticated body; the ingest key
 * remains in Authorization and is never returned to a model. */
export async function compareSessions(opts: {
  key: string;
  url: string;
  sessions: Array<{ sessionId: string; service?: string }>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  value: Record<string, unknown> | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
}> {
  const result = await postAgent<Record<string, unknown>>({
    ...opts,
    timeoutMs: opts.timeoutMs ?? 10_000,
    body: { sessions: opts.sessions },
  });
  return {
    ok: result.ok,
    value: result.value ?? null,
    httpStatus: result.httpStatus,
    error: result.error,
    message: result.message,
  };
}

/** Read-only, bounded ELL-201 planning request.  The client only forwards
 * explicit user text; it never reads agent state or executes recommendations. */
export async function planNextSession(opts: {
  key: string;
  url: string;
  taskText?: string;
  draftPlan?: string;
  repo?: string;
  model?: string;
  environment?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  value: Record<string, unknown> | null;
  httpStatus: number;
  error: string | null;
  message: string | null;
}> {
  const result = await postAgent<Record<string, unknown>>({
    ...opts,
    timeoutMs: opts.timeoutMs ?? 10_000,
    body: {
      ...(opts.taskText === undefined ? {} : { taskText: opts.taskText }),
      ...(opts.draftPlan === undefined ? {} : { draftPlan: opts.draftPlan }),
      ...(opts.repo === undefined ? {} : { repo: opts.repo }),
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.environment === undefined ? {} : { environment: opts.environment }),
    },
  });
  return { ok: result.ok, value: result.value ?? null, httpStatus: result.httpStatus, error: result.error, message: result.message };
}
