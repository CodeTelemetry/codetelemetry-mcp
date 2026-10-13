// Client half of the device flow: request a code, show the user where to approve,
// then poll until the backend hands back the ingest key. Wire shapes are
// OAuth-device-grant-flavoured (snake_case, `authorization_pending`, `slow_down`)
// so the contract is familiar and easy to reason about.

import type { FetchLike } from "./otlp.ts";
import type { Endpoints } from "./config.ts";
import type { ExpectedKeyScope, KeyScope } from "./connectivity.ts";

// Only these OAuth-style codes are TERMINAL (stop polling). Everything else —
// authorization_pending, slow_down, an HTTP 5xx with no/unknown error body (a
// transient server blip), or any unrecognized code — is treated as "keep polling
// until the deadline", so a single backend hiccup never aborts a multi-minute login.
const TERMINAL_ERRORS = new Set(["expired_token", "invalid_grant", "access_denied", "wrong_scope"]);

/** The scope-v1 token route refuses a key outside the expected scope with
 *  409 `{ error: "access_denied", state: "wrong_scope" }`; name that refusal. */
function tokenError(body: Record<string, unknown>, fallback: string): string {
  return body.state === "wrong_scope" ? "wrong_scope" : String(body.error ?? fallback);
}

/** The ingest endpoint the server issued with the key, or the configured default
 *  when the response carries none (never the string "undefined"). */
function issuedIngestEndpoint(body: Record<string, unknown>, endpoints: Endpoints): string {
  return typeof body.ingest_endpoint === "string" && body.ingest_endpoint ? body.ingest_endpoint : endpoints.ingestEndpoint;
}

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  scopeFenced: boolean;
};

export async function requestDeviceCode(
  endpoints: Endpoints,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = 10_000,
  expected?: ExpectedKeyScope,
): Promise<DeviceCodeResponse> {
  // Any explicit scope is part of the authorization contract, so begin it on a
  // versioned route. During a rolling deployment an older task will 404 this
  // request instead of issuing a code that ignores the caller's safety fence.
  const scopeFenced = !!expected && Object.keys(expected).length > 0;
  const codeUrl = scopeFenced ? endpoints.deviceScopedCodeUrl : endpoints.deviceCodeUrl;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  try {
    let res: Response;
    try {
      res = await fetchImpl(codeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "codetelemetry-connect", ...(expected ? { expected } : {}) }),
        signal: ac.signal,
      });
    } catch (error) {
      if (ac.signal.aborted) throw new Error("device authorization request timed out");
      throw error;
    }
    if (!res.ok) throw new Error(`device authorization failed (HTTP ${res.status})`);
    let j: Record<string, unknown>;
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      if (ac.signal.aborted) throw new Error("device authorization request timed out");
      throw error;
    }
    return {
      deviceCode: String(j.device_code),
      userCode: String(j.user_code),
      verificationUri: String(j.verification_uri ?? endpoints.verificationUri),
      expiresIn: Number(j.expires_in ?? 600),
      interval: Number(j.interval ?? 2),
      scopeFenced,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type DeviceKey = { apiKey: string; ingestEndpoint: string; scope?: KeyScope };

function keyScope(value: unknown): KeyScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.tenantId !== "string" || !raw.tenantId || raw.tenantId.length > 256) return undefined;
  if (raw.teamId !== null && (typeof raw.teamId !== "string" || !raw.teamId || raw.teamId.length > 256)) return undefined;
  if (typeof raw.billingAccountId !== "string" || !raw.billingAccountId || raw.billingAccountId.length > 256) return undefined;
  return { tenantId: raw.tenantId, teamId: raw.teamId, billingAccountId: raw.billingAccountId };
}

export type PollOnce =
  | { status: "authorized"; apiKey: string; ingestEndpoint: string; scope?: KeyScope }
  | { status: "pending" }
  | { status: "error"; error: string };

async function tokenRequest(
  endpoints: Endpoints,
  deviceCode: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  scopeFenced: boolean,
): Promise<{ response: Response; body: Record<string, unknown> } | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  try {
    let response: Response;
    try {
      response = await fetchImpl(scopeFenced ? endpoints.deviceScopedTokenUrl : endpoints.deviceTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
        signal: ac.signal,
      });
    } catch (error) {
      if (ac.signal.aborted) return null;
      throw error;
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A single, non-blocking token poll — for callers (e.g. an MCP `auth_status`
 * tool) that drive their own loop instead of blocking inside `pollForKey`.
 */
export async function pollOnce(
  endpoints: Endpoints,
  deviceCode: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = 8_000,
  opts: { scopeFenced?: boolean } = {},
): Promise<PollOnce> {
  const result = await tokenRequest(endpoints, deviceCode, fetchImpl, timeoutMs, opts.scopeFenced === true);
  if (result === null) return { status: "pending" };
  const { response: res, body: j } = result;
  if (res.ok && j.api_key) {
    const scope = keyScope(j.scope);
    return {
      status: "authorized",
      apiKey: String(j.api_key),
      ingestEndpoint: issuedIngestEndpoint(j, endpoints),
      ...(scope ? { scope } : {}),
    };
  }
  const error = tokenError(j, "authorization_pending");
  // Terminal → surface as an error; anything else (pending, slow_down, a 5xx blip)
  // → keep waiting.
  return TERMINAL_ERRORS.has(error) ? { status: "error", error } : { status: "pending" };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll the token endpoint until approved. Resolves with the plaintext key (the
 * caller is responsible for keeping it out of any model context — write it, then
 * forget it). Rejects on expiry / denial / timeout.
 */
export async function pollForKey(
  endpoints: Endpoints,
  deviceCode: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: () => number;
    sleepImpl?: (ms: number) => Promise<void>;
    /** Use the versioned token route paired with a scope-v1 device code. */
    scopeFenced?: boolean;
  } = {},
): Promise<DeviceKey> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const napFor = opts.sleepImpl ?? sleep;
  let interval = opts.intervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const start = now();

  while (true) {
    const remaining = timeout - (now() - start);
    if (remaining <= 0) {
      throw new Error("device authorization timed out — approval not completed in time");
    }
    const result = await tokenRequest(endpoints, deviceCode, fetchImpl, remaining, opts.scopeFenced === true);
    if (result === null) {
      throw new Error("device authorization timed out — approval not completed in time");
    }
    const { response: res, body: j } = result;

    if (res.ok && j.api_key) {
      const scope = keyScope(j.scope);
      return {
        apiKey: String(j.api_key),
        ingestEndpoint: issuedIngestEndpoint(j, endpoints),
        ...(scope ? { scope } : {}),
      };
    }
    const error = tokenError(j, res.status >= 500 ? "server_error" : "authorization_pending");
    if (TERMINAL_ERRORS.has(error)) {
      throw new Error(`device authorization ${error}`);
    }
    if (error === "slow_down") {
      interval += 2_000;
    }
    // authorization_pending / server_error (transient 5xx) / unknown → keep polling.
    if (now() - start + interval >= timeout) {
      throw new Error("device authorization timed out — approval not completed in time");
    }
    await napFor(interval);
  }
}
