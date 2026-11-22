// Synthetic local history for the estimate / billing / identity tests: small
// Claude Code transcripts and Codex rollouts with chosen timestamps and token
// counts. Never real history.
import fs from "node:fs";
import path from "node:path";

export type FakeCall = { ts: number; model?: string; input: number; output: number; cacheRead?: number; cacheCreation?: number };

const iso = (ms: number) => new Date(ms).toISOString();

export function claudeTranscript(sessionId: string, calls: FakeCall[], cwd = "/work/est", tools: Array<{ ts: number; name: string; input: unknown }> = []): string {
  const lines: unknown[] = [{
    type: "user", promptId: `${sessionId}-p1`, message: { role: "user", content: "estimate this" },
    uuid: `${sessionId}-u0`, timestamp: iso(calls[0].ts - 1_000), cwd, sessionId,
  }];
  calls.forEach((c, i) => lines.push({
    type: "assistant", requestId: `${sessionId}-r${i}`, uuid: `${sessionId}-a${i}`, timestamp: iso(c.ts), cwd, sessionId,
    message: {
      model: c.model ?? "claude-opus-4-8", id: `${sessionId}-m${i}`, role: "assistant",
      content: i === 0 ? tools.map((t, j) => ({ type: "tool_use", id: `${sessionId}-t${j}`, name: t.name, input: t.input })) : [{ type: "text", text: "ok" }],
      usage: { input_tokens: c.input, output_tokens: c.output, cache_read_input_tokens: c.cacheRead ?? 0, cache_creation_input_tokens: c.cacheCreation ?? 0 },
    },
  }));
  tools.forEach((t, j) => lines.push({
    type: "user", uuid: `${sessionId}-r${j}`, timestamp: iso(t.ts), cwd, sessionId,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${sessionId}-t${j}`, content: "ok" }] },
  }));
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export function codexRollout(id: string, calls: Array<{ ts: number; input: number; cached: number; output: number }>, tools: Array<{ ts: number; arguments: string }> = []): string {
  const lines: unknown[] = [
    { timestamp: iso(calls[0].ts - 2_000), type: "session_meta", payload: { id, cwd: "/work/est" } },
    { timestamp: iso(calls[0].ts - 2_000), type: "turn_context", payload: { model: "gpt-5.1-codex", cwd: "/work/est" } },
    { timestamp: iso(calls[0].ts - 1_000), type: "event_msg", payload: { type: "user_message", message: "estimate codex" } },
  ];
  calls.forEach((c, i) => lines.push({
    timestamp: iso(c.ts), type: "token_usage_record",
    payload: { response_id: `${id}-resp${i}`, usage: { input_tokens: c.input, cached_input_tokens: c.cached, output_tokens: c.output } },
  }));
  tools.forEach((t, j) => {
    lines.push({ timestamp: iso(t.ts - 1), type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: `${id}-c${j}`, arguments: t.arguments } });
    lines.push({ timestamp: iso(t.ts), type: "response_item", payload: { type: "function_call_output", call_id: `${id}-c${j}`, output: "done" } });
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Write a file and set its mtime (the importer's cheap window filter). */
export function put(file: string, text: string, mtimeMs: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

export const codexPath = (sessionsDir: string, id: string, ms: number): string => {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return path.join(sessionsDir, y, m, day, `rollout-${y}-${m}-${day}T09-00-00-${id}.jsonl`);
};

/** An unsigned JWT with this payload (Codex id_token shape; never verified). */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJl`;
}
