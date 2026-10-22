// HTTP for the importer: OTLP posts to the ingest front door and the
// import-status read, with the failure classification the commit protocol
// depends on. Pure fetch (no node: imports) so a browser upload can share it.
//
// The ingest front door (iac/cdk/services/ingest-auth) answers, before it
// forwards anything to the collector: 401 bad key, 402 billing pool exhausted
// (no Retry-After; exporters don't retry it), 413 too large, 429 per-key rate
// limit (600/min, shared with the user's LIVE exporters, no Retry-After), 408
// slow upload, and 503 "…capacity busy; retry" (2 in flight per tenant). Those
// are DEFINITIVE: nothing reached storage, so a retry cannot duplicate. A 502,
// a 503 collector timeout, a 5xx from the collector or a dropped connection
// happen AFTER the body may have been forwarded: the batch may or may not
// have landed. Logs may be retried through that (they collapse on read);
// token-metric parts may not, and are reported `uncertain` instead.

import type { FetchLike } from "../otlp.ts";

export type PostOutcome =
  | { kind: "ok" }
  | { kind: "auth"; status: number }
  | { kind: "budget"; topup: string | null }
  | { kind: "rejected"; status: number; message: string }
  /** Every attempt was refused BEFORE forwarding (429 / 408 / 503 busy): nothing landed. */
  | { kind: "busy"; detail: string }
  | { kind: "uncertain"; detail: string };

export type Pacer = { wait(): Promise<void> };

/** At most `perMinute` requests per minute, spaced evenly. Shared by every
 *  request of a run, so live exporters on the same key keep headroom. */
export function makePacer(perMinute: number, sleep: (ms: number) => Promise<void>, now: () => number = Date.now): Pacer {
  const gap = Math.ceil(60_000 / Math.max(1, perMinute));
  let next = 0;
  return {
    async wait() {
      const t = now();
      if (t < next) await sleep(next - t);
      next = Math.max(t, next) + gap;
    },
  };
}

export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PRE_FORWARD_503 = /capacity busy|receipt unavailable/i;

export type PostOptions = {
  url: string;
  key: string;
  body: unknown;
  fetchImpl: FetchLike;
  pacer: Pacer;
  sleep: (ms: number) => Promise<void>;
  /** Retry post-forward failures too (safe for log parts only). */
  retryAmbiguous: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
};

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export async function postOtlp(opts: PostOptions): Promise<PostOutcome> {
  const payload = JSON.stringify(opts.body);
  const maxAttempts = opts.maxAttempts ?? 6;
  let lastDetail = "";
  let lastWasDefinitive = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await opts.sleep(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 2), BACKOFF_MAX_MS));
    }
    await opts.pacer.wait();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 45_000);
    let res: Response;
    try {
      res = await opts.fetchImpl(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
        body: payload,
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastDetail = `network error (${err instanceof Error ? err.name : "unknown"})`;
      lastWasDefinitive = false;
      if (!opts.retryAmbiguous) return { kind: "uncertain", detail: lastDetail };
      continue;
    }
    clearTimeout(timer);
    const status = res.status;
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    if (status >= 200 && status < 300) return { kind: "ok" };
    if (status === 401 || status === 403) return { kind: "auth", status };
    if (status === 402) {
      let topup: string | null = null;
      try {
        const parsed = JSON.parse(text);
        topup = typeof parsed?.topup === "string" ? parsed.topup : null;
      } catch {
        topup = null;
      }
      return { kind: "budget", topup };
    }
    const definitiveRetry = status === 429 || status === 408 || (status === 503 && PRE_FORWARD_503.test(text));
    if (definitiveRetry) {
      lastWasDefinitive = true;
      lastDetail = `HTTP ${status}`;
      continue;
    }
    if (status >= 500) {
      lastDetail = `HTTP ${status}`;
      lastWasDefinitive = false;
      if (!opts.retryAmbiguous) return { kind: "uncertain", detail: lastDetail };
      continue;
    }
    return { kind: "rejected", status, message: text.slice(0, 200) };
  }
  if (lastWasDefinitive) return { kind: "busy", detail: lastDetail };
  return opts.retryAmbiguous ? { kind: "rejected", status: 0, message: lastDetail } : { kind: "uncertain", detail: lastDetail };
}

export type StatusRequestSession = { sessionId: string; startMs: number; endMs: number; probePlan?: string };

export type StatusResponse = {
  sessions: Array<{
    sessionId: string;
    live: boolean;
    plans: Array<{ plan: string; complete: boolean; logParts: string[]; metricParts?: string[]; lastArrivalMs: number }>;
  }>;
  settleMs: number;
  nowMs: number;
};

export type StatusOutcome =
  | { kind: "ok"; value: StatusResponse }
  | { kind: "auth"; status: number }
  | { kind: "unavailable"; detail: string };

/** POST one import-status batch, retrying the agent route's own 429 (60/min). */
export async function fetchStatus(opts: {
  url: string;
  key: string;
  sessions: StatusRequestSession[];
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<StatusOutcome> {
  let detail = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await opts.sleep(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 2), BACKOFF_MAX_MS));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await opts.fetchImpl(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
        body: JSON.stringify({ sessions: opts.sessions }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      detail = `network error (${err instanceof Error ? err.name : "unknown"})`;
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) return { kind: "auth", status: res.status };
    if (res.status === 429 || res.status >= 500) {
      detail = `HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503 || res.status === 502) continue;
      return { kind: "unavailable", detail };
    }
    if (res.status !== 200) return { kind: "unavailable", detail: `HTTP ${res.status}` };
    try {
      const json = (await res.json()) as Partial<StatusResponse> & { ok?: boolean };
      if (!Array.isArray(json.sessions)) return { kind: "unavailable", detail: "malformed status response" };
      return {
        kind: "ok",
        value: {
          sessions: json.sessions,
          settleMs: typeof json.settleMs === "number" ? json.settleMs : 300_000,
          nowMs: typeof json.nowMs === "number" ? json.nowMs : Date.now(),
        },
      };
    } catch {
      return { kind: "unavailable", detail: "malformed status response" };
    }
  }
  return { kind: "unavailable", detail };
}
