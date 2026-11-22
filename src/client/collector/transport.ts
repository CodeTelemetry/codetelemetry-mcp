import type { FetchLike } from "../otlp.ts";
import { assertKey } from "../keys.ts";

export const SOURCE_FORMAT_HEADER = "x-codetelemetry-source-format";
export const IDEMPOTENCY_HEADER = "x-code-telemetry-idempotency-key";
/** The `code` of a 400 that refuses a frame, as opposed to a service that does not serve the format. */
export const SOURCE_ENVELOPE_INVALID = "source_envelope_invalid";
/** A server-supplied retry-after is honoured up to this long. */
export const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;
const RESPONSE_BYTES = 4096;

/** What a delivery policy keys on. */
export type CollectorPostOutcome = "ok" | "retry" | "network" | "auth" | "budget" | "unsupported" | "rejected";
/** Why no HTTP response arrived. "network" is every failure without a more specific class. */
export type CollectorErrorClass = "proxy" | "tls" | "dns" | "connect" | "timeout" | "network";
/** The finer class, for health and status text:
 *  ok          accepted      2xx, format acknowledged, no rejected records
 *  retry       rate_limited  429
 *              server        408, 5xx, or a 2xx whose body is oversized or malformed
 *  network     an error class; no HTTP response arrived
 *  auth        auth          401, 403
 *  budget      budget        402
 *  unsupported unsupported   415; a 2xx without the format echo; a 400 without the invalid-frame code
 *                            (with a marker event a 400 is "refused" and its body is not read)
 *  rejected    invalid       400 with the invalid-frame code, or a body that is not JSON
 *              conflict      409: the idempotency key was already used with other bytes
 *              partial       2xx reporting rejected log records
 *              refused       any other 4xx */
export type CollectorPostDetail = "accepted" | "rate_limited" | "server" | "auth" | "budget" | "unsupported" |
  "invalid" | "conflict" | "partial" | "refused" | CollectorErrorClass;
export type CollectorPostResult = {outcome: CollectorPostOutcome; detail: CollectorPostDetail;
  /** Present whenever a response arrived. */
  httpStatus?: number;
  /** Parsed retry-after of a retryable response, in milliseconds. */
  retryAfterMs?: number;
  /** Present exactly when outcome is "network"; equals detail. */
  errorClass?: CollectorErrorClass};
export type CollectorPost = (body: string, idempotencyKey: string) => Promise<CollectorPostResult>;
export type CollectorTransportOptions = {endpoint: string; key: string;
  /** Value of the source-format request header, which a 2xx must echo. */
  format: string;
  /** When set, only a body holding a record with this event.name is sent as a
   * source envelope; any other body goes out without the header. When absent,
   * every body carries the header. */
  markerEvent?: string;
  envelopeBytes: number; requestMs: number;
  /** Names the collector in error text. */
  label: string;
  fetchImpl?: FetchLike; allowHttp?: boolean;
  /** Read for the proxy variables that decide the "proxy" error class. */
  env?: NodeJS.ProcessEnv;
  now?: () => number};

/** Whether Node routes this request through an environment proxy. */
function proxied(url: URL, env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_USE_ENV_PROXY !== "1") return false;
  const plain = env.http_proxy ?? env.HTTP_PROXY, secure = env.https_proxy ?? env.HTTPS_PROXY;
  if (!(url.protocol === "https:" ? secure || plain : plain)) return false;
  const exclusions = (env.no_proxy ?? env.NO_PROXY ?? "").split(/[,\s]/).filter(Boolean).slice(0, 64);
  const host = url.hostname.toLowerCase(), port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  return !exclusions.some(entry => {
    if (entry === "*") return true;
    const parts = /^(.+):(\d+)$/.exec(entry), name = (parts ? parts[1] : entry).toLowerCase();
    if (parts && Number(parts[2]) !== port) return false;
    return /^[.*]/.test(name) ? host.endsWith(name.replace(/^[*]/, "")) : host === name;
  });
}

/** Classify from error codes only; no message or raw error leaves this module. */
function failureClass(error: unknown, timedOut: boolean, viaProxy: boolean): CollectorErrorClass {
  const codes: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 4 || codes.length >= 16) return;
    const item = value as {code?: unknown; cause?: unknown; errors?: unknown};
    if (typeof item.code === "string") codes.push(item.code);
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) item.errors.slice(0, 4).forEach(nested => visit(nested, depth + 1));
  };
  visit(error, 0);
  if (timedOut || codes.some(code => /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code))) return "timeout";
  if (codes.some(code => /^(?:CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|ERROR_IN_CERT_|ERR_TLS_|ERR_SSL_|ERR_OSSL_)|^(?:INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH|EPROTO)$/.test(code))) return "tls";
  // Behind a proxy the client resolves and connects to the proxy only.
  if (viaProxy) return "proxy";
  if (codes.some(code => /^(?:ENOTFOUND|EAI_[A-Z]+)$/.test(code))) return "dns";
  if (codes.some(code => /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|EPIPE|UND_ERR_SOCKET)$/.test(code))) return "connect";
  return "network";
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  // Delay seconds or an HTTP date in its one current form; anything else is ignored.
  const ms = /^\d{1,9}$/.test(text) ? Number(text) * 1000
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ? Date.parse(text) - now : NaN;
  return Number.isFinite(ms) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms)) : undefined;
}

