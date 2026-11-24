// Cursor hooks collector settings: where its files live, and the one private
// config that holds the ingest key, the capture choices and the interpreter and
// network settings recorded at install. Nothing here reads or writes Cursor's
// own directory; hooksFile.ts owns the single edit made there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertKey, looksLikeKey } from "../keys.ts";
import type { WriteResult } from "../settings.ts";
import type { ContentPolicy } from "../import/model.ts";

export const CURSOR_CONFIG_KIND = "codetelemetry-cursor-hooks-v1";
export const CURSOR_CONFIG_BYTES = 64 * 1024;
/** The collector needs this Node.js major; the hook itself runs on any. */
export const CURSOR_NODE_MAJOR = 24;
/** First line after the shebang of every launcher, and the service marker. */
export const CURSOR_FILE_MARKER = "CodeTelemetry Cursor hooks collector v1";

/** Whether the Cursor account email is spooled. Separate from content capture. */
export type CursorIdentity = { email: boolean };
/** Proxy and CA settings recorded at install and exported to the collector. */
export type CursorNetwork = { httpsProxy?: string; noProxy?: string; extraCaCerts?: string };
/** `execPath` is the resolved interpreter; `commandPath` is the unresolved
 *  `command -v node` path, which survives an upgrade that deletes the former. */
export type CursorNode = { execPath: string; commandPath?: string };
/** The three capture options, as every spool line records them (`p`). */
export type CursorPolicy = { prompts: boolean; toolDetails: boolean; email: boolean };

export type CursorConfig = {
  kind: typeof CURSOR_CONFIG_KIND;
  version: 1;
  enabled: boolean;
  key: string;
  ingestEndpoint: string;
  stateDir: string;
  content: ContentPolicy;
  identity: CursorIdentity;
  network: CursorNetwork;
  node: CursorNode;
  hooksFile: string;
  /** True when Connect created hooks.json, so uninstall may delete it once empty. */
  createdByConnect: boolean;
  /** The event keys Connect added to hooks.json. A key that is not listed was
   *  the user's, and removal leaves it with the list the user had. Absent in
   *  settings written before this was recorded. */
  createdHookKeys?: string[];
};

/** cursor-agent runs a hook command through a shell without quoting, so the
 *  paths Connect installs under are limited to characters no shell splits or
 *  expands. A home directory with a space fails this. */
const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]*$/;

export function isSafeCursorPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && SAFE_PATH.test(value);
}

/** Default locations. Every one derives from `home`, so tests and the service
 *  can place the whole installation under a directory of their choosing. */
export function cursorPaths(home: string = os.homedir()) {
  const shareDir = path.join(home, ".local", "share", "codetelemetry", "cursor-hooks-v1");
  const stateDir = path.join(home, ".local", "state", "codetelemetry", "cursor-hooks-v1");
  const hooksFile = path.join(home, ".cursor", "hooks.json");
  return {
    config: path.join(home, ".config", "codetelemetry", "cursor-hooks-v1.json"),
    shareDir,
    stateDir,
    hooksFile,
    hooksBackup: `${hooksFile}.codetelemetry-backup`,
    ...cursorShareFiles(shareDir),
  };
}

/** The command of one hook event, given the launcher's path: `hook-read.sh`
 *  beside it for `beforeReadFile`, whose command answers Cursor, and the
 *  launcher itself for every other event. */
export function cursorHookCommand(event: string, command: string): string {
  return event === "beforeReadFile" ? path.join(path.dirname(command), "hook-read.sh") : command;
}

/** The owned executables. `hook` is the command written to hooks.json, and
 *  `readHook` the one written under `beforeReadFile`. */
export function cursorShareFiles(shareDir: string) {
  const hook = path.join(shareDir, "hook.sh");
  return {
    hook,
    readHook: cursorHookCommand("beforeReadFile", hook),
    hookProgram: path.join(shareDir, "hook.cjs"),
    collectorLauncher: path.join(shareDir, "collector.sh"),
  };
}

/** Everything under the state directory. The hook writes `spool`, `dropped`
 *  and `spool-size` (its running total of the spool, see the hook program);
 *  the hook launcher writes `nodePath`, `nodeStale`; the collector owns the rest. */
