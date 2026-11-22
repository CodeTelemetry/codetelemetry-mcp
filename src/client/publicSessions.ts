// Public session reads: CodeTelemetry's sample sessions and sessions their
// owners published, readable with NO credentials. These requests never carry
// an Authorization header, so a held ingest key can never reach them, and the
// server answers them from the same reader as its anonymous /public-mcp.
//
// Publishing (making one of YOUR sessions public) is a separate, key-
// authenticated call: see publishSession and friends in agent.ts.
import type { FetchLike } from "./otlp.ts";

export const PUBLIC_SESSION_ID_BYTES = 128;
export const PUBLIC_EVENTS_INPUT_BYTES = 4 * 1024;
/** Responses above this are refused rather than handed to a model or terminal. */
export const PUBLIC_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type PublicReadResult = {
  ok: boolean;
  httpStatus: number;
  value: Record<string, unknown> | null;
  error: string | null;
  message: string | null;
};

export function validPublicSessionId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= PUBLIC_SESSION_ID_BYTES &&
    /^[A-Za-z0-9_.:-]+$/.test(id);
}

async function publicRequest(opts: {
  url: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PublicReadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        method: opts.method,
        // Deliberately no Authorization header.
        headers: opts.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        signal: ac.signal,
      });
    } catch (error) {
      return { ok: false, httpStatus: 0, value: null, error: ac.signal.aborted ? "read_timeout" : "read_unavailable",
        message: ac.signal.aborted ? "Public session read timed out." : `Public session read failed: ${String((error as Error).message)}` };
    }
    let text: string;
    try { text = await res.text(); } catch {
      return { ok: false, httpStatus: res.status, value: null, error: ac.signal.aborted ? "read_timeout" : "read_unavailable", message: "The response body did not arrive." };
    }
    if (Buffer.byteLength(text, "utf8") > PUBLIC_RESPONSE_BYTES) {
      return { ok: false, httpStatus: res.status, value: null, error: "response_too_large", message: "The public session response exceeded the client's size bound." };
    }
    let value: Record<string, unknown> | null = null;
    try {
      const parsed = text ? JSON.parse(text) : null;
      value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { /* A non-JSON error body still has a useful status. */ }
    return {
      ok: res.status >= 200 && res.status < 300 && value !== null,
      httpStatus: res.status,
      value,
      error: typeof value?.error === "string" ? value.error : res.status === 429 ? "rate_limited" : null,
      message: typeof value?.message === "string" ? value.message : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const publicSessionsUrl = (apiBase: string) => `${apiBase.replace(/\/$/, "")}/api/public/sessions`;

/** The public sample sessions (published sessions are unlisted). */
export function listPublicSessions(opts: { apiBase: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<PublicReadResult> {
  return publicRequest({ url: publicSessionsUrl(opts.apiBase), method: "GET", fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** One sample or published session's summary. */
export async function getPublicSession(opts: { apiBase: string; id: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<PublicReadResult> {
  if (!validPublicSessionId(opts.id)) return { ok: false, httpStatus: 0, value: null, error: "bad_input", message: "id must be a sample id or a pub_… public session id" };
  return publicRequest({ url: `${publicSessionsUrl(opts.apiBase)}/${encodeURIComponent(opts.id)}`, method: "GET", fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** A bounded page of a public session's recorded events. */
export async function readPublicSessionEvents(opts: {
  apiBase: string;
  id: string;
  input?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PublicReadResult> {
  if (!validPublicSessionId(opts.id)) return { ok: false, httpStatus: 0, value: null, error: "bad_input", message: "id must be a sample id or a pub_… public session id" };
  const input = opts.input ?? {};
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > PUBLIC_EVENTS_INPUT_BYTES) {
    return { ok: false, httpStatus: 0, value: null, error: "bad_input", message: "event paging input is too large" };
  }
  return publicRequest({ url: `${publicSessionsUrl(opts.apiBase)}/${encodeURIComponent(opts.id)}/events`, method: "POST", body: input,
    fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 15_000 });
}
