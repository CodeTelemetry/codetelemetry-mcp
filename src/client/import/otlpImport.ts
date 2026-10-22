// Encode import records as OTLP/HTTP JSON — the encoding the ingest front door
// forwards to the collector's OTLP receiver (the same one `otlp.ts` uses for the
// onboarding probe). Pure, so the browser upload can share it. One request is
// one resource: the session's provenance travels as resource attributes
// (ingest.source / import.* — see docs/history-import.md).

import type { ImportAttributes, ImportLog, ImportMetric, Primitive } from "./model.ts";

function anyValue(value: Primitive): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  // OTLP/JSON carries int64 as a decimal string.
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function kvList(attrs: ImportAttributes): Array<Record<string, unknown>> {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: anyValue(value as Primitive) }));
}

const SCOPE = { name: "codetelemetry-connect.history-import" };

export function toOtlpLogs(logs: ImportLog[], resource: ImportAttributes, scope: {name: string; version?: string} = SCOPE): unknown {
  return {
    resourceLogs: [{
      resource: { attributes: kvList(resource) },
      scopeLogs: [{
        scope,
        logRecords: logs.map((l) => ({
          timeUnixNano: l.timeUnixNano,
          observedTimeUnixNano: l.timeUnixNano,
          severityNumber: 9,
          severityText: "INFO",
          attributes: kvList(l.attributes),
          ...(l.body !== undefined ? { body: { stringValue: l.body } } : {}),
        })),
      }],
    }],
  };
}

/** Delta, monotonic sums — the temporality the token readers assume. */
export function toOtlpMetrics(metrics: ImportMetric[], resource: ImportAttributes): unknown {
  const byName = new Map<string, ImportMetric[]>();
  for (const m of metrics) {
    const list = byName.get(m.name);
    if (list) list.push(m);
    else byName.set(m.name, [m]);
  }
  return {
    resourceMetrics: [{
      resource: { attributes: kvList(resource) },
      scopeMetrics: [{
        scope: SCOPE,
        metrics: [...byName.entries()].map(([name, points]) => ({
          name,
          unit: "tokens",
          sum: {
            aggregationTemporality: 1,
            isMonotonic: true,
            dataPoints: points.map((m) => ({
              startTimeUnixNano: m.startTimeUnixNano,
              timeUnixNano: m.timeUnixNano,
              asInt: String(m.asInt),
              attributes: kvList(m.attributes),
            })),
          },
        })),
      }],
    }],
  };
}

/**
 * Deterministic chunking: at most `maxCount` records AND about `maxBytes` of
 * JSON per part. The same records always produce the same parts, which is what
 * lets an interrupted import resume part by part. A single record larger than
 * `maxBytes` still ships alone rather than being dropped.
 */
export function chunkForPost<T>(items: T[], maxCount: number, maxBytes: number): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (batch.length > 0 && (batch.length >= maxCount || bytes + size > maxBytes)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}
