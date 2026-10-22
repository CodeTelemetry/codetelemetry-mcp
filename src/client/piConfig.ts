// Write the OTEL exporter config into pi's settings.json `otel` block
// (~/.pi/agent/settings.json globally, or <project>/.pi/settings.json via an
// explicit path). Same discipline as the Claude writer (settings.ts): keep every
// key it doesn't set, back the file up, write 0600 (the file then holds an
// ingest key), and refuse to overwrite a file that isn't valid JSON.
//
// The block's shape follows the pi-otel extension's source (checked for #384,
// github.com/NikiforovAll/pi-otel src/config.ts + otel/sdk.ts):
//  - settings come from `<cwd>/.pi/settings.json` merged over
//    `~/.pi/agent/settings.json`, key `otel`;
//  - `protocol: "http"` means http/protobuf;
//  - `headers` is passed verbatim to the exporters, so
//    `{ "Authorization": "Bearer cot_…" }` is the whole auth story;
//  - the endpoint URL is used VERBATIM: pi-otel appends no OTLP signal path and
//    hands the same URL to every enabled signal. So the endpoint is the full
//    `…/v1/traces` URL and the other signals stay off. Nothing is lost: pi's
//    metrics carry no session id and its logs are session start/end markers;
//    the spans are the whole product surface (schema/112 derives rows from them);
//  - `captureContent`: "metadata_only" (pi-otel's default) | "no_tool_content" |
//    "full". `enrich` asks for "full" and stays opt-in, like every other client;
//  - the explicit port satisfies pi's `/otel` doctor probe, which refuses to
//    assume a default port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertKey } from "./keys.ts";

export function resolvePiConfigPath(opts: { path?: string } = {}): string {
  if (opts.path) return path.resolve(opts.path);
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

/** The full traces URL pi-otel posts to: the ingest endpoint with an explicit
 *  port and its own base path kept (a gateway mounted under `/otel` stays under
 *  it), plus `/v1/traces`, exactly as the other clients append their signal
 *  paths to the endpoint they are given. */
export function piTracesEndpoint(ingestEndpoint: string): string {
  const url = new URL(ingestEndpoint);
  const port = url.port || (url.protocol === "http:" ? "80" : "443");
  const base = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname}:${port}${base}/v1/traces`;
}

/** The traces-only exporter block pi-otel reads. */
export function buildPiOtelBlock(key: string, ingestEndpoint: string, enrich: boolean): Record<string, unknown> {
  return {
    enabled: true,
    endpoint: piTracesEndpoint(ingestEndpoint),
    protocol: "http",
    headers: { Authorization: `Bearer ${key}` },
    serviceName: "pi",
    signals: { traces: true, metrics: false, logs: false },
    ...(enrich ? { captureContent: "full" } : {}),
  };
}

type SettingsObject = Record<string, unknown>;

function readJson(filePath: string): SettingsObject {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SettingsObject;
    throw new Error("settings.json is not a JSON object");
  } catch (err) {
    throw new Error(
      `refusing to overwrite ${filePath}: it isn't valid JSON (${(err as Error).message}). Fix or move it, then retry.`,
    );
  }
}

/** Merge the otel block into pi's settings, keeping everything else, including
 *  `otel` keys this writer doesn't manage (sampleRatio, logLevel, a user's own
 *  captureContent when enrich isn't requested). */
export function mergePiSettings(existing: SettingsObject, otel: Record<string, unknown>): SettingsObject {
  const previous = existing.otel && typeof existing.otel === "object" && !Array.isArray(existing.otel)
    ? { ...(existing.otel as Record<string, unknown>) }
    : {};
  return { ...existing, otel: { ...previous, ...otel } };
}

export type PiWriteResult = {
  path: string;
  /** otel KEYS written (never values: headers carry the secret). */
  wrote: string[];
  backupPath: string | null;
  created: boolean;
};

export type PiWriteOptions = {
  key: string;
  ingestEndpoint: string;
  configPath: string;
  enrich?: boolean;
  backup?: boolean;
};

export function writePiConfig(opts: PiWriteOptions): PiWriteResult {
  const key = assertKey(opts.key);
  const otel = buildPiOtelBlock(key, opts.ingestEndpoint, !!opts.enrich);
  const filePath = path.resolve(opts.configPath);
  const existed = fs.existsSync(filePath);
  const merged = mergePiSettings(readJson(filePath), otel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath: string | null = null;
  if (existed && opts.backup !== false) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
    // A rerun's source already holds a key, and copyFileSync onto an existing
    // .bak keeps the destination's old mode: pin it owner-only like the file.
    try {
      fs.chmodSync(backupPath, 0o600);
    } catch {
      /* best effort (non-POSIX file systems) */
    }
  }
  fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort (non-POSIX file systems) */
  }
  return { path: filePath, wrote: Object.keys(otel), backupPath, created: !existed };
}

/** The configured ingest key in pi's otel headers (doctor, status). */
export function readPiKey(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const headers = JSON.parse(fs.readFileSync(filePath, "utf8"))?.otel?.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
    for (const value of Object.values(headers as Record<string, unknown>)) {
      const match = typeof value === "string" ? /Bearer\s+(cot_[A-Za-z0-9_-]+)/.exec(value) : null;
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** The otel block's state, without secret values. `extensionInstalled` is a
 *  best-effort check for pi-otel among the packages pi records (`pi install`
 *  writes them to settings.json); without it no span is exported, but the
 *  config may be written first. */
export function readPiSummary(filePath: string): {
  exists: boolean;
  otelKeys: string[];
  hasKey: boolean;
  extensionInstalled: boolean;
} {
  if (!fs.existsSync(filePath)) return { exists: false, otelKeys: [], hasKey: false, extensionInstalled: false };
  let parsed: SettingsObject;
  try {
    parsed = readJson(filePath);
  } catch {
    return { exists: true, otelKeys: [], hasKey: false, extensionInstalled: false };
  }
  const otel = parsed.otel && typeof parsed.otel === "object" && !Array.isArray(parsed.otel)
    ? (parsed.otel as Record<string, unknown>)
    : {};
  const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
  return {
    exists: true,
    otelKeys: Object.keys(otel),
    hasKey: readPiKey(filePath) !== null,
    extensionInstalled: packages.some((entry) => typeof entry === "string" && /(^|[:/])pi-otel(@|$)/.test(entry)),
  };
}
