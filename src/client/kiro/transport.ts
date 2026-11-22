import type { FetchLike } from "../otlp.ts";
import { collectorTransport } from "../collector/transport.ts";
import { KIRO_LIMITS } from "./records.ts";

export type KiroPostResult = "ok" | "retry" | "auth" | "budget" | "rejected";
export type KiroPost = (body: string, idempotencyKey: string) => Promise<KiroPostResult>;

/** Bytes are encoded once in the durable spool. A retry never re-serializes them
 * or invents another key. This runs only in the background collector process.
 * Existing canonical pending envelopes carry no marker record and retry without
 * acquiring the source protocol. */
export function kiroTransport(opts: {endpoint: string; key: string; fetchImpl?: FetchLike; allowHttp?: boolean}): KiroPost {
  const post = collectorTransport({...opts, format: "kiro-v3-source-v1", markerEvent: "kiro.source_record",
    envelopeBytes: KIRO_LIMITS.envelopeBytes, requestMs: KIRO_LIMITS.requestMs, label: "Kiro"});
  return async (body, idempotencyKey) => {
    // Kiro's flush policy predates the finer classes: a service without the
    // format is a rejection and a failed connection is an ordinary retry.
    const {outcome} = await post(body, idempotencyKey);
    return outcome === "unsupported" ? "rejected" : outcome === "network" ? "retry" : outcome;
  };
}
