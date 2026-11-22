import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { replaceFileSync } from "./state.ts";

// Background service shared by the collectors: an owned copy of the Connect
// runtime and a systemd user unit or a LaunchAgent that runs one command. A
// collector whose unit must not name a Node.js binary passes /bin/sh and its
// launcher script as that command. Every call to the service manager goes
// through `host.execute`.

export type ServiceExecute = (command: string, args: string[]) => string;
export type CollectorServiceSpec = {
  /** Ownership marker: the unit's first line and a comment in the plist. A
   * definition without it is never replaced, stopped or removed. */
  marker: string;
  /** systemd unit file name, ending in ".service". */
  linuxName: string;
  /** launchd label; the plist is "<macName>.plist". */
  macName: string;
  /** systemd Description. */
  description: string;
  /** Names the collector in error text. */
  label: string;
  /** Kiro's released behaviour, kept so its unit text and results do not change:
   * "$" is left unescaped in ExecStart, an install is refused when the runtime
   * directory holds more than eight entries instead of pruning old runtimes,
   * and a failed bootout is an error even when the agent was not loaded. */
  legacy?: boolean;
  /** Seconds the service manager waits before it starts the command again
   * after an unsuccessful exit (systemd RestartSec, launchd ThrottleInterval).
   * Default 5, Kiro's released value. A collector whose failures are mostly
   * permanent until someone acts (a state file from a newer release, settings
   * that are gone, a second collector) asks for longer. */
  restartSeconds?: number;
};
/** One word of the service command line. A string is an absolute path and is
 * quoted and escaped; `{literal}` is a fixed word such as a subcommand or flag. */
export type ServiceWord = string | {literal: string};
export type CollectorServiceCommand = {program: string; args: readonly ServiceWord[]};
export type CollectorServiceHost = {home?: string; platform?: NodeJS.Platform; uid?: number; execute?: ServiceExecute};

