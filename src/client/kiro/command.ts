import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { KiroCollector } from "./collector.ts";
import { readKiroConfig, resolveKiroConfigPath } from "./config.ts";
import { kiroTransport } from "./transport.ts";
import { readBoundedJson, writeAtomicJson } from "./state.ts";
import { enableKiroService, disableKiroService, uninstallKiroService } from "./service.ts";

type Flags = Record<string, string | boolean | undefined>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function runKiroCommand(args: string[], flags: Flags, out: (line: string) => void): Promise<number> {
  const operation = args[0] ?? "status";
  if (args.length > 1 || !["collect", "status", "enable", "disable", "uninstall"].includes(operation)) {
    out("Usage: codetelemetry-connect kiro status|collect|enable|disable|uninstall [--settings <path>] [--json]; collect supports --once."); return 1;
  }
  const rogue = Object.keys(flags).find(key => !["settings", "json", "once"].includes(key));
  if (rogue || (flags.settings !== undefined && typeof flags.settings !== "string") ||
    ["json", "once"].some(key => flags[key] !== undefined && typeof flags[key] !== "boolean") ||
    (flags.once !== undefined && operation !== "collect")) {out("Invalid Kiro command options."); return 1;}
  const file = resolveKiroConfigPath({path: typeof flags.settings === "string" ? flags.settings : undefined});
  if (operation === "enable" || operation === "disable" || operation === "uninstall") {
    const result = operation === "enable" ? await enableKiroService(file)
      : operation === "disable" ? disableKiroService(file) : uninstallKiroService(file);
    out(flags.json ? JSON.stringify(result) : result.detail); return result.ok ? 0 : 1;
  }
  const config = readKiroConfig(file);
  if (operation === "status") {
    const raw = await readBoundedJson(path.join(config.stateDir, "health.json"), 16 * 1024) as Record<string,unknown>|null;
    // Health is a fixed metadata contract, never an arbitrary JSON diagnostic.
    const fields=["version","trackedSessions","parkedSessions","skippingOversizeSessions","cachedTailBytes","cachedTailSessions","carryEvictions","discoveryBacklog","backloggedSessions","unsupportedSessions","sourceConflicts","sourceErrors","ignoredRecords","malformedRecords","duplicateRecords","evictedCalls","missingCalls","unsupportedToolDetails","discoveryOverflow","oversizeRecords","readBytes","logsAcknowledged","requests","lastTickAt","pid"];
    const health = raw ? Object.fromEntries(fields.filter(key=>Number.isSafeInteger(raw[key]) && Number(raw[key])>=0).map(key=>[key,raw[key]])) : null;
    if(health && raw) {health.status=["idle","pending","ok","retry","auth","budget","rejected","retry_horizon_exhausted","clock_rollback","capacity"].includes(String(raw.status)) ? raw.status : "unknown";health.pending=raw.pending===true;}
    let running=false;
    if(raw?.running===true && health && Number(health.pid)>0 && Date.now()-Number(health.lastTickAt)>=0 && Date.now()-Number(health.lastTickAt)<30000) {try {process.kill(Number(health.pid),0);running=true;} catch {}}
    const value = {running,enabled: config.enabled, capture: config.content.prompts || config.content.toolDetails ? "content opt-in" : "metadata-only", health};
    out(JSON.stringify(value, null, flags.json ? undefined : 2)); return 0;
  }
  if (Number(process.versions.node.split(".")[0]) < 24) {out("Kiro collection requires Node 24 or newer.");return 1;}
  if (!config.enabled) {out("Kiro collection is disabled. Run kiro enable to start it."); return 1;}
  const binding = digest([config.key, config.ingestEndpoint]);
  const fingerprint = digest(config);
  const collector = new KiroCollector({sourceRoot:config.sourceRoot,stateDir:config.stateDir,destinationHash:binding,
    policy:config.content,bootstrap:config.backfill ? "start" : "end",post:kiroTransport({endpoint:config.ingestEndpoint,key:config.key})});
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let exit = 0, opened = false;
  try {
    await collector.open(); opened = true;
    do {
      const current = readKiroConfig(file);
      if (!current.enabled) break;
      // A new destination or content policy requires a fresh process; pending
      // delivery remains bound to its original identity and is never retargeted.
      if (digest(current) !== fingerprint) {out("Kiro configuration changed; restart required, recovery state preserved."); exit=1; break;}
      let health = await collector.tick();
      if (flags.once && health.pending) health = await collector.tick();
      await writeAtomicJson(path.join(config.stateDir,"health.json"),{...health,running:!flags.once,pid:process.pid},16*1024);
      if (flags.once) {
        out(JSON.stringify(health));
        exit = health.status === "capacity" || health.pending || health.sourceConflicts || health.sourceErrors || health.unsupportedSessions || health.discoveryOverflow || health.discoveryBacklog || health.backloggedSessions ? 1 : 0;
        break;
      }
      await delay(1000, undefined, {signal:abort.signal}).catch(error=>{if (!abort.signal.aborted) throw error;});
    } while (!abort.signal.aborted);
  } finally {
    try {
      if(opened) await writeAtomicJson(path.join(config.stateDir,"health.json"),{...collector.snapshot(),running:false,pid:process.pid},16*1024);
    } finally {
      try {await collector.close();} finally {process.off("SIGINT",stop);process.off("SIGTERM",stop);}
    }
  }
  return exit;
}