export function cursorStateFiles(stateDir: string) {
  return {
    spool: path.join(stateDir, "spool"),
    dropped: path.join(stateDir, "dropped"),
    nodePath: path.join(stateDir, "node-path"),
    nodeStale: path.join(stateDir, "node-stale"),
    checkpoint: path.join(stateDir, "checkpoint.json"),
    pending: path.join(stateDir, "pending.json"),
    health: path.join(stateDir, "health.json"),
    lock: path.join(stateDir, "collector.lock"),
    rejected: path.join(stateDir, "rejected"),
  };
}

export function resolveCursorConfigPath(opts: { path?: string; home?: string } = {}): string {
  const file = path.resolve(opts.path ?? cursorPaths(opts.home).config);
  if (file.split(path.sep).includes(".cursor")) {
    throw new Error("CodeTelemetry Cursor config must be outside Cursor's own configuration directory");
  }
  return file;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A stored string that is later written into a launcher or a unit. */
const isPlain = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);

const isStoredPath = (value: unknown): value is string => isPlain(value, 4096) && path.isAbsolute(value);

function assertEndpoint(value: unknown): string {
  let endpoint: URL;
  try {
    endpoint = new URL(String(value));
  } catch {
    throw new Error("invalid Cursor ingest endpoint");
  }
  if (typeof value !== "string" || endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash) throw new Error("invalid Cursor ingest endpoint");
  return value;
}

function assertNetwork(value: unknown): CursorNetwork {
  if (!isRecord(value)) throw new Error("invalid Cursor collector network settings");
  const network: CursorNetwork = {};
  for (const name of ["httpsProxy", "noProxy", "extraCaCerts"] as const) {
    if (value[name] === undefined) continue;
    if (!isPlain(value[name], 2048)) throw new Error("invalid Cursor collector network settings");
    network[name] = value[name];
  }
  return network;
}

function assertNode(value: unknown): CursorNode {
  if (!isRecord(value) || !isStoredPath(value.execPath) ||
    (value.commandPath !== undefined && !isStoredPath(value.commandPath))) {
    throw new Error("invalid Cursor collector Node.js path");
  }
  return value.commandPath === undefined
    ? { execPath: value.execPath }
    : { execPath: value.execPath, commandPath: value.commandPath as string };
}

export function readCursorConfig(file: string): CursorConfig {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CURSOR_CONFIG_BYTES) {
    throw new Error("Cursor collector config is unreadable or exceeds bound");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Cursor collector config is not valid JSON");
  }
  if (!isRecord(raw) || raw.kind !== CURSOR_CONFIG_KIND || raw.version !== 1) {
    throw new Error("unsupported Cursor collector config contract");
  }
  const content = raw.content, identity = raw.identity;
  if (typeof raw.enabled !== "boolean" || typeof raw.createdByConnect !== "boolean" ||
    !isStoredPath(raw.stateDir) || !isStoredPath(raw.hooksFile) ||
    !isRecord(content) || typeof content.prompts !== "boolean" || typeof content.toolDetails !== "boolean" ||
    !isRecord(identity) || typeof identity.email !== "boolean" ||
    (raw.createdHookKeys !== undefined && (!Array.isArray(raw.createdHookKeys) || raw.createdHookKeys.length > 16 ||
      !raw.createdHookKeys.every(key => typeof key === "string" && /^[A-Za-z]{1,64}$/.test(key))))) {
    throw new Error("invalid Cursor collector config fields");
  }
  return {
    kind: CURSOR_CONFIG_KIND,
    version: 1,
    enabled: raw.enabled,
    key: assertKey(raw.key),
    ingestEndpoint: assertEndpoint(raw.ingestEndpoint),
    stateDir: raw.stateDir,
    content: { prompts: content.prompts, toolDetails: content.toolDetails },
    identity: { email: identity.email },
    network: assertNetwork(raw.network),
    node: assertNode(raw.node),
    hooksFile: raw.hooksFile,
    createdByConnect: raw.createdByConnect,
    ...(raw.createdHookKeys === undefined ? {} : { createdHookKeys: [...raw.createdHookKeys as string[]] }),
  };
}

/** Write a complete, fsynced temporary beside `file` and return its path. The
 *  one fixed name per file bounds what a crash can leave behind, and exclusive
 *  creation never writes through a planted link. */
