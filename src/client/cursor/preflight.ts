// Everything this machine can refuse about a Cursor install, checked before a
// key is requested and before anything is written. It only reads: the platform,
// the Node.js version, the paths an install would use, the settings and service
// definition already there, whether a per-user service manager answers, and
// whether Cursor's hooks.json can take the six entries. A refusal names its
// reason and leaves the machine exactly as it was.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SettingsScope } from "../config.ts";
import { collectorServiceManager, collectorUnitPath, ownedCollectorUnit, type CollectorServiceHost, type CollectorServiceSpec,
  type ServiceExecute } from "../collector/service.ts";
import { CURSOR_FILE_MARKER, CURSOR_NODE_MAJOR, cursorNetworkFromEnv, cursorNodePaths, cursorPaths, isSafeCursorPath, readCursorConfig,
  resolveCursorConfigPath, type CursorConfig, type CursorNetwork, type CursorNode } from "./config.ts";
import { checkCursorHooksFile, CursorHooksRefusal } from "./hooksFile.ts";

/** The background collector's service definition. The unit runs /bin/sh on the
 *  collector launcher, so it never names a Node.js binary. */
export const CURSOR_SERVICE: CollectorServiceSpec = Object.freeze({
  marker: CURSOR_FILE_MARKER,
  linuxName: "codetelemetry-cursor-hooks.service",
  macName: "com.codetelemetry.cursor-hooks",
  description: "CodeTelemetry Cursor hooks telemetry",
  label: "Cursor",
  // Most failed starts stay failed until someone acts, so the next one waits.
  restartSeconds: 60,
});

/** User-facing platform support, in one place. macOS runs the same code as
 *  Linux and stays labelled a preview until it has been verified on a Mac.
 *  Windows is refused by the preflight. */
export const CURSOR_PLATFORM_NOTE = "Verified on Linux. macOS is in preview.";
/** How the commands are spelled in text shown to a user. */
export const CURSOR_CLI = "npx -y @codetelemetry/connect";
export const CURSOR_LOGIN_COMMAND = `${CURSOR_CLI} login --client cursor`;

/** Where an install runs. Every field defaults to the real machine, and every
 *  one can be replaced, so a test never touches the real home directory or a
 *  real service manager. */
export type CursorHost = {
  home?: string;
  platform?: NodeJS.Platform;
  /** `process.versions.node` of the installing process. */
  nodeVersion?: string;
  uid?: number;
  /** Runs a service-manager command. */
  execute?: ServiceExecute;
  /** Read for the proxy and CA settings to record. */
  env?: NodeJS.ProcessEnv;
  /** The interpreter pair to record instead of the installing process's. */
  node?: CursorNode;
  /** Where the service runtime is copied from, and the extension of its files. */
  runtimeSource?: string;
  extension?: ".ts" | ".js";
  now?: () => number;
  /** Identifier of the current boot, recorded in lock files; the kernel's own by default. */
  bootId?: string;
};

export type CursorPreflightReason =
  | "project_scope" | "platform" | "node" | "path" | "config" | "network" | "endpoint" | "service_manager" | "service_unit" | "hooks_file";

/** The install was refused before a key was requested. Nothing was written. */
export class CursorPreflightRefusal extends Error {
  reason: CursorPreflightReason;
  constructor(reason: CursorPreflightReason, message: string) {
    super(message);
    this.name = "CursorPreflightRefusal";
    this.reason = reason;
  }
}

export type CursorPreflightOptions = {
  scope?: SettingsScope;
  /** An explicit settings path (`--settings`). */
  configPath?: string;
  /** Install the hooks and launchers but no service (`--hooks-only`). */
  hooksOnly?: boolean;
  /** Install everything except the hooks.json edit (`--hooks-manual`). */
  hooksManual?: boolean;
  /** Forget recorded proxy and CA settings and record none (`--no-proxy-settings`). */
  clearNetwork?: boolean;
  /** "stored" keeps the recorded settings and reads no environment (`cursor enable`). */
  network?: "environment" | "stored";
  /** The ingest endpoint, when it is known before the key is. */
  ingestEndpoint?: string;
  host?: CursorHost;
};

/** What a passed preflight resolved: where each file goes and what to install. */
export type CursorInstallPlan = {
  home: string;
  platform: "linux" | "darwin";
  host: CursorHost;
  configPath: string;
  shareDir: string;
  stateDir: string;
  hooksFile: string;
  /** The command registered in hooks.json. */
  hook: string;
  unitPath: string;
  /** The settings already installed, when there are any. */
  prior: CursorConfig | null;
  node: CursorNode;
  /** Settings found in the environment at this install. */
  network: CursorNetwork;
  clearNetwork: boolean;
  /** Install and start the service; false under `--hooks-only`. */
  service: boolean;
  manager: "systemd" | "launchd" | null;
  /** Edit hooks.json; false under `--hooks-manual`. */
  mergeHooks: boolean;
  hooksFileExists: boolean;
  /** Lines to show the user before anything else happens. */
  notices: string[];
};

const NOTHING = "Nothing was installed.";
const refuse = (reason: CursorPreflightReason, message: string): CursorPreflightRefusal =>
  new CursorPreflightRefusal(reason, `${message}${message.endsWith("\n") ? "" : " "}${NOTHING}`);

/** What to do on a host with no per-user service manager. */
export function cursorSupervisorRecipe(collectorLauncher: string): string {
  return [
    "To install the hooks without a service and run the collector yourself:",
    `  ${CURSOR_LOGIN_COMMAND} --hooks-only`,
    `  /bin/sh ${collectorLauncher}`,
    "Run the second line under the host's own supervisor, or in a terminal that stays open. It starts `codetelemetry-connect cursor collect` from a copy of Connect that the first line installs.",
  ].join("\n");
}

