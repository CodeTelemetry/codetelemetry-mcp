import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertKey, looksLikeKey } from "../keys.ts";
import type { WriteResult } from "../settings.ts";
import type { ContentPolicy } from "../import/model.ts";

export type KiroConfig = {kind: "codetelemetry-kiro-v3"; version: 1; enabled: boolean; key: string;
  ingestEndpoint: string; sourceRoot: string; stateDir: string; content: ContentPolicy; backfill: boolean};
export function kiroPaths(home = os.homedir()) {
  return {config: path.join(home, ".config", "codetelemetry", "kiro-v3.json"),
    sourceRoot: path.join(home, ".kiro", "sessions"), stateDir: path.join(home, ".local", "state", "codetelemetry", "kiro-v3"),
    runtimeDir: path.join(home, ".local", "share", "codetelemetry", "kiro-v3")};
}
export function resolveKiroConfigPath(opts: {path?: string; home?: string} = {}): string {
  const file = path.resolve(opts.path ?? kiroPaths(opts.home).config);
  if (file.split(path.sep).includes(".kiro")) throw new Error("CodeTelemetry Kiro config must be outside Kiro's own configuration directory");
  return file;
}
export function readKiroConfig(file: string): KiroConfig {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Kiro collector config is unreadable or exceeds bound");
  let config: KiroConfig;
  try {config = JSON.parse(fs.readFileSync(file, "utf8"));} catch {throw new Error("Kiro collector config is not valid JSON");}
  if (config?.kind !== "codetelemetry-kiro-v3" || config.version !== 1) throw new Error("unsupported Kiro collector config contract");
  assertKey(config.key);
  if (typeof config.enabled !== "boolean" || typeof config.backfill !== "boolean" ||
    typeof config.sourceRoot !== "string" || !path.isAbsolute(config.sourceRoot) || config.sourceRoot.length > 4096 ||
    typeof config.stateDir !== "string" || !path.isAbsolute(config.stateDir) || config.stateDir.length > 4096 ||
    typeof config.content?.prompts !== "boolean" || typeof config.content.toolDetails !== "boolean") throw new Error("invalid Kiro collector config fields");
  let endpoint: URL;
  try {endpoint = new URL(config.ingestEndpoint);} catch {throw new Error("invalid Kiro ingest endpoint");}
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("invalid Kiro ingest endpoint");
  return config;
}
function persistConfig(file: string, config: KiroConfig): void {
  const body = JSON.stringify(config, null, 2) + "\n";
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Kiro collector config exceeds bound");
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {fs.writeFileSync(fd, body); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  try {fs.renameSync(temporary, file);} catch {fs.unlinkSync(temporary); throw new Error("Kiro collector config commit failed");}
}
export function writeKiroConfig(opts: {key: string; ingestEndpoint: string; configPath: string; enrich?: boolean; backup?: boolean}): WriteResult {
  const file = resolveKiroConfigPath({path: opts.configPath});
  const exists = fs.existsSync(file), prior = exists ? readKiroConfig(file) : null;
  const defaults = kiroPaths();
  const config: KiroConfig = {kind: "codetelemetry-kiro-v3", version: 1, enabled: true,
    sourceRoot: prior?.sourceRoot ?? defaults.sourceRoot, stateDir: prior?.stateDir ?? defaults.stateDir,
    backfill: prior?.backfill ?? false, content: opts.enrich ? {prompts: true, toolDetails: true} : prior?.content ?? {prompts: false, toolDetails: false},
    key: assertKey(opts.key), ingestEndpoint: opts.ingestEndpoint};
  const endpoint = new URL(config.ingestEndpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("invalid Kiro ingest endpoint");
  let backupPath: string | null = null;
  if (exists && opts.backup !== false) {backupPath = file + ".previous"; fs.copyFileSync(file, backupPath); fs.chmodSync(backupPath, 0o600);}
  persistConfig(file, config);
  return {path: file, created: !exists, backupPath, wrote: ["key", "ingestEndpoint", "enabled", "sourceRoot", "stateDir", "content", "backfill"]};
}
export function setKiroEnabled(file: string, enabled: boolean): void {
  const config = readKiroConfig(resolveKiroConfigPath({path: file}));
  persistConfig(file, {...config, enabled});
}
export function readKiroKey(file: string): string | null {try {return readKiroConfig(file).key;} catch {return null;}}
export function readKiroSummary(file: string) {
  const exists = fs.existsSync(file);
  try {const config = readKiroConfig(file); return {exists, otelKeys: ["ingestEndpoint", "content", "sourceRoot"], hasKey: looksLikeKey(config.key), collectorEnabled: config.enabled};}
  catch {return {exists, otelKeys: [], hasKey: false, collectorEnabled: false};}
}