export function writeCursorTemporary(file: string, body: string | Uint8Array, mode: number, suffix = ".tmp"): string {
  const temporary = `${file}${suffix}`;
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot replace ${temporary}`);
  }
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return temporary;
}

/** Make a rename or link in `directory` durable. Best effort. */
export function syncCursorDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const handle = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    /* the rename itself has happened */
  }
}

/** Replace `file` in one rename: a reader sees the old bytes or the new ones. */
export function writeCursorFileAtomic(file: string, body: string | Uint8Array, mode: number): void {
  const temporary = writeCursorTemporary(file, body, mode);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  syncCursorDirectory(path.dirname(file));
}

function persistConfig(file: string, config: CursorConfig): void {
  const body = JSON.stringify(config, null, 2) + "\n";
  if (Buffer.byteLength(body) > CURSOR_CONFIG_BYTES) throw new Error("Cursor collector config exceeds bound");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeCursorFileAtomic(file, body, 0o600);
}

/** The interpreter pair to record: this process's resolved binary and the
 *  first `node` on PATH as a shell would name it. No child process is started. */
export function cursorNodePaths(opts: { execPath?: string; env?: NodeJS.ProcessEnv } = {}): CursorNode {
  const execPath = opts.execPath ?? process.execPath;
  const lookup = (opts.env ?? process.env).PATH ?? "";
  for (const directory of lookup.split(path.delimiter).slice(0, 256)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "node");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    return candidate !== execPath && isStoredPath(candidate) ? { execPath, commandPath: candidate } : { execPath };
  }
  return { execPath };
}

/** Proxy and CA settings from the installing shell's environment. A value with
 *  a line break or NUL cannot be exported by a launcher and is refused by name;
 *  the value itself may hold proxy credentials and is never echoed. */
export function cursorNetworkFromEnv(env: NodeJS.ProcessEnv = process.env): CursorNetwork {
  const network: CursorNetwork = {};
  const sources = [
    ["httpsProxy", "HTTPS_PROXY", "https_proxy"],
    ["noProxy", "NO_PROXY", "no_proxy"],
    ["extraCaCerts", "NODE_EXTRA_CA_CERTS"],
  ] as const;
  for (const [field, ...names] of sources) {
    const name = names.find(candidate => env[candidate]);
    if (!name) continue;
    const value = env[name]!;
    if (!isPlain(value, 2048)) throw new Error(`${name} contains a line break or exceeds 2048 characters; it cannot be recorded for the Cursor collector`);
    network[field] = value;
  }
  return network;
}

/** Host and port of the recorded proxy for display; credentials never leave the config. */
export function cursorProxyDisplay(network: CursorNetwork): string | null {
  if (!network.httpsProxy) return null;
  try {
    const url = new URL(network.httpsProxy.includes("://") ? network.httpsProxy : `http://${network.httpsProxy}`);
    return url.host || "configured";
  } catch {
    return "configured";
  }
}

export const cursorPolicy = (config: Pick<CursorConfig, "content" | "identity">): CursorPolicy => ({
  prompts: config.content.prompts,
  toolDetails: config.content.toolDetails,
  email: config.identity.email,
});

/** The mode line `login` and `cursor status` print: what is sent, and the
 *  command that changes each choice. */
export function cursorCaptureSummary(config: Pick<CursorConfig, "content" | "identity">): string {
  const { prompts, toolDetails } = config.content;
  const login = "login --client cursor";
  const off = `turn off: ${login} --no-enrich`;
  const text = "prompt text, reply text and reasoning";
  const tools = "tool commands, tool output, file paths, file content and workspace path";
  const capture = prompts && toolDetails ? `${text}, ${tools} (${off})`
    : prompts ? `${text} (${off})`
      : toolDetails ? `${tools} (${off})`
        : `metadata only (turn on prompt and reply text and tool details: ${login} --enrich)`;
  return `Capture: ${capture}. Developer email: ${config.identity.email ? `sent (turn off: ${login} --no-identity)` : `not sent (turn on: ${login} --identity)`}.`;
}

