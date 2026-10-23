import type { FetchLike } from "../otlp.ts";
import { assertKey } from "../keys.ts";
import { KIRO_LIMITS } from "./records.ts";

export type KiroPostResult = "ok" | "retry" | "auth" | "budget" | "rejected";
export type KiroPost = (body: string, idempotencyKey: string) => Promise<KiroPostResult>;

/** Bytes are encoded once in the durable spool. A retry never re-serializes them
 * or invents another key. This runs only in the background collector process. */
export function kiroTransport(opts: {endpoint: string; key: string; fetchImpl?: FetchLike; allowHttp?: boolean}): KiroPost {
  const key = assertKey(opts.key);
  const url = new URL(opts.endpoint.replace(/\/$/, "") + "/v1/logs");
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("invalid Kiro ingest endpoint");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (body, idempotencyKey) => {
    if (Buffer.byteLength(body) > KIRO_LIMITS.envelopeBytes || !/^[a-f0-9-]{36}$/.test(idempotencyKey)) throw new Error("invalid Kiro retry envelope");
    // Existing canonical pending envelopes retry without acquiring a new protocol.
    let sourceEnvelope = false;
    try {
      const document = JSON.parse(body);
      sourceEnvelope = Array.isArray(document?.resourceLogs) && document.resourceLogs.some((r: any) =>
        Array.isArray(r?.scopeLogs) && r.scopeLogs.some((s: any) => Array.isArray(s?.logRecords) && s.logRecords.some((row: any) =>
          Array.isArray(row?.attributes) && row.attributes.some((a: any) => a?.key === "event.name" && a.value?.stringValue === "kiro.source_record"))));
    } catch {return "rejected";}
    const sourceHeader = "x-codetelemetry-source-format";
    const sourceFormat = "kiro-v3-source-v1";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KIRO_LIMITS.requestMs);
    try {
      const response = await fetchImpl(url.toString(), {method: "POST", body,
        headers: {"content-type": "application/json", authorization: `Bearer ${key}`, "x-code-telemetry-idempotency-key": idempotencyKey, ...(sourceEnvelope ? {[sourceHeader]:sourceFormat} : {})},
        signal: controller.signal, redirect: "error"});
      if (response.status === 401 || response.status === 403) {await response.body?.cancel(); return "auth";}
      if (response.status === 402) {await response.body?.cancel(); return "budget";}
      if (response.status >= 200 && response.status < 300) {
        if (sourceEnvelope && response.headers.get(sourceHeader) !== sourceFormat) {await response.body?.cancel(); return "rejected";}
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 4096) {await reader.cancel(); return "retry";}
              chunks.push(part.value);
            }
          } finally {reader.releaseLock();}
        }
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (!text) return "ok";
        try {
          const result = JSON.parse(text);
          if (!result || typeof result !== "object" || Array.isArray(result) ||
            (result.partialSuccess !== undefined && (!result.partialSuccess || typeof result.partialSuccess !== "object" || Array.isArray(result.partialSuccess)))) return "retry";
          const rejected = result.partialSuccess?.rejectedLogRecords;
          if (rejected !== undefined && String(rejected) !== "0") return "rejected";
          return "ok";
        } catch {return "retry";}
      }
      await response.body?.cancel();
      return response.status === 408 || response.status === 429 || response.status >= 500 ? "retry" : "rejected";
    } catch {return "retry";}
    finally {clearTimeout(timer);}
  };
}
