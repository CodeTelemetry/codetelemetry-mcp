import { claimKiroState } from "./state.ts";
import { kiroPaths, readKiroConfig, resolveKiroConfigPath, setKiroEnabled } from "./config.ts";
import { collectorUnitPath, installCollectorRuntime, ownedCollectorUnit, removeCollectorUnit, renderCollectorService,
  startCollectorService, stopCollectorService, writeCollectorUnit, type CollectorServiceSpec } from "../collector/service.ts";

// The service mechanics are shared with the other collectors. Kiro's unit
// pins the installing Node.js binary and keeps its released behaviour.
const KIRO_SERVICE: CollectorServiceSpec = {marker: "CodeTelemetry Kiro V3 collector v1", linuxName: "codetelemetry-kiro-v3.service",
  macName: "com.codetelemetry.kiro-v3", description: "CodeTelemetry Kiro V3 telemetry", label: "Kiro", legacy: true};
export type KiroServiceOptions = {home?: string; platform?: NodeJS.Platform; node?: string;
  execute?: (command: string, args: string[]) => string; runtimeSource?: string; extension?: ".ts" | ".js"};
export function renderKiroService(platform: NodeJS.Platform, node: string, entry: string, config: string): string {
  return renderCollectorService(KIRO_SERVICE, platform, {program: node, args: [entry, {literal: "kiro"}, {literal: "collect"}, {literal: "--settings"}, config]});
}

export async function enableKiroService(configPath: string, opts: KiroServiceOptions = {}): Promise<{ok: boolean; detail: string}> {
  const file = resolveKiroConfigPath({path: configPath}); readKiroConfig(file);
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Kiro collection requires Node 24 or newer");
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return {ok: false, detail: "Background setup supports Linux/macOS; use kiro collect for a foreground collector."};
  const runtimeDir = kiroPaths(opts.home).runtimeDir;
  const release = await claimKiroState(runtimeDir);
  try {
    const runtime = installCollectorRuntime(KIRO_SERVICE, {runtimeDir, runtimeSource: opts.runtimeSource, extension: opts.extension});
    writeCollectorUnit(KIRO_SERVICE, opts, renderKiroService(platform, opts.node ?? process.execPath, runtime.entry, file));
    setKiroEnabled(file, true);
    try {
      startCollectorService(KIRO_SERVICE, opts);
      return {ok: true, detail: "Kiro background collector service enabled. Check kiro status for source coverage and delivery health."};
    } catch {return {ok: false, detail: "Kiro service manager could not start collection. Config is preserved; run kiro collect in a foreground process or repair the user service."};}
  } finally {await release();}
}
export function disableKiroService(configPath: string, opts: KiroServiceOptions = {}): {ok: boolean; detail: string} {
  const file = resolveKiroConfigPath({path: configPath}); setKiroEnabled(file, false);
  if (ownedCollectorUnit(KIRO_SERVICE, collectorUnitPath(KIRO_SERVICE, opts))) {
    try {stopCollectorService(KIRO_SERVICE, opts);}
    catch {return {ok: false, detail: "Collection disabled in config; service manager stop could not be confirmed."};}
  }
  return {ok: true, detail: "Kiro collection disabled; acknowledged checkpoints and any pending envelope are preserved."};
}
export function uninstallKiroService(configPath: string, opts: KiroServiceOptions = {}) {
  const result = disableKiroService(configPath, opts);
  if (!result.ok) return result;
  removeCollectorUnit(KIRO_SERVICE, opts);
  return {ok: true, detail: "Kiro service uninstalled. Private config, bounded runtime and recovery state are preserved for deliberate recovery or removal."};
}
