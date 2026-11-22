// `codetelemetry-connect public-sessions …`: read public sessions with no
// sign-in, key or local configuration. Never reads or sends an ingest key.
import { resolveEndpoints } from "./config.ts";
import type { FetchLike } from "./otlp.ts";
import { getPublicSession, listPublicSessions, readPublicSessionEvents, type PublicReadResult } from "./publicSessions.ts";

export const PUBLIC_SESSIONS_HELP = `public-sessions (no sign-in needed):
  codetelemetry-connect public-sessions list [--json]
                         CodeTelemetry's public sample sessions.
  codetelemetry-connect public-sessions show <id> [--json]
                         One sample id or a pub_… id an owner shared.
  codetelemetry-connect public-sessions events <id> [--position N] [--limit N]
                         [--kinds prompt,model,tool] [--cursor C] [--outcome failed|succeeded|not_recorded]
                         [--json]   A page of recorded events (max 50).
  --api-base <url>       Where public sessions are read (default: https://codetelemetry.com)`;

type Flags = Record<string, string | boolean>;
const ALLOWED = new Set(["json", "api-base", "position", "limit", "kinds", "cursor", "outcome"]);

function integerFlag(flags: Flags, name: string): number | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) throw new Error(`--${name} takes a non-negative integer.`);
  return Number(value);
}

function failure(result: PublicReadResult): string {
  if (result.httpStatus === 404) return "No public session has this id.";
  if (result.httpStatus === 429) return "Too many public session reads from this address; retry in a minute.";
  return result.message ?? (result.httpStatus ? `Public session read returned HTTP ${result.httpStatus}.` : "Public session read failed.");
}

const text = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : "";
const oneLine = (value: unknown, max = 160) => { const flat = text(value).replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

export async function runPublicSessionsCommand(args: string[], flags: Flags, out: (line: string) => void, fetchImpl?: FetchLike): Promise<number> {
  const rogue = Object.keys(flags).find((key) => !ALLOWED.has(key));
  if (rogue) throw new Error(`Unknown public-sessions option --${rogue}.`);
  if (flags["api-base"] !== undefined && typeof flags["api-base"] !== "string") throw new Error("--api-base takes a URL.");
  const apiBase = resolveEndpoints({ apiBase: flags["api-base"] as string | undefined }).apiBase;
  const json = flags.json === true;
  const [sub, id] = args;

  if (sub === "list") {
    const result = await listPublicSessions({ apiBase, fetchImpl });
    if (!result.ok || !result.value) { out(failure(result)); return 1; }
    if (json) { out(JSON.stringify(result.value, null, 2)); return 0; }
    const sessions = Array.isArray(result.value.sessions) ? result.value.sessions as Record<string, unknown>[] : [];
    for (const session of sessions) {
      out(`${text(session.id)}  ${oneLine(session.title, 70)}  · ${text(session.repo)} · ${Number(session.eventCount) || 0} events`);
    }
    out(`${sessions.length} sample sessions. Read one: codetelemetry-connect public-sessions events <id>`);
    return 0;
  }

  if ((sub === "show" || sub === "events") && !id) throw new Error(`Use public-sessions ${sub} <id>.`);

  if (sub === "show") {
    const result = await getPublicSession({ apiBase, id, fetchImpl });
    if (!result.ok || !result.value) { out(failure(result)); return 1; }
    if (json) { out(JSON.stringify(result.value, null, 2)); return 0; }
    const v = result.value;
    out(`${text(v.id)} (${text(v.kind)})`);
    if (v.title) out(`  ${oneLine(v.title)}`);
    if (v.repo) out(`  repo: ${text(v.repo)}`);
    if (v.service) out(`  service: ${text(v.service)}`);
    if (v.publishedAt) out(`  published: ${text(v.publishedAt)}`);
    if (v.state) out(`  state: ${text(v.state)}`);
    if (v.eventCount !== undefined) out(`  events: ${Number(v.eventCount) || 0}`);
    out(`  ${oneLine(v.dataNotice, 400)}`);
    return 0;
  }

  if (sub === "events") {
    const input: Record<string, unknown> = {};
    const position = integerFlag(flags, "position");
    const limit = integerFlag(flags, "limit");
    if (position !== undefined) input.position = position;
    if (limit !== undefined) input.limit = limit;
    if (flags.kinds !== undefined) {
      if (typeof flags.kinds !== "string") throw new Error("--kinds takes a comma-separated list of prompt, model, tool.");
      input.kinds = flags.kinds.split(",").filter(Boolean);
    }
    for (const name of ["cursor", "outcome"]) {
      if (flags[name] === undefined) continue;
      if (typeof flags[name] !== "string") throw new Error(`--${name} takes a value.`);
      input[name] = flags[name];
    }
    const result = await readPublicSessionEvents({ apiBase, id, input, fetchImpl });
    if (!result.ok || !result.value) { out(failure(result)); return 1; }
    if (json) { out(JSON.stringify(result.value, null, 2)); return 0; }
    const v = result.value;
    if (typeof v.state === "string" && v.state !== "ready") { out(`${text(v.state)}: ${oneLine(v.message, 400)}`); return 0; }
    const events = Array.isArray(v.events) ? v.events as Record<string, unknown>[] : [];
    for (const event of events) {
      const outcome = event.ok === false || event.outcome === "failed" ? " ✗" : "";
      out(`#${Number(event.position)} ${text(event.ts ?? event.time)} ${text(event.kind)} ${oneLine(event.label ?? event.name, 40)}${outcome}  ${oneLine(event.detail ?? event.text ?? event.preview)}`);
    }
    if (typeof v.nextPosition === "number") out(`More: --position ${v.nextPosition}`);
    if (typeof v.nextCursor === "string") out(`More: --cursor ${v.nextCursor}`);
    out(oneLine(v.dataNotice, 400));
    return 0;
  }

  throw new Error("Use public-sessions list, show <id> or events <id>.");
}