/** At most RESPONSE_BYTES of a response body; null when it is larger. */
async function boundedText(response: Response): Promise<string | null> {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > RESPONSE_BYTES) {await reader.cancel(); return null;}
        chunks.push(part.value);
      }
    } finally {reader.releaseLock();}
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Bytes are encoded once in the durable spool. A retry never re-serializes them
 * or invents another key. The result carries classes only, never a raw error. */
export function collectorTransport(opts: CollectorTransportOptions): CollectorPost {
  const key = assertKey(opts.key);
  const url = new URL(opts.endpoint.replace(/\/$/, "") + "/v1/logs");
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error(`invalid ${opts.label} ingest endpoint`);
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(opts.format)) throw new Error(`invalid ${opts.label} source format`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (body, idempotencyKey) => {
    if (Buffer.byteLength(body) > opts.envelopeBytes || !/^[a-f0-9-]{36}$/.test(idempotencyKey)) throw new Error(`invalid ${opts.label} retry envelope`);
    let sourceEnvelope = true;
    if (opts.markerEvent !== undefined) {
      try {
        const document = JSON.parse(body);
        sourceEnvelope = Array.isArray(document?.resourceLogs) && document.resourceLogs.some((r: any) =>
          Array.isArray(r?.scopeLogs) && r.scopeLogs.some((s: any) => Array.isArray(s?.logRecords) && s.logRecords.some((row: any) =>
            Array.isArray(row?.attributes) && row.attributes.some((a: any) => a?.key === "event.name" && a.value?.stringValue === opts.markerEvent))));
      } catch {return {outcome: "rejected", detail: "invalid"};}
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.requestMs);
    try {
      const response = await fetchImpl(url.toString(), {method: "POST", body,
        headers: {"content-type": "application/json", authorization: `Bearer ${key}`, [IDEMPOTENCY_HEADER]: idempotencyKey, ...(sourceEnvelope ? {[SOURCE_FORMAT_HEADER]: opts.format} : {})},
        signal: controller.signal, redirect: "error"});
      const httpStatus = response.status;
      if (httpStatus === 401 || httpStatus === 403) {await response.body?.cancel(); return {outcome: "auth", detail: "auth", httpStatus};}
      if (httpStatus === 402) {await response.body?.cancel(); return {outcome: "budget", detail: "budget", httpStatus};}
      if (httpStatus >= 200 && httpStatus < 300) {
        if (sourceEnvelope && response.headers.get(SOURCE_FORMAT_HEADER) !== opts.format) {await response.body?.cancel(); return {outcome: "unsupported", detail: "unsupported", httpStatus};}
        const text = await boundedText(response);
        if (text === null) return {outcome: "retry", detail: "server", httpStatus};
        if (!text) return {outcome: "ok", detail: "accepted", httpStatus};
        try {
          const result = JSON.parse(text);
          if (!result || typeof result !== "object" || Array.isArray(result) ||
            (result.partialSuccess !== undefined && (!result.partialSuccess || typeof result.partialSuccess !== "object" || Array.isArray(result.partialSuccess)))) return {outcome: "retry", detail: "server", httpStatus};
          const rejected = result.partialSuccess?.rejectedLogRecords;
          if (rejected !== undefined && String(rejected) !== "0") return {outcome: "rejected", detail: "partial", httpStatus};
          return {outcome: "ok", detail: "accepted", httpStatus};
        } catch {return {outcome: "retry", detail: "server", httpStatus};}
      }
      // A collector with a marker event (Kiro) never read the body of a refusal:
      // every 400 is a rejection for it, answered without waiting for a body.
      if (httpStatus === 400 && sourceEnvelope && opts.markerEvent === undefined) {
        // Only the coded answer refuses the frame. A body that cannot be read,
        // is not JSON or names no such code is a service without this format.
        let code: unknown;
        try {code = JSON.parse(await boundedText(response) ?? "null")?.code;} catch { /* The code-less case. */ }
        return code === SOURCE_ENVELOPE_INVALID ? {outcome: "rejected", detail: "invalid", httpStatus} : {outcome: "unsupported", detail: "unsupported", httpStatus};
      }
      await response.body?.cancel();
      if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
        const retryAfterMs = retryAfter(response.headers.get("retry-after"), (opts.now ?? Date.now)());
        return {outcome: "retry", detail: httpStatus === 429 ? "rate_limited" : "server", httpStatus, ...(retryAfterMs === undefined ? {} : {retryAfterMs})};
      }
      if (httpStatus === 415 && sourceEnvelope) return {outcome: "unsupported", detail: "unsupported", httpStatus};
      return {outcome: "rejected", detail: httpStatus === 409 ? "conflict" : "refused", httpStatus};
    } catch (error) {
      const errorClass = failureClass(error, controller.signal.aborted, proxied(url, opts.env ?? process.env));
      return {outcome: "network", detail: errorClass, errorClass};
    }
    finally {clearTimeout(timer);}
  };
}