const run: ServiceExecute = (command, args) => execFileSync(command, args, {encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"]});
const LITERAL = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safePath = (value: string, label: string) => {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.length > 4096) throw new Error(`invalid ${label} service path`);
  return value;
};
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
function checked(spec: CollectorServiceSpec): CollectorServiceSpec {
  const text = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
  if (!text.test(spec.marker) || spec.marker.includes("--") || !text.test(spec.description) ||
    !/^[a-z0-9][a-z0-9.-]{0,63}[.]service$/.test(spec.linuxName) || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(spec.macName) ||
    (spec.restartSeconds !== undefined && (!Number.isSafeInteger(spec.restartSeconds) || spec.restartSeconds < 1 || spec.restartSeconds > 3600))) throw new Error(`invalid ${spec.label} service definition`);
  return spec;
}

/** The unit (Linux) or LaunchAgent plist (macOS) that runs `command` and
 * restarts it after an unsuccessful exit. */
export function renderCollectorService(spec: CollectorServiceSpec, platform: NodeJS.Platform, command: CollectorServiceCommand): string {
  const {label, marker} = checked(spec), restartSeconds = spec.restartSeconds ?? 5;
  const words: ServiceWord[] = [command.program, ...command.args];
  if (words.length > 16) throw new Error(`invalid ${label} service argument`);
  const text = words.map((word, index) => {
    if (typeof word === "string") return safePath(word, label);
    if (index === 0 || !LITERAL.test(word.literal)) throw new Error(`invalid ${label} service argument`);
    return word.literal;
  });
  if (platform === "linux") {
    const quote = (value: string) => {
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
      return `"${spec.legacy ? escaped : escaped.replace(/\$/g, "$$$$")}"`;
    };
    const line = words.map((word, index) => typeof word === "string" ? quote(text[index]) : text[index]).join(" ");
    return `# ${marker}\n[Unit]\nDescription=${spec.description}\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${line}\nRestart=on-failure\nRestartSec=${restartSeconds}\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  }
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${marker} -->\n<plist version="1.0"><dict><key>Label</key><string>${spec.macName}</string><key>ProgramArguments</key><array>${text.map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>${restartSeconds}</integer><key>Umask</key><integer>63</integer></dict></plist>\n`;
  throw new Error(`${label} background installation currently supports Linux and macOS; foreground collection remains available`);
}

export function collectorUnitPath(spec: CollectorServiceSpec, host: CollectorServiceHost = {}): string {
  const home = host.home ?? os.homedir(), platform = host.platform ?? process.platform;
  return platform === "linux" ? path.join(home, ".config", "systemd", "user", checked(spec).linuxName)
    : path.join(home, "Library", "LaunchAgents", `${checked(spec).macName}.plist`);
}

/** False when nothing is installed. A file at the unit path that is not ours
 * (a symlink, oversized, or without the marker) is an error, never a target. */
export function ownedCollectorUnit(spec: CollectorServiceSpec, file: string): boolean {
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  if (!stat) return false;
  if (!stat.isFile() || stat.size > 16 * 1024 || !fs.readFileSync(file, "utf8").includes(spec.marker)) throw new Error(`refusing to replace an unrecognized ${spec.label} service definition`);
  return true;
}

/** Install or replace our service definition, mode 0600. Returns its path. */
export function writeCollectorUnit(spec: CollectorServiceSpec, host: CollectorServiceHost, body: string): string {
  const unit = collectorUnitPath(spec, host);
  ownedCollectorUnit(spec, unit);
  fs.mkdirSync(path.dirname(unit), {recursive: true, mode: 0o700});
  replaceFileSync(unit, body, 0o600);
  return unit;
}

const guiTarget = (host: CollectorServiceHost) => `gui/${host.uid ?? process.getuid?.() ?? 0}`;

/** Load, enable and (re)start the installed definition. Throws when the
 * service manager refuses; the definition stays in place. */
export function startCollectorService(spec: CollectorServiceSpec, host: CollectorServiceHost = {}): void {
  const platform = host.platform ?? process.platform, execute = host.execute ?? run;
  if (platform === "linux") {
    execute("systemctl", ["--user", "daemon-reload"]);
    execute("systemctl", ["--user", "enable", spec.linuxName]);
    execute("systemctl", ["--user", "restart", spec.linuxName]);
  } else if (platform === "darwin") {
    try {execute("launchctl", ["bootout", `${guiTarget(host)}/${spec.macName}`]);} catch { /* Not loaded yet. */ }
    execute("launchctl", ["enable", `${guiTarget(host)}/${spec.macName}`]);
    execute("launchctl", ["bootstrap", guiTarget(host), collectorUnitPath(spec, host)]);
  } else throw new Error(`${spec.label} background installation currently supports Linux and macOS; foreground collection remains available`);
}

/** Stop the service and keep it from starting again. The caller checks
 * ownership first. Throws when the stop cannot be confirmed. */
export function stopCollectorService(spec: CollectorServiceSpec, host: CollectorServiceHost = {}): void {
  const platform = host.platform ?? process.platform, execute = host.execute ?? run;
  if (platform === "linux") execute("systemctl", ["--user", "disable", "--now", spec.linuxName]);
  else if (platform === "darwin") {
    const service = `${guiTarget(host)}/${spec.macName}`;
    try {execute("launchctl", ["bootout", service]);}
    catch (error) {
      if (spec.legacy) throw error;
      // bootout also fails for an agent that is not loaded, which is the state
      // being asked for. Only an agent that still answers is a failed stop.
      let loaded = true;
      try {execute("launchctl", ["print", service]);} catch {loaded = false;}
      if (loaded) throw error;
    }
  }
}

/** Remove our definition if one is installed. Returns whether it was. */
export function removeCollectorUnit(spec: CollectorServiceSpec, host: CollectorServiceHost = {}): boolean {
  const unit = collectorUnitPath(spec, host), owned = ownedCollectorUnit(spec, unit);
  if (owned) fs.unlinkSync(unit);
  if ((host.platform ?? process.platform) === "linux") (host.execute ?? run)("systemctl", ["--user", "daemon-reload"]);
  return owned;
}

/** Whether this machine has a per-user service manager a collector can use. */
export function collectorServiceManager(host: CollectorServiceHost = {}): {available: boolean; manager: "systemd" | "launchd" | null} {
  const platform = host.platform ?? process.platform, execute = host.execute ?? run;
  const manager = platform === "linux" ? "systemd" : platform === "darwin" ? "launchd" : null;
  if (!manager) return {available: false, manager};
  try {
    if (manager === "systemd") execute("systemctl", ["--user", "show-environment"]);
    else execute("launchctl", ["version"]);
    return {available: true, manager};
  } catch {return {available: false, manager};}
}

const RUNTIME = /^runtime-[a-f0-9]{16}(?:[.]tmp)?$/;
export type CollectorRuntimeOptions = {
  /** Owned directory that holds "runtime-<hash>" copies. */
  runtimeDir: string;
  runtimeSource?: string; extension?: ".ts" | ".js"; now?: () => number};

/** Copy only the built-in-only Connect runtime into an owned stable location.
 * npm/npx cache collection must not remove a customer's running service entry.
 * The copy is built beside its final name and renamed, so a crash never leaves
 * a partial runtime. The current and the previously installed runtime are
 * kept, older ones are removed, and a damaged copy is rebuilt; a legacy spec
 * refuses in both cases instead. Call it under the directory's state claim. */
export function installCollectorRuntime(spec: Pick<CollectorServiceSpec, "label" | "legacy">, opts: CollectorRuntimeOptions): {entry: string; root: string} {
  const {label} = spec;
  const source = opts.runtimeSource ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const extension = opts.extension ?? (import.meta.url.endsWith(".ts") ? ".ts" : ".js");
  const files: Array<{relative: string; bytes: Buffer}> = [];
  let totalBytes = 0, entries = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 5) throw new Error(`${label} runtime directory depth exceeds bound`);
    const dir = fs.opendirSync(path.join(source, directory), {bufferSize: 16});
    try {
      while (true) {
        const entry = dir.readSync(); if (!entry) break;
        if (++entries > 512) throw new Error(`${label} runtime inventory exceeds bound`);
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(relative, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith(".d.ts")) {
          const file = path.join(source, relative), stat = fs.statSync(file);
          if (stat.size > 256 * 1024 || files.length >= 256) throw new Error(`${label} runtime file exceeds bound`);
          const bytes = fs.readFileSync(file); totalBytes += bytes.length;
          if (totalBytes > 4 * 1024 * 1024) throw new Error(`${label} runtime bytes exceed bound`);
          files.push({relative, bytes});
        } else if (entry.isSymbolicLink()) throw new Error(`${label} runtime cannot contain symlinks`);
      }
    } finally {dir.closeSync();}
  };
  visit(".", 0);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = createHash("sha256");
  files.forEach(file => hash.update(file.relative).update("\0").update(file.bytes));
  const name = `runtime-${hash.digest("hex").slice(0, 16)}`;
  const root = path.join(opts.runtimeDir, name), building = `${root}.tmp`;
  const relativeEntry = `bin${extension}`;
  if (!files.some(file => file.relative === relativeEntry)) throw new Error(`${label} runtime entry is missing`);
  fs.mkdirSync(opts.runtimeDir, {recursive: true, mode: 0o700});
  fs.rmSync(building, {recursive: true, force: true});
  if (spec.legacy) {
    const inventory = fs.opendirSync(opts.runtimeDir, {bufferSize: 8}); let count = 0;
    try {while (inventory.readSync()) if (++count > 8) throw new Error(`${label} runtime retention capacity exceeded`);} finally {inventory.closeSync();}
  }
  const intact = () => {
    try {return fs.lstatSync(root).isDirectory() && files.every(file => fs.readFileSync(path.join(root, file.relative)).equals(file.bytes));}
    catch {return false;}
  };
  if (fs.lstatSync(root, {throwIfNoEntry: false}) && !intact()) {
    if (spec.legacy) throw new Error(`${label} runtime integrity mismatch`);
    fs.rmSync(root, {recursive: true, force: true});
  }
  if (!fs.lstatSync(root, {throwIfNoEntry: false})) {
    fs.mkdirSync(building, {mode: 0o700});
    for (const file of files) {const target = path.join(building, file.relative); fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700}); fs.writeFileSync(target, file.bytes, {flag: "wx", mode: 0o600});}
    fs.writeFileSync(path.join(building, "package.json"), '{"type":"module"}\n', {flag: "wx", mode: 0o600});
    fs.renameSync(building, root);
  }
  if (!spec.legacy) {
    // The directory time records the latest install, so "previous" is the
    // runtime a still-running service was started from.
    const seconds = (opts.now ?? Date.now)() / 1000;
    fs.utimesSync(root, seconds, seconds);
    const others: Array<{name: string; mtimeMs: number}> = [];
    const inventory = fs.opendirSync(opts.runtimeDir, {bufferSize: 16});
    try {
      for (let scanned = 0; scanned < 256; scanned++) {
        const entry = inventory.readSync(); if (!entry) break;
        if (entry.name !== name && RUNTIME.test(entry.name)) others.push({name: entry.name, mtimeMs: fs.lstatSync(path.join(opts.runtimeDir, entry.name)).mtimeMs});
      }
    } finally {inventory.closeSync();}
    const previous = others.filter(other => !other.name.endsWith(".tmp")).sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0]?.name;
    for (const other of others) if (other.name !== previous) fs.rmSync(path.join(opts.runtimeDir, other.name), {recursive: true, force: true});
  }
  return {entry: path.join(root, relativeEntry), root};
}
