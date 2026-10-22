// The import commit protocol, as pure functions (tested without a network).
//
// A session's import PLAN is the exact list of log parts and token-metric parts
// its conversion produced; its id is a hash of that content, so the same file,
// window and content policy always yield the same plan. A plan is COMMITTED
// when its completion marker lands, which is posted only after every part was
// accepted. Log parts may be resent safely (their rows carry deterministic
// vendor ids and timestamps, so the read-time replay identity collapses them);
// metric parts may not (token points have no such identity), so a resume sends
// only the metric parts that are known NOT to have landed.

import type { LedgerEntry } from "./ledger.ts";

export type PlanStatus = {
  plan: string;
  complete: boolean;
  logParts: string[];
  metricParts?: string[];
  lastArrivalMs: number;
};

export type SessionStatus = { sessionId: string; live: boolean; plans: PlanStatus[] };

export type PlanShape = { id: string; logParts: number; metricParts: number };

export type SkipReason =
  | "live" // live OTEL already captured the session — importing would double count
  | "already_imported" // this exact plan committed earlier
  | "changed_since_import" // an earlier version of the session committed
  | "conflicting_partial" // an uncommitted import of a DIFFERENT plan exists
  | "settling" // rows of this plan arrived moments ago; re-run later
  | "unverifiable"; // metric parts of a partial plan could not be verified

export type Decision =
  | { action: "skip"; reason: SkipReason; plans?: string[] }
  | { action: "probe" }
  | { action: "send"; skipLogParts: number[]; skipMetricParts: number[]; resumed: boolean };

export const logPartLabel = (i: number): string => `L${i}`;
export const metricPartLabel = (i: number): string => `M${i}`;
export const COMMIT_PART_LABEL = "C";

const parseLabels = (labels: string[] | undefined, prefix: string): number[] =>
  (labels ?? [])
    .filter((l) => l.startsWith(prefix))
    .map((l) => Number(l.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n >= 0);

/**
 * Decide what to do with one session. `status` is the server's view (required —
 * without it live overlap cannot be ruled out), `ledger` this machine's record.
 * Returns `probe` when the server must first report which metric parts of our
 * plan landed; call again with the probed status.
 */
export function decide(
  plan: PlanShape,
  status: SessionStatus,
  ledger: LedgerEntry | undefined,
  nowMs: number,
  settleMs: number,
  probed = false,
): Decision {
  if (status.live) return { action: "skip", reason: "live" };
  const committed = status.plans.filter((p) => p.complete);
  if (committed.some((p) => p.plan === plan.id)) return { action: "skip", reason: "already_imported" };
  if (committed.length > 0) return { action: "skip", reason: "changed_since_import", plans: committed.map((p) => p.plan) };
  const others = status.plans.filter((p) => p.plan !== plan.id && !p.complete);
  if (others.length > 0) return { action: "skip", reason: "conflicting_partial", plans: others.map((p) => p.plan) };

  // Local evidence counts too: an unfinished earlier plan whose token parts were
  // accepted (or may have been) blocks a different plan even before its rows
  // are visible on the server.
  if (ledger && ledger.plan !== plan.id && ledger.state === "partial" &&
    (ledger.metricParts.length > 0 || ledger.uncertainMetricParts.length > 0)) {
    return { action: "skip", reason: "conflicting_partial", plans: [ledger.plan] };
  }
  const ours = status.plans.find((p) => p.plan === plan.id);
  const mine = ledger && ledger.plan === plan.id ? ledger : undefined;
  const fresh = !ours && (!mine || (mine.logParts.length === 0 && mine.metricParts.length === 0 && mine.uncertainMetricParts.length === 0));
  if (fresh) return { action: "send", skipLogParts: [], skipMetricParts: [], resumed: false };

  // Resuming. Rows written moments ago may still be in flight to ClickHouse, and
  // a part that looks absent now could appear a second later.
  const lastTouch = Math.max(ours?.lastArrivalMs ?? 0, mine?.atMs ?? 0);
  if (lastTouch > nowMs - settleMs) return { action: "skip", reason: "settling" };

  const skipLogParts = new Set<number>([...(mine?.logParts ?? []), ...parseLabels(ours?.logParts, "L")]);
  const landedMetric = new Set<number>(mine?.metricParts ?? []);
  if (plan.metricParts > 0) {
    // The ledger alone is enough only when it saw every metric outcome itself.
    const ledgerComplete = !!mine && mine.uncertainMetricParts.length === 0;
    if (!ledgerComplete) {
      if (!probed) return { action: "probe" };
      const fromServer = ours?.metricParts;
      if (!fromServer) return { action: "skip", reason: "unverifiable" };
      for (const n of parseLabels(fromServer, "M")) landedMetric.add(n);
    }
  }
  return {
    action: "send",
    skipLogParts: [...skipLogParts].filter((n) => n < plan.logParts).sort((a, b) => a - b),
    skipMetricParts: [...landedMetric].filter((n) => n < plan.metricParts).sort((a, b) => a - b),
    resumed: true,
  };
}