export type CursorWriteOptions = {
  key: string;
  ingestEndpoint: string;
  configPath: string;
  /** true captures prompt text and tool details, false turns both off, and
   *  undefined keeps the stored choice (on for a first install). */
  enrich?: boolean;
  /** Same three states for the Cursor account email. */
  identity?: boolean;
  /** Settings found at this install; a field left out keeps its stored value. */
  network?: CursorNetwork;
  /** Forget every stored network setting before applying `network`. */
  clearNetwork?: boolean;
  /** Defaults to the installing process (`cursorNodePaths()`), never the stored pair. */
  node?: CursorNode;
  stateDir?: string;
  hooksFile?: string;
  createdByConnect?: boolean;
  backup?: boolean;
  home?: string;
};

/** `reduced` names each option this write turned off. Records spooled while it
 *  was on must be reduced before they are sent. */
export type CursorWriteResult = WriteResult & { reduced: CursorPolicy };

export function writeCursorConfig(opts: CursorWriteOptions): CursorWriteResult {
  const file = resolveCursorConfigPath({ path: opts.configPath });
  const exists = fs.existsSync(file), prior = exists ? readCursorConfig(file) : null;
  const defaults = cursorPaths(opts.home);
  const choose = (flag: boolean | undefined, stored: boolean | undefined) => flag ?? stored ?? true;
  const network: Record<string, unknown> = { ...(opts.clearNetwork ? {} : prior?.network) };
  for (const [name, value] of Object.entries(opts.network ?? {})) if (value !== undefined) network[name] = value;
  const config: CursorConfig = {
    kind: CURSOR_CONFIG_KIND,
    version: 1,
    enabled: true,
    key: assertKey(opts.key),
    ingestEndpoint: assertEndpoint(opts.ingestEndpoint),
    stateDir: opts.stateDir ?? prior?.stateDir ?? defaults.stateDir,
    content: {
      prompts: choose(opts.enrich, prior?.content.prompts),
      toolDetails: choose(opts.enrich, prior?.content.toolDetails),
    },
    identity: { email: choose(opts.identity, prior?.identity.email) },
    network: assertNetwork(network),
    node: assertNode(opts.node ?? cursorNodePaths()),
    hooksFile: opts.hooksFile ?? prior?.hooksFile ?? defaults.hooksFile,
    createdByConnect: opts.createdByConnect ?? prior?.createdByConnect ?? false,
    ...(prior?.createdHookKeys === undefined ? {} : { createdHookKeys: prior.createdHookKeys }),
  };
  if (!isStoredPath(config.stateDir) || !isStoredPath(config.hooksFile)) throw new Error("invalid Cursor collector config fields");
  let backupPath: string | null = null;
  if (exists && opts.backup !== false) {
    backupPath = `${file}.previous`;
    writeCursorFileAtomic(backupPath, fs.readFileSync(file), 0o600);
  }
  persistConfig(file, config);
  const before = prior ? cursorPolicy(prior) : null, after = cursorPolicy(config);
  return {
    path: file,
    created: !exists,
    backupPath,
    wrote: ["key", "ingestEndpoint", "enabled", "stateDir", "content", "identity", "network", "node", "hooksFile"],
    reduced: {
      prompts: !!before?.prompts && !after.prompts,
      toolDetails: !!before?.toolDetails && !after.toolDetails,
      email: !!before?.email && !after.email,
    },
  };
}

/** Change collector state without touching the key or the capture choices. */
export function updateCursorConfig(file: string, patch: Partial<Pick<CursorConfig, "enabled" | "createdByConnect" | "createdHookKeys">>): CursorConfig {
  const resolved = resolveCursorConfigPath({ path: file });
  const config = { ...readCursorConfig(resolved) };
  if (patch.enabled !== undefined) config.enabled = patch.enabled;
  if (patch.createdByConnect !== undefined) config.createdByConnect = patch.createdByConnect;
  if (patch.createdHookKeys !== undefined) config.createdHookKeys = [...patch.createdHookKeys];
  persistConfig(resolved, config);
  return config;
}

export function readCursorKey(file: string): string | null {
  try {
    return readCursorConfig(file).key;
  } catch {
    return null;
  }
}

export function readCursorSummary(file: string) {
  const exists = fs.existsSync(file);
  try {
    const config = readCursorConfig(file);
    return { exists, otelKeys: ["ingestEndpoint", "content", "identity", "hooksFile"], hasKey: looksLikeKey(config.key), collectorEnabled: config.enabled };
  } catch {
    return { exists, otelKeys: [], hasKey: false, collectorEnabled: false };
  }
}
