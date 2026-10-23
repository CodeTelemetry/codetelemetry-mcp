import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { claimKiroState } from "./state.ts";
import { kiroPaths, readKiroConfig, resolveKiroConfigPath, setKiroEnabled } from "./config.ts";

const MARKER = "CodeTelemetry Kiro V3 collector v1";
const LINUX_NAME = "codetelemetry-kiro-v3.service";
const MAC_NAME = "com.codetelemetry.kiro-v3";
export type KiroServiceOptions = {home?: string; platform?: NodeJS.Platform; node?: string;
  execute?: (command: string, args: string[]) => string; runtimeSource?: string; extension?: ".ts" | ".js"};
const command = (command: string, args: string[]) => execFileSync(command, args, {encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"]});
const safePath = (value: string) => {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.length > 4096) throw new Error("invalid Kiro service path");
  return value;
};
const systemdArg = (value: string) => `"${safePath(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$")}"`;
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function renderKiroService(platform: NodeJS.Platform, node: string, entry: string, config: string): string {
  [node, entry, config].forEach(safePath);
  if (platform === "linux") return `# ${MARKER}\n[Unit]\nDescription=CodeTelemetry Kiro V3 telemetry\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${systemdArg(node)} ${systemdArg(entry)} kiro collect --settings ${systemdArg(config)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${MARKER} -->\n<plist version="1.0"><dict><key>Label</key><string>${MAC_NAME}</string><key>ProgramArguments</key><array>${[node, entry, "kiro", "collect", "--settings", config].map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer></dict></plist>\n`;
  throw new Error("Kiro background installation currently supports Linux and macOS; foreground collection remains available");
}

/** Copy only the built-in-only Connect runtime into an owned stable location.
 * npm/npx cache collection must not remove a customer's running service entry. */
function installRuntime(opts: KiroServiceOptions): {entry: string; root: string} {
  const source = opts.runtimeSource ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const extension = opts.extension ?? (import.meta.url.endsWith(".ts") ? ".ts" : ".js");
  const files: Array<{relative: string; bytes: Buffer}> = [];
  let totalBytes = 0, entries = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 5) throw new Error("Kiro runtime directory depth exceeds bound");
    const dir = fs.opendirSync(path.join(source, directory), {bufferSize: 16});
    try {
      while (true) {
        const entry = dir.readSync(); if (!entry) break;
        if (++entries > 512) throw new Error("Kiro runtime inventory exceeds bound");
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(relative, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith(".d.ts")) {
          const file = path.join(source, relative), stat = fs.statSync(file);
          if (stat.size > 256 * 1024 || files.length >= 256) throw new Error("Kiro runtime file exceeds bound");
          const bytes = fs.readFileSync(file); totalBytes += bytes.length;
          if (totalBytes > 4 * 1024 * 1024) throw new Error("Kiro runtime bytes exceed bound");
          files.push({relative, bytes});
        } else if (entry.isSymbolicLink()) throw new Error("Kiro runtime cannot contain symlinks");
      }
    } finally {dir.closeSync();}
  };
  visit(".", 0);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = createHash("sha256");
  files.forEach(file => hash.update(file.relative).update("\0").update(file.bytes));
  const identity = hash.digest("hex").slice(0, 16);
  const root = path.join(kiroPaths(opts.home).runtimeDir, `runtime-${identity}`);
  const relativeEntry = `bin${extension}`;
  if (!files.some(file => file.relative === relativeEntry)) throw new Error("Kiro runtime entry is missing");
  fs.mkdirSync(path.dirname(root), {recursive: true, mode: 0o700});
  const inventory = fs.opendirSync(path.dirname(root), {bufferSize: 8}); let count = 0;
  try {while (inventory.readSync()) if (++count > 8) throw new Error("Kiro runtime retention capacity exceeded");} finally {inventory.closeSync();}
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, {mode: 0o700});
    for (const file of files) {const target = path.join(root, file.relative); fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700}); fs.writeFileSync(target, file.bytes, {flag: "wx", mode: 0o600});}
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', {flag: "wx", mode: 0o600});
  } else {
    for (const file of files) if (!fs.readFileSync(path.join(root, file.relative)).equals(file.bytes)) throw new Error("Kiro runtime integrity mismatch");
  }
  return {entry: path.join(root, relativeEntry), root};
}
function unitPath(opts: KiroServiceOptions): string {
  const home = opts.home ?? os.homedir(), platform = opts.platform ?? process.platform;
  return platform === "linux" ? path.join(home, ".config", "systemd", "user", LINUX_NAME)
    : path.join(home, "Library", "LaunchAgents", `${MAC_NAME}.plist`);
}
function ownedUnit(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 || !fs.readFileSync(file, "utf8").includes(MARKER)) throw new Error("refusing to replace an unrecognized Kiro service definition");
  return true;
}
export async function enableKiroService(configPath: string, opts: KiroServiceOptions = {}): Promise<{ok: boolean; detail: string}> {
  const file = resolveKiroConfigPath({path: configPath}); readKiroConfig(file);
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Kiro collection requires Node 24 or newer");
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return {ok: false, detail: "Background setup supports Linux/macOS; use kiro collect for a foreground collector."};
  const release = await claimKiroState(kiroPaths(opts.home).runtimeDir);
  try {
  const runtime = installRuntime(opts), unit = unitPath(opts), execute = opts.execute ?? command;
  ownedUnit(unit);
  fs.mkdirSync(path.dirname(unit), {recursive: true, mode: 0o700});
  const body = renderKiroService(platform, opts.node ?? process.execPath, runtime.entry, file);
  fs.writeFileSync(unit, body, {mode: 0o600}); fs.chmodSync(unit, 0o600);
  setKiroEnabled(file, true);
  try {
    if (platform === "linux") {
      execute("systemctl", ["--user", "daemon-reload"]);
      execute("systemctl", ["--user", "enable", LINUX_NAME]);
      execute("systemctl", ["--user", "restart", LINUX_NAME]);
    } else {
      const target = `gui/${process.getuid?.() ?? 0}`;
      try {execute("launchctl", ["bootout", `${target}/${MAC_NAME}`]);} catch {}
      execute("launchctl", ["enable", `${target}/${MAC_NAME}`]);
      execute("launchctl", ["bootstrap", target, unit]);
    }
    return {ok: true, detail: "Kiro background collector service enabled. Check kiro status for source coverage and delivery health."};
  } catch {return {ok: false, detail: "Kiro service manager could not start collection. Config is preserved; run kiro collect in a foreground process or repair the user service."};}
  } finally {await release();}
}
export function disableKiroService(configPath: string, opts: KiroServiceOptions = {}): {ok: boolean; detail: string} {
  const file = resolveKiroConfigPath({path: configPath}); setKiroEnabled(file, false);
  const platform = opts.platform ?? process.platform, execute = opts.execute ?? command;
  if (ownedUnit(unitPath(opts))) {
    try {
      if (platform === "linux") execute("systemctl", ["--user", "disable", "--now", LINUX_NAME]);
      else if (platform === "darwin") execute("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${MAC_NAME}`]);
    } catch {return {ok: false, detail: "Collection disabled in config; service manager stop could not be confirmed."};}
  }
  return {ok: true, detail: "Kiro collection disabled; acknowledged checkpoints and any pending envelope are preserved."};
}
export function uninstallKiroService(configPath: string, opts: KiroServiceOptions = {}) {
  const result = disableKiroService(configPath, opts);
  if (!result.ok) return result;
  const unit = unitPath(opts); if (ownedUnit(unit)) fs.unlinkSync(unit);
  if ((opts.platform ?? process.platform) === "linux") (opts.execute ?? command)("systemctl", ["--user", "daemon-reload"]);
  return {ok: true, detail: "Kiro service uninstalled. Private config, bounded runtime and recovery state are preserved for deliberate recovery or removal."};
}
