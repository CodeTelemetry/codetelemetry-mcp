// In-memory fake of the two server surfaces the history importer talks to
// (OTLP ingest + /api/agent/import-status). Shared by the CLI and browser tests.
import assert from "node:assert/strict";

export const KEY = "cot_importimportimportimport0001";
export const NOW = Date.parse("2026-10-10T12:00:00Z");
export const API = "https://api.example.test";
export const INGEST = "https://ingest.example.test";
export const CLAUDE_SID = "cs-test-1";

type Row = { sid: string; plan: string; part: string; marker: boolean; attrs: Record<string, unknown>; resource: Record<string, unknown> };
type MetricRow = { sid: string; plan: string; part: string; value: number; resource: Record<string, unknown> };
export type Fault = "ok" | "402" | "429" | "503busy" | "502" | "store-then-timeout" | "network";

const flat = (kvs: any[] = []): Record<string, unknown> =>
  Object.fromEntries(kvs.map((kv) => [kv.key, kv.value.stringValue ?? kv.value.intValue ?? kv.value.boolValue ?? kv.value.doubleValue]));

export class FakeServer {
  logs: Row[] = [];
  metrics: MetricRow[] = [];
  live = new Set<string>();
  statusCalls: any[] = [];
  ingestCalls: Array<{ path: string; part: string }> = [];
  statusFault: number | null = null;
  /** Decide the fate of an ingest request (by path + part label). */
  fault: (path: string, part: string, attempt: number) => Fault = () => "ok";
  #attempts = new Map<string, number>();

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
    const body = JSON.parse(String(init?.body));
    if (u.origin === API && u.pathname === "/api/agent/import-status") {
      this.statusCalls.push(body);
      if (this.statusFault) return new Response(JSON.stringify({ error: "x" }), { status: this.statusFault });
      return Response.json({ ok: true, sessions: body.sessions.map((s: any) => this.status(s)), settleMs: 300_000, nowMs: NOW });
    }
    assert.equal(u.origin, INGEST);
    const resource = flat((body.resourceLogs ?? body.resourceMetrics)[0].resource.attributes);
    const part = String(resource["import.part"]);
    this.ingestCalls.push({ path: u.pathname, part });
    const k = `${u.pathname}:${resource["import.plan"]}:${part}`;
    const attempt = (this.#attempts.get(k) ?? 0) + 1;
    this.#attempts.set(k, attempt);
    const fault = this.fault(u.pathname, part, attempt);
    if (fault === "network") throw new TypeError("fetch failed");
    if (fault === "402") return Response.json({ error: "credit exhausted; add credits or seats", topup: "https://codetelemetry.com/billing" }, { status: 402 });
    if (fault === "429") return Response.json({ error: "rate limit exceeded" }, { status: 429 });
    if (fault === "503busy") return Response.json({ error: "OTLP scope capacity busy; retry" }, { status: 503 });
    if (fault === "502") return Response.json({ error: "upstream collector error; retry" }, { status: 502 });
    this.store(u.pathname, body, resource);
    if (fault === "store-then-timeout") throw new DOMException("aborted", "AbortError");
    return new Response("{}", { status: 200 });
  };

  store(pathname: string, body: any, resource: Record<string, unknown>) {
    const plan = String(resource["import.plan"]);
    const part = String(resource["import.part"]);
    if (pathname === "/v1/logs") {
      for (const r of body.resourceLogs[0].scopeLogs[0].logRecords) {
        const attrs = flat(r.attributes);
        this.logs.push({
          sid: String(attrs["session.id"] ?? attrs["conversation.id"]), plan, part,
          marker: attrs["event.name"] === "import.session_complete", attrs, resource,
        });
      }
    } else {
      for (const m of body.resourceMetrics[0].scopeMetrics[0].metrics) {
        for (const p of m.sum.dataPoints) {
          this.metrics.push({ sid: String(flat(p.attributes)["session.id"]), plan, part, value: Number(p.asInt), resource });
        }
      }
    }
  }

  status(s: { sessionId: string; probePlan?: string }) {
    const rows = this.logs.filter((r) => r.sid === s.sessionId);
    const plans = new Map<string, { plan: string; complete: boolean; logParts: string[]; metricParts?: string[]; lastArrivalMs: number }>();
    for (const r of rows) {
      const p = plans.get(r.plan) ?? { plan: r.plan, complete: false, logParts: [], lastArrivalMs: NOW - 3_600_000 };
      if (r.marker) p.complete = true;
      if (!p.logParts.includes(r.part)) p.logParts.push(r.part);
      plans.set(r.plan, p);
    }
    if (s.probePlan) {
      const metricParts = [...new Set(this.metrics.filter((m) => m.sid === s.sessionId && m.plan === s.probePlan).map((m) => m.part))];
      const p = plans.get(s.probePlan) ?? { plan: s.probePlan, complete: false, logParts: [], lastArrivalMs: 0 };
      p.metricParts = metricParts;
      plans.set(s.probePlan, p);
    }
    return { sessionId: s.sessionId, live: this.live.has(s.sessionId), plans: [...plans.values()] };
  }

  tokenTotal(sid = CLAUDE_SID) {
    return this.metrics.filter((m) => m.sid === sid).reduce((n, m) => n + m.value, 0);
  }
}