function existingDirectory(directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw refuse("path", `${directory} must be a directory, not a link or a file.`);
  }
}

/** Run every machine check. Returns the plan an install follows, or throws a
 *  `CursorPreflightRefusal`. Never writes. */
export function cursorPreflight(opts: CursorPreflightOptions = {}): CursorInstallPlan {
  const host = opts.host ?? {};
  if (opts.scope === "project") {
    throw refuse("project_scope", "Cursor hooks are installed per user; project scope is not supported.");
  }
  const platform = host.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw refuse("platform", "Cursor collection supports Linux and macOS.");
  }
  const nodeVersion = host.nodeVersion ?? process.versions.node;
  if (!(Number(nodeVersion.split(".")[0]) >= CURSOR_NODE_MAJOR)) {
    throw refuse("node", `Cursor collection requires Node.js ${CURSOR_NODE_MAJOR} or newer; this is Node.js ${nodeVersion}.`);
  }

  const home = host.home ?? os.homedir();
  const defaults = cursorPaths(home);
  let configPath: string;
  try {
    configPath = resolveCursorConfigPath({ path: opts.configPath, home });
  } catch (error) {
    throw refuse("path", `${(error as Error).message}.`);
  }
  let prior: CursorConfig | null = null;
  if (fs.lstatSync(configPath, { throwIfNoEntry: false })) {
    try {
      prior = readCursorConfig(configPath);
    } catch (error) {
      throw refuse("config", `The existing settings file ${configPath} cannot be used (${(error as Error).message}). Move it away, or remove the installation with \`${CURSOR_CLI} cursor uninstall --purge\`, and run the command again.`);
    }
  }
  const stateDir = prior?.stateDir ?? defaults.stateDir, hooksFile = prior?.hooksFile ?? defaults.hooksFile;
  for (const [label, value] of [["home directory", home], ["install directory", defaults.shareDir], ["state directory", stateDir],
    ["settings path", configPath]] as const) {
    if (!isSafeCursorPath(value)) {
      throw refuse("path", `Cursor runs hook commands through a shell without quoting, so the ${label} ${JSON.stringify(value)} cannot be used: a path may only contain letters, digits and . _ / @ + - (no spaces).`);
    }
  }
  for (const directory of [defaults.shareDir, stateDir]) {
    if (directory.split(path.sep).includes(".cursor")) {
      throw refuse("path", `${directory} is inside Cursor's own configuration directory; CodeTelemetry keeps its files outside it.`);
    }
    existingDirectory(directory);
  }

  let network: CursorNetwork = {};
  const notices: string[] = [];
  if (opts.network !== "stored" && !opts.clearNetwork) {
    const env = host.env ?? process.env;
    try {
      network = cursorNetworkFromEnv(env);
    } catch (error) {
      throw refuse("network", `${(error as Error).message}.`);
    }
    if (network.httpsProxy && env.NODE_USE_ENV_PROXY !== "1") {
      notices.push("HTTPS_PROXY is set but NODE_USE_ENV_PROXY=1 is not, so this command's own requests do not use the proxy. " +
        "If sign-in or the checks below cannot reach CodeTelemetry, export NODE_USE_ENV_PROXY=1 and run the command again. " +
        "The proxy is recorded for the background collector either way.");
    }
  }
  if (opts.ingestEndpoint !== undefined) {
    let endpoint: URL | null = null;
    try {
      endpoint = new URL(opts.ingestEndpoint);
    } catch { /* Refused below. */ }
    if (!endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw refuse("endpoint", "The Cursor collector sends only to an https ingest endpoint without credentials, a query or a fragment.");
    }
  }

  const serviceHost: CollectorServiceHost = { home, platform, uid: host.uid, execute: host.execute };
  const unitPath = collectorUnitPath(CURSOR_SERVICE, serviceHost);
  let manager: CursorInstallPlan["manager"] = null;
  if (!opts.hooksOnly) {
    const found = collectorServiceManager(serviceHost);
    manager = found.manager;
    if (!found.available) {
      const probe = platform === "linux" ? "`systemctl --user` did not answer" : "`launchctl` did not answer";
      throw refuse("service_manager", `No per-user service manager is available (${probe}), so the background collector cannot be installed here. ` +
        `That is usual in containers and in WSL without systemd.\n${cursorSupervisorRecipe(defaults.collectorLauncher)}\n`);
    }
    try {
      ownedCollectorUnit(CURSOR_SERVICE, unitPath);
    } catch {
      throw refuse("service_unit", `${unitPath} exists and was not written by CodeTelemetry, so it was left unchanged. Move it away and run the command again.`);
    }
  }

  let hooksFileExists = fs.lstatSync(hooksFile, { throwIfNoEntry: false }) !== undefined;
  if (!opts.hooksManual) {
    try {
      hooksFileExists = checkCursorHooksFile({ hooksFile, command: defaults.hook }).exists;
    } catch (error) {
      if (!(error instanceof CursorHooksRefusal)) throw error;
      throw refuse("hooks_file", `${error.message}\n`);
    }
  }

  return {
    home, platform, host, configPath,
    shareDir: defaults.shareDir, stateDir, hooksFile, hook: defaults.hook, unitPath, prior,
    node: host.node ?? cursorNodePaths({ env: host.env }),
    network, clearNetwork: opts.clearNetwork === true,
    service: !opts.hooksOnly, manager,
    mergeHooks: !opts.hooksManual, hooksFileExists,
    notices,
  };
}
