// Confirm the probe actually landed in the tenant's store. The client can't read
// ClickHouse, so it asks the backend: POST /api/connectivity/check authenticated
// with the *ingest key itself* (which already resolves to a tenant), passing the
// probe id. The backend answers seen / not-seen for that tenant. We poll because
// ingestion is async (collector → ClickHouse) and takes a few seconds.

import type { FetchLike } from "./otlp.ts";
import { assertKey } from "./keys.ts";

export type ConnectivityState =
  | "scope_verified"
  | "connected"
  | "ingestion_delay"
  | "wrong_scope"
  | "budget_exhausted"
  | "invalid_key"
  | "dashboard_read_failure"
  | "unknown_failure";

export type KeyScope = { tenantId: string; teamId: string | null; billingAccountId: string };
export type ExpectedKeyScope = Partial<KeyScope>;
export type CheckResult = {
  seen: boolean;
  httpStatus: number;
  state: ConnectivityState;
  scope?: KeyScope;
  /** The account's position as the ingest gate sees it: credit, standing seats,
   *  and this month's unused included tokens, as the connectivity check
   *  reports it. */
  budget?: { creditBalanceUsd: number; seats: number; remainingIncludedTokens: number } | null;
  mismatches?: (keyof KeyScope)[];
};

export async function checkOnce(opts: {
  key: string;
  connectivityUrl: string;
  probeId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  expected?: ExpectedKeyScope;
}): Promise<CheckResult> {
  const key = assertKey(opts.key);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetchImpl(opts.connectivityUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ probeId: opts.probeId, ...(opts.expected ? { expected: opts.expected } : {}) }),
      signal: ac.signal,
    });
    let payload: Partial<CheckResult> = {};
    try {
      payload = ((await res.json()) ?? {}) as Partial<CheckResult>;
    } catch {
      /* non-JSON / error body → treat as not-seen */
    }
    const seen = payload.seen === true;
    const state: ConnectivityState = typeof payload.state === "string"
      ? payload.state as ConnectivityState
      : seen
        ? "connected"
        : res.status === 401
          ? "invalid_key"
          : res.status >= 500
            ? "dashboard_read_failure"
            : "ingestion_delay";
    return {
      seen,
      httpStatus: res.status,
      state,
      ...(payload.scope ? { scope: payload.scope } : {}),
      ...(payload.budget !== undefined ? { budget: payload.budget } : {}),
      ...(payload.mismatches ? { mismatches: payload.mismatches } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate key destination and billing before writing local configuration. */
export async function verifyScope(opts: {
  key: string;
  connectivityUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  expected: ExpectedKeyScope;
}): Promise<CheckResult> {
  const key = assertKey(opts.key);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetchImpl(opts.connectivityUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ scopeOnly: true, expected: opts.expected }),
      signal: ac.signal,
    });
    let payload: Partial<CheckResult> = {};
    try {
      payload = ((await res.json()) ?? {}) as Partial<CheckResult>;
    } catch {
      /* handled by the state fallback below */
    }
    const state: ConnectivityState = typeof payload.state === "string"
      ? payload.state as ConnectivityState
      : res.status === 401
        ? "invalid_key"
        : res.status >= 500
          ? "dashboard_read_failure"
          : "unknown_failure";
    return {
      seen: false,
      httpStatus: res.status,
      state,
      ...(payload.scope ? { scope: payload.scope } : {}),
      ...(payload.budget !== undefined ? { budget: payload.budget } : {}),
      ...(payload.mismatches ? { mismatches: payload.mismatches } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export type ConfirmResult = CheckResult & { landed: boolean; elapsedMs: number; polls: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until the probe is seen or the timeout elapses. */
export async function confirmLanded(opts: {
  key: string;
  connectivityUrl: string;
  probeId: string;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (poll: number) => void;
  now?: () => number;
  expected?: ExpectedKeyScope;
}): Promise<ConfirmResult> {
  const interval = opts.intervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const start = now();
  let polls = 0;
  let last: CheckResult | null = null;
  // First check immediately, then on the interval.
  while (true) {
    const remaining = timeout - (now() - start);
    if (remaining <= 0) {
      // Out of time before (another) check: keep the last diagnostic, or report
      // the not-yet-seen state when no check ran at all.
      const fallback: CheckResult = { seen: false, httpStatus: 0, state: "ingestion_delay" };
      return { ...(last ?? fallback), landed: false, elapsedMs: now() - start, polls };
    }
    polls += 1;
    opts.onTick?.(polls);
    const checked = await checkOnce({
      key: opts.key,
      connectivityUrl: opts.connectivityUrl,
      probeId: opts.probeId,
      fetchImpl: opts.fetchImpl,
      expected: opts.expected,
      timeoutMs: Math.min(8_000, remaining),
    });
    last = checked;
    const elapsedMs = now() - start;
    if (checked.seen) return { ...checked, landed: true, elapsedMs, polls };
    // A probe can be accepted while consuming the account's final available
    // credit, then remain briefly invisible to the dashboard read. A transient
    // dashboard/ClickHouse failure can also clear before the accepted probe is
    // visible. Keep polling those not-seen states within the existing bound;
    // the final response still preserves the last diagnostic if they persist.
    if (checked.state !== "ingestion_delay"
      && checked.state !== "budget_exhausted"
      && checked.state !== "dashboard_read_failure") {
      return { ...checked, landed: false, elapsedMs, polls };
    }
    if (elapsedMs + interval >= timeout) return { ...checked, landed: false, elapsedMs, polls };
    await sleep(interval);
  }
}
