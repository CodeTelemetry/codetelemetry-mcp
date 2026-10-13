// Write the OTEL exporter config into Claude Code's settings.json `env` block.
// This is the step a browser can't do. It is deliberately conservative: it
// preserves every key it didn't set, backs the file up before overwriting, and
// writes 0600 because the file now holds an ingest key.

import fs from "node:fs";
import path from "node:path";
import { assertKey } from "./keys.ts";
import {
  installRepositoryObservationHook,
  removeRepositoryObservationFiles,
  removeRepositoryObservationHook,
} from "./repositoryHook.ts";

export type EnvBlock = Record<string, string>;

/** The six base vars that turn on telemetry + point it at the ingest endpoint. */
export function baseEnv(key: string, ingestEndpoint: string): EnvBlock {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: ingestEndpoint,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${key}`,
  };
}

/** The opt-in flags that unlock the richer dashboards (prompt text, bodies, …).
 *  NO OTEL_RESOURCE_ATTRIBUTES here: Claude Code passes settings.json `env`
 *  values verbatim (no shell expansion) AND settings env overrides the shell
 *  environment — so a `project.path=$PWD` entry both declares the literal
 *  string `$PWD` as the repo and clobbers a correctly-expanded value exported
 *  by a launch wrapper. Repo attribution must come from a real shell export at
 *  launch time (where $PWD expands); absent that, the dashboards fall back to
 *  anchored repo inference. */
export function enrichEnv(): EnvBlock {
  return {
    OTEL_METRICS_INCLUDE_SESSION_ID: "true",
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_TOOL_CONTENT: "1",
    OTEL_LOG_RAW_API_BODIES: "1",
  };
}

/** The exact broken value earlier releases of this writer put in settings.json
 *  (unexpanded, so every event declared the literal `$PWD` as its repo). */
export const LEGACY_BROKEN_RESOURCE_ATTRS = "project.path=$PWD";

export function buildEnvBlock(key: string, ingestEndpoint: string, enrich: boolean): EnvBlock {
  const base = baseEnv(key, ingestEndpoint);
  return enrich ? { ...base, ...enrichEnv() } : base;
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
    // Don't clobber a file we can't understand — surface it so the user can fix
    // it (or pass a clean path). settings.json is strict JSON: no comments.
    throw new Error(
      `refusing to overwrite ${filePath}: it isn't valid JSON (${(err as Error).message}). ` +
        `Fix or move it, then retry.`,
    );
  }
}

/** Merge an env block into a settings object, preserving everything else.
 *  One deliberate exception to "preserve": the exact broken
 *  OTEL_RESOURCE_ATTRIBUTES value this writer itself used to emit is scrubbed,
 *  so re-running connect repairs a poisoned install. A user's own (different)
 *  value is never touched. */
export function mergeSettings(existing: SettingsObject, env: EnvBlock): SettingsObject {
  const prevEnv =
    existing.env && typeof existing.env === "object" && !Array.isArray(existing.env)
      ? { ...(existing.env as Record<string, string>) }
      : {};
  if (prevEnv.OTEL_RESOURCE_ATTRIBUTES === LEGACY_BROKEN_RESOURCE_ATTRS) {
    delete prevEnv.OTEL_RESOURCE_ATTRIBUTES;
  }
  return { ...existing, env: { ...prevEnv, ...env } };
}

export type WriteResult = {
  path: string;
  /** Env KEYS written (never values — values include the secret). */
  wrote: string[];
  backupPath: string | null;
  created: boolean;
};

export type WriteOptions = {
  key: string;
  ingestEndpoint: string;
  settingsPath: string;
  enrich?: boolean;
  /** Install lifecycle/tool hooks that send repository/workspace metadata (default false). */
  repositoryObservation?: boolean;
  /** Back up an existing file to settings.json.bak before overwriting (default true). */
  backup?: boolean;
};

export function writeSettings(opts: WriteOptions): WriteResult {
  const key = assertKey(opts.key);
  const env = buildEnvBlock(key, opts.ingestEndpoint, !!opts.enrich);
  const filePath = path.resolve(opts.settingsPath);

  const existed = fs.existsSync(filePath);
  const existing = readJson(filePath);
  const envMerged = mergeSettings(existing, env);
  // Repository observation transmits absolute local paths, so installing its
  // lifecycle/tool hooks requires a separate explicit opt-in from content
  // enrichment. Disabling removes only this package's managed hook entries.
  const merged = opts.repositoryObservation
    ? installRepositoryObservationHook(envMerged, filePath)
    : removeRepositoryObservationHook(envMerged);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let backupPath: string | null = null;
  if (existed && opts.backup !== false) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // copyFileSync preserves the source mode on the .bak; that's fine (same secret-
  // bearing file). Ensure the live file is 0600 even if it pre-existed as 0644.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort (e.g. non-POSIX fs) */
  }

  if (!opts.repositoryObservation) removeRepositoryObservationFiles(filePath);

  return { path: filePath, wrote: Object.keys(env), backupPath, created: !existed };
}

/** Read back the OTEL-relevant env keys (for `status`/`doctor`). No secret values. */
export function readSettingsSummary(filePath: string): { exists: boolean; otelKeys: string[]; hasKey: boolean } {
  if (!fs.existsSync(filePath)) return { exists: false, otelKeys: [], hasKey: false };
  let obj: SettingsObject;
  try {
    obj = readJson(filePath);
  } catch {
    return { exists: true, otelKeys: [], hasKey: false };
  }
  const env =
    obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)
      ? (obj.env as Record<string, string>)
      : {};
  const otelKeys = Object.keys(env).filter((k) => k.startsWith("OTEL_") || k === "CLAUDE_CODE_ENABLE_TELEMETRY");
  const hasKey = typeof env.OTEL_EXPORTER_OTLP_HEADERS === "string" && env.OTEL_EXPORTER_OTLP_HEADERS.includes("cot_");
  return { exists: true, otelKeys, hasKey };
}
