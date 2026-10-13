// Fire one synthetic OTLP log so onboarding can prove the pipe works end to end
// before the user starts a real session. We send OTLP/HTTP in its JSON encoding
// (content-type application/json) — the collector's OTLP receiver accepts JSON,
// and it saves us a protobuf dependency. The record carries a unique
// `codetelemetry.probe.id` the connectivity check matches on.
//
// Note: the *settings.json* exporter uses http/protobuf (that's Claude Code's
// real telemetry path); this JSON event is just our one-off connectivity probe.

import { randomUUID } from "node:crypto";
import { assertKey } from "./keys.ts";

export type FetchLike = typeof fetch;

export const PROBE_ATTR = "codetelemetry.probe.id";
export const PROBE_EVENT = "codetelemetry_probe";
export const PROBE_SERVICE = "codetelemetry-connect";

/** Build the OTLP/HTTP JSON body for a single probe log record. */
export function buildProbeLog(probeId: string, nowMs: number = Date.now()): unknown {
  const nano = String(BigInt(Math.floor(nowMs)) * 1_000_000n);
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: PROBE_SERVICE } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: PROBE_SERVICE },
            logRecords: [
              {
                timeUnixNano: nano,
                observedTimeUnixNano: nano,
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: "CodeTelemetry onboarding connectivity probe" },
                attributes: [
                  { key: "event.name", value: { stringValue: PROBE_EVENT } },
                  { key: PROBE_ATTR, value: { stringValue: probeId } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

export type SendTestResult = {
  probeId: string;
  httpStatus: number;
  ok: boolean;
};

export type SendTestOptions = {
  key: string;
  ingestEndpoint: string;
  probeId?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/** POST the probe log to `${ingestEndpoint}/v1/logs` with the ingest key. */
export async function sendTestEvent(opts: SendTestOptions): Promise<SendTestResult> {
  const key = assertKey(opts.key);
  const probeId = opts.probeId ?? randomUUID();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.ingestEndpoint.replace(/\/$/, "")}/v1/logs`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(buildProbeLog(probeId)),
      signal: ac.signal,
    });
    return { probeId, httpStatus: res.status, ok: res.status >= 200 && res.status < 300 };
  } finally {
    clearTimeout(timer);
  }
}
