// The Cursor collector's lifecycle on one machine, and the `cursor ...`
// subcommands that drive it: install after a passed preflight, enable, disable,
// uninstall, purge, status, collect and retry-rejected. An install either
// completes or puts back what it found. Removal says what it left behind and
// what each path holds, and a purge deletes only directories that are
// recognizably CodeTelemetry's own.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { replaceFileSync } from "../collector/state.ts";
import { collectorUnitPath, installCollectorRuntime, ownedCollectorUnit, removeCollectorUnit, renderCollectorService,
  startCollectorService, stopCollectorService, writeCollectorUnit, type CollectorServiceHost } from "../collector/service.ts";
import type { FetchLike } from "../otlp.ts";
import { CursorCollector, claimCursorState, cursorDestinationHash, cursorTransport, readCursorHealth, requestCursorRetryRejected,
  runCursorCollector, writeCursorHealth, type CursorHealthFile } from "./collector.ts";
import { CURSOR_NODE_MAJOR, cursorCaptureSummary, cursorPaths, cursorPolicy, cursorProxyDisplay, cursorShareFiles, cursorStateFiles,
  readCursorConfig, resolveCursorConfigPath, updateCursorConfig, writeCursorConfig, type CursorConfig,
  type CursorWriteResult } from "./config.ts";
import { CURSOR_HOOK_LIMITS, installCursorCollectorLauncher, installCursorHookFiles, removeCursorHookFiles } from "./hookProgram.ts";
import { cursorHooksManualBlock, cursorHooksState, installCursorHooks, removeCursorHooks } from "./hooksFile.ts";
import { CURSOR_CLI, CURSOR_LOGIN_COMMAND, CURSOR_PLATFORM_NOTE, CURSOR_SERVICE, CursorPreflightRefusal, cursorPreflight,
  cursorSupervisorRecipe, type CursorHost, type CursorInstallPlan } from "./preflight.ts";

export type CursorStep = { name: string; ok: boolean; detail: string };
/** One path on the machine and what it holds. */
export type CursorOwnedPath = { path: string; purpose: string };
type HooksState = "installed" | "missing" | "partial";

/** A subcommand as the user types it. `flag` carries `--settings` when the
 *  settings are not at the default path, so a printed command finds them. */
const subcommand = (name: string, flag = ""): string => `${CURSOR_CLI} cursor ${name}${flag}`;
const settingsFlag = (home: string, configPath: string): string => configPath === cursorPaths(home).config ? "" : ` --settings ${configPath}`;
const NOT_SET_UP = `Cursor collection is not set up on this machine. Run: ${CURSOR_LOGIN_COMMAND}`;
const CONTENT_NOTE = "holds prompt text and commands if --enrich was ever on";
const SNAPSHOT_BYTES = 1024 * 1024;
const LISTED_ENTRIES = 64;
const RUNTIME = /^runtime-[a-f0-9]{16}(?:[.]tmp)?$/;
/** How long a purge waits for a collector that is still shutting down. */
const PURGE_WAIT_MS = 10_000;

const serviceHost = (home: string, host: CursorHost): CollectorServiceHost =>
  ({ home, platform: host.platform, uid: host.uid, execute: host.execute });
const present = (file: string): boolean => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
/** A directory itself, not a link to one. Nothing is done inside anything else. */
const realDirectory = (directory: string): boolean => fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true;
/** The one directory name a purge deletes, whatever a settings file says. */
const ownDirectory = (directory: string): boolean =>
  path.basename(directory) === "cursor-hooks-v1" && path.basename(path.dirname(directory)) === "codetelemetry";
const errorText = (error: unknown): string => String((error as Error)?.message ?? error);
/** The install lock could not be taken. Its holder is another Connect command, not a collector. */
const busy = (error: unknown): Error => new Error(/already running/.test(errorText(error))
  ? "Another codetelemetry-connect command is changing the Cursor installation. Nothing was changed; run the command again when it has finished."
  : `The lock on the Cursor installation could not be taken (${errorText(error)}). Nothing was changed.`);

// ---------------------------------------------------------------------------
// Format check

export type CursorFormatCheck = {
  /** `unverified`: the answer says nothing about the format (no credit, or no response). */
  state: "supported" | "unsupported" | "key_refused" | "refused" | "unverified";
  detail: string;
  httpStatus?: number;
};

/** Ask the ingest endpoint whether it serves the Cursor source format: an empty
 *  envelope under the format header and a fresh idempotency key. It needs a
 *  key, because the service authenticates before it looks at the format. */
export async function checkCursorFormat(opts: {
  key: string; ingestEndpoint: string; fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv;
}): Promise<CursorFormatCheck> {
  const post = cursorTransport({ endpoint: opts.ingestEndpoint, key: opts.key, fetchImpl: opts.fetchImpl, env: opts.env });
  const result = await post('{"resourceLogs":[]}', randomUUID());
  const status = result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus };
  // A coded refusal of the empty frame still shows that the format is served.
  if (result.outcome === "ok" || (result.outcome === "rejected" && result.detail === "invalid")) {
    return { state: "supported", detail: "The service accepts Cursor records.", ...status };
  }
  if (result.outcome === "unsupported") return { state: "unsupported", detail: "The service does not accept Cursor records yet.", ...status };
  if (result.outcome === "auth") return { state: "key_refused", detail: `The ingest key was refused (HTTP ${result.httpStatus}).`, ...status };
  if (result.outcome === "rejected") {
    return { state: "refused", detail: `The ingest endpoint refused the Cursor format check (HTTP ${result.httpStatus}).`, ...status };
  }
  const why = result.outcome === "budget" ? "the workspace is out of credit"
    : result.outcome === "network" ? `the ingest endpoint could not be reached (${result.errorClass ?? "network"})`
      : `the service asked to retry (HTTP ${result.httpStatus})`;
  return { state: "unverified", detail: `Could not confirm that the service accepts Cursor records: ${why}. The collector checks again when it sends.`, ...status };
}

// ---------------------------------------------------------------------------
// Install

export type CursorInstallOptions = {
  key: string;
  ingestEndpoint: string;
  /** true turns prompt and tool-detail capture on, false turns it off, undefined keeps the stored choice. */
  enrich?: boolean;
  /** The same three states for the Cursor account email. */
  identity?: boolean;
  /** false skips the format check: `cursor enable` reuses settings that passed it. */
  checkFormat?: boolean;
  backup?: boolean;
  fetchImpl?: FetchLike;
  /** Receives progress lines. They never hold the key. */
  log?: (line: string) => void;
};

export type CursorInstallResult = {
  settings: CursorWriteResult;
  steps: CursorStep[];
  /** What is on this machine now, and what each path is for. */
  installed: CursorOwnedPath[];
  hooks: HooksState;
  service: "started" | "not_installed";
  /** The capture mode line. */
  capture: string;
  /** What the user still has to do: start the collector, paste the hook entries. */
  advice: string[];
  /** Everything to tell the person who ran the command, `advice` included. */
  summary: string[];
};

type Snapshot = { file: string; bytes: Buffer | null; mode: number };

function snapshot(file: string): Snapshot {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { file, bytes: null, mode: 0 };
  if (!stat.isFile() || stat.size > SNAPSHOT_BYTES) throw new Error(`${file} is not a regular file Connect can replace.`);
  return { file, bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

function restore(saved: Snapshot): void {
  if (saved.bytes === null) fs.rmSync(saved.file, { force: true });
  else replaceFileSync(saved.file, saved.bytes, saved.mode);
}

/** Directories from `directory` up to the home directory that do not exist yet. */
function absentDirectories(home: string, directory: string): string[] {
  const absent: string[] = [];
  for (let current = directory, depth = 0; depth < 16 && current !== home && current !== path.dirname(current); depth++) {
    if (present(current)) break;
    absent.push(current);
    current = path.dirname(current);
  }
  return absent;
}

function runtimeNames(shareDir: string): string[] {
  try {
    return fs.readdirSync(shareDir).filter(name => RUNTIME.test(name)).slice(0, 256);
  } catch {
    return [];
  }
}

/** Write the settings, the hook program, the launchers, the service and the
 *  hooks.json entries, in that order, so hooks never exist without a collector.
 *  A failure at any point undoes every earlier step: a first install leaves
 *  nothing behind, and a repeated one gets its previous files back. */
export async function installCursor(plan: CursorInstallPlan, opts: CursorInstallOptions): Promise<CursorInstallResult> {
  const log = opts.log ?? (() => {});
  const steps: CursorStep[] = [];
  const done = (name: string, detail: string): void => {
    steps.push({ name, ok: true, detail });
    log(detail);
  };

  if (opts.checkFormat !== false) {
    // Before the first write, so a service without the format leaves no key on disk.
    const check = await checkCursorFormat({ key: opts.key, ingestEndpoint: opts.ingestEndpoint, fetchImpl: opts.fetchImpl, env: plan.host.env })
      .catch(error => { throw new Error(`The format check could not be made (${errorText(error)}). Nothing was installed.`); });
    if (check.state !== "supported" && check.state !== "unverified") throw new Error(`${check.detail} Nothing was installed.`);
    done("check_format", check.detail);
  }

  const { home, host, configPath, shareDir, stateDir, hooksFile } = plan;
  const files = cursorShareFiles(shareDir), state = cursorStateFiles(stateDir);
  const purgeCommand = subcommand("uninstall --purge", settingsFlag(home, configPath));
  const manager = serviceHost(home, host);
  // A failed install removes the directories it made, and only those. The
  // install directory is judged before the lock creates it; the rest is judged
  // under the lock, where no other install can be running.
  const removeEmpty = (directories: string[]): void => {
    for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) {
      try {
        fs.rmdirSync(directory);
      } catch { /* Not empty, or already gone. */ }
    }
  };
  const shareAbsent = absentDirectories(home, shareDir);
  let release: () => Promise<void>;
  try {
    release = await claimCursorState(shareDir, host.bootId);
  } catch (error) {
    removeEmpty(shareAbsent);
    throw busy(error);
  }
  // Another command may have installed here between the look and the lock; then the directory is not this install's.
  const fresh = shareAbsent.includes(shareDir) && entries(shareDir).every(name => name === "collector.lock");
  const made = [...(fresh ? shareAbsent : []),
    ...[path.dirname(configPath), state.spool, path.dirname(plan.unitPath), path.dirname(hooksFile)].flatMap(directory => absentDirectories(home, directory))];
  const removeMade = (): void => {
    for (const directory of [shareDir, stateDir]) if (made.includes(directory)) fs.rmSync(directory, { recursive: true, force: true });
    // A shared parent goes only when this install made it and it is empty again.
    removeEmpty(made);
  };

  const undo: Array<() => void> = [];
  try {
    const saved = [configPath, `${configPath}.previous`].map(snapshot);
    undo.push(() => saved.forEach(restore));
    const createdByConnect = plan.mergeHooks && !present(hooksFile) ? true : plan.prior?.createdByConnect ?? false;
    const settings = writeCursorConfig({
      key: opts.key, ingestEndpoint: opts.ingestEndpoint, configPath, enrich: opts.enrich, identity: opts.identity,
      network: plan.network, clearNetwork: plan.clearNetwork, node: plan.node, stateDir, hooksFile, createdByConnect,
      backup: opts.backup, home,
    });
    const config = readCursorConfig(configPath);
    done("write_config", `${settings.created ? "Created" : "Updated"} ${settings.path}${settings.backupPath ? ` (previous settings: ${settings.backupPath})` : ""}`);

    const hookFiles = [files.hook, files.hookProgram].map(snapshot);
    undo.push(() => hookFiles.forEach(restore));
    const hook = installCursorHookFiles({ shareDir, stateDir, content: config.content, identity: config.identity, node: config.node });
    done("install_hook_program", `Installed the hook program and its launcher in ${shareDir}`);

    const runtimesBefore = new Set(runtimeNames(shareDir));
    const launcherBefore = snapshot(files.collectorLauncher);
    undo.push(() => {
      for (const name of runtimeNames(shareDir)) if (!runtimesBefore.has(name)) fs.rmSync(path.join(shareDir, name), { recursive: true, force: true });
      restore(launcherBefore);
    });
    const runtime = installCollectorRuntime(CURSOR_SERVICE, { runtimeDir: shareDir, runtimeSource: host.runtimeSource, extension: host.extension, now: host.now });
    installCursorCollectorLauncher({ shareDir, stateDir, node: config.node, entry: runtime.entry, configPath, network: config.network });

    if (plan.service) {
      const unitBefore = snapshot(plan.unitPath);
      undo.push(() => {
        if (unitBefore.bytes !== null) {
          restore(unitBefore);
          try {
            startCollectorService(CURSOR_SERVICE, manager);
          } catch { /* Reported with the failure that caused the rollback. */ }
          return;
        }
        try {
          stopCollectorService(CURSOR_SERVICE, manager);
        } catch { /* It may never have started. */ }
        try {
          removeCollectorUnit(CURSOR_SERVICE, manager);
        } catch { /* The definition is gone; only the reload failed. */ }
      });
      writeCollectorUnit(CURSOR_SERVICE, manager, renderCollectorService(CURSOR_SERVICE, plan.platform, { program: "/bin/sh", args: [files.collectorLauncher] }));
      try {
        startCollectorService(CURSOR_SERVICE, manager);
      } catch {
        throw new Error(`The ${plan.manager ?? "per-user"} service manager did not start the Cursor collector.\n${cursorSupervisorRecipe(files.collectorLauncher)}`);
      }
      done("activate_collector", `Started the background collector (${plan.platform === "linux" ? `systemd user service ${CURSOR_SERVICE.linuxName}` : `LaunchAgent ${CURSOR_SERVICE.macName}`})`);
    } else {
      done("activate_collector", "Installed the collector launcher; no service was installed or started (--hooks-only)");
    }

    if (plan.mergeHooks) {
      // Removing our entries restores the file only if it held none of ours before.
      const hadOurs = cursorHooksState({ hooksFile }) !== "missing", hadBackup = present(`${hooksFile}.codetelemetry-backup`);
      let merged: ReturnType<typeof installCursorHooks> | null = null;
      undo.push(() => {
        if (!hadBackup) fs.rmSync(`${hooksFile}.codetelemetry-backup`, { force: true });
        if (merged && merged.status !== "unchanged" && !hadOurs) {
          removeCursorHooks({ hooksFile, createdByConnect: merged.createdByConnect, createdKeys: merged.createdKeys });
        }
      });
      merged = installCursorHooks({ hooksFile, command: hook.command, createdKeys: config.createdHookKeys });
      const owned = merged.status === "created" ? true : plan.prior?.createdByConnect ?? false;
      if (owned !== config.createdByConnect || JSON.stringify(merged.createdKeys) !== JSON.stringify(config.createdHookKeys)) {
        // The file appeared or vanished since the settings were written, or
        // the keys Connect added are not the ones recorded. This only decides
        // what uninstall may delete (an emptied file, an emptied list), so a
        // failed write here is not a failed install.
        try {
          updateCursorConfig(configPath, { createdByConnect: owned, createdHookKeys: merged.createdKeys });
        } catch { /* Uninstall then treats the file as the settings describe it. */ }
      }
      done("merge_hooks", merged.status === "created" ? `Created ${hooksFile} with the six CodeTelemetry hook entries`
        : merged.status === "updated" ? `Added the six CodeTelemetry hook entries to ${hooksFile}; your other hooks are kept${merged.backupPath ? ` (copy of your file: ${merged.backupPath})` : ""}`
          : `${hooksFile} already holds the six CodeTelemetry hook entries`);
    } else {
      done("merge_hooks", `${hooksFile} was not edited (--hooks-manual)`);
    }

    const reduced = settings.reduced.prompts || settings.reduced.toolDetails || settings.reduced.email;
    // With a service, its restart discards what a turned-off option had put in
    // unsent envelopes. Without one, do it here unless a collector holds the state.
    if (reduced && !plan.service) await reduceStoredRecords(config, host).catch(() => false);

    await release().catch(() => {});
    const hooks = cursorHooksState({ hooksFile, command: hook.command });
    const capture = cursorCaptureSummary(config);
    // --hooks-only installs no service, and leaves one from an earlier login as it is.
    const earlierService = !plan.service && ownsUnit(plan.unitPath);
    const installed: CursorOwnedPath[] = [
      { path: configPath, purpose: "settings and the ingest key, readable only by your user" },
      { path: shareDir, purpose: "hook program, launchers and the collector's own copy of Connect" },
      { path: stateDir, purpose: "records waiting to be sent, and collector state" },
      ...(plan.service || earlierService ? [{ path: plan.unitPath, purpose: "background collector service" }] : []),
      ...(hooks === "missing" ? [] : [{ path: hooksFile, purpose: "CodeTelemetry hook entries; your other hooks are kept" }]),
    ];
    const advice = [
      ...(plan.service ? [] : [earlierService
        ? `--hooks-only installed no service. The collector service from an earlier login (${plan.unitPath}) was left as it is.`
        : `No service runs the collector (--hooks-only). Start it under your own supervisor, or in a terminal that stays open: /bin/sh ${files.collectorLauncher}`]),
      ...(plan.mergeHooks ? [] : [hooks === "installed"
        ? `hooks.json was not edited (--hooks-manual). ${hooksFile} already holds all six CodeTelemetry entries.`
        : `hooks.json was not edited (--hooks-manual). ${hooksFile} holds ${hooks === "partial" ? "only some" : "none"} of the six CodeTelemetry entries. The entries to put under "hooks":\n${cursorHooksManualBlock(hook.command)}`]),
    ];
    const summary = [
      "Installed for Cursor:",
      ...installed.map(item => `  ${item.path}  ${item.purpose}`),
      capture,
      ...(reduced ? ["Records captured earlier and not yet sent are reduced to the new setting before they are sent."] : []),
      ...advice,
      "The Cursor IDE picks the hooks up at once; restart any running cursor-agent session.",
      "Hooks run on the machine where the workspace lives: with Remote-SSH, WSL or a Dev Container, run this command on that host.",
      "Headless runs (cursor-agent -p) report tools and durations, but no prompts and no tokens.",
      CURSOR_PLATFORM_NOTE,
      `Status: ${subcommand("status", settingsFlag(home, configPath))}`,
      `Remove everything, including the stored key and unsent records: ${purgeCommand}`,
    ];
    return { settings, steps, installed, hooks, service: plan.service ? "started" : "not_installed", capture, advice, summary };
  } catch (error) {
    const failed: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (cause) {
        failed.push(errorText(cause));
      }
    }
    await release().catch(() => {});
    removeMade();
    const outcome = failed.length ? `Some files could not be put back (${failed.join("; ")}). Run \`${purgeCommand}\` to remove what is left.`
      : plan.prior ? "The previous installation was put back." : "Nothing was installed.";
    const message = errorText(error);
    throw new Error(`${message}${message.includes("\n") ? "\n" : " "}${outcome}`);
  }
}

/** Discard what a turned-off option had already put in the pending and the
 *  set-aside envelopes. A collector does this whenever it opens its state; this
 *  opens and closes one without sending. False when a collector is running. */
async function reduceStoredRecords(config: CursorConfig, host: CursorHost): Promise<boolean> {
  const collector = new CursorCollector({
    stateDir: config.stateDir, destinationHash: cursorDestinationHash(config), policy: cursorPolicy(config),
    post: async () => { throw new Error("no request is made while reducing stored records"); },
    bootId: host.bootId,
  });
  try {
    await collector.open();
  } catch {
    return false;
  }
  await collector.close();
  return true;
}

// ---------------------------------------------------------------------------
// Enable, disable, uninstall

type Layout = {
  home: string; configPath: string; shareDir: string;
  /** The state directory in use, and the default one when the settings name another. */
  stateDirs: string[];
  hooksFile: string; unitPath: string; config: CursorConfig | null;
  /** `--settings <path>` for printed commands, or nothing at the default path. */
  flag: string;
};

/** Where everything is, from the settings when they can be read and from the
 *  default paths otherwise, so removal works on a damaged installation too. */
function layoutFor(configPath: string, host: CursorHost): Layout {
  const home = host.home ?? os.homedir(), defaults = cursorPaths(home);
  let config: CursorConfig | null = null;
  try {
    config = readCursorConfig(configPath);
  } catch { /* Absent or unreadable. */ }
  return { home, configPath, shareDir: defaults.shareDir, stateDirs: [...new Set([config?.stateDir ?? defaults.stateDir, defaults.stateDir])],
    hooksFile: config?.hooksFile ?? defaults.hooksFile, unitPath: collectorUnitPath(CURSOR_SERVICE, serviceHost(home, host)), config,
    flag: settingsFlag(home, configPath) };
}

/** Whether our service definition is installed. A file that is not ours is never a target. */
function ownsUnit(unitPath: string): boolean {
  try {
    return ownedCollectorUnit(CURSOR_SERVICE, unitPath);
  } catch {
    return false;
  }
}

/** Serialize lifecycle commands on the install directory when there is one. */
async function withInstallLock<T>(shareDir: string, host: CursorHost, action: () => T): Promise<T> {
  if (!realDirectory(shareDir)) return action();
  let release: () => Promise<void>;
  try {
    release = await claimCursorState(shareDir, host.bootId);
  } catch (error) {
    throw busy(error);
  }
  try {
    return action();
  } finally {
    await release().catch(() => {});
  }
}

export type CursorLifecycleResult = {
  ok: boolean;
  detail: string;
  /** What to print, one entry per line or block. */
  lines: string[];
  /** Things left for the user to do by hand. */
  warnings?: string[];
  /** Paths this call deleted. */
  removed?: string[];
  /** Paths still on the machine, each with what it holds. */
  left?: CursorOwnedPath[];
};

/** Turn collection back on with the stored key and capture choices: refresh
 *  the hook program and launchers, start the service and add the hook entries. */
export async function enableCursor(configPath: string, opts: { hooksOnly?: boolean; hooksManual?: boolean; host?: CursorHost } = {}): Promise<CursorLifecycleResult> {
  let stored: CursorConfig;
  try {
    stored = readCursorConfig(configPath);
  } catch {
    return { ok: false, detail: NOT_SET_UP, lines: [NOT_SET_UP] };
  }
  let plan: CursorInstallPlan;
  try {
    plan = cursorPreflight({ configPath, hooksOnly: opts.hooksOnly, hooksManual: opts.hooksManual, network: "stored", host: opts.host });
  } catch (error) {
    if (!(error instanceof CursorPreflightRefusal)) throw error;
    const detail = error.message.replace(/Nothing was installed[.]$/, "Nothing was changed.");
    return { ok: false, detail, lines: [detail] };
  }
  const result = await installCursor(plan, { key: stored.key, ingestEndpoint: stored.ingestEndpoint, checkFormat: false, backup: false });
  const detail = `Cursor collection enabled. ${result.capture}`;
  return { ok: true, detail, lines: [detail, ...result.advice], warnings: result.advice };
}

type Stopped = CursorLifecycleResult & { removed: string[]; warnings: string[]; serviceStopped: boolean };

/** The shared part of disable and uninstall: mark the settings disabled, take
 *  our entries out of hooks.json so nothing spools, and stop the service. With
 *  `uninstall`, the hook pair, the collector launcher and the service
 *  definition go too. */
function stopCollection(layout: Layout, host: CursorHost, uninstall: boolean): Stopped {
  const { config, hooksFile, shareDir } = layout;
  const removed: string[] = [], lines: string[] = [], warnings: string[] = [];
  if (config?.enabled) updateCursorConfig(layout.configPath, { enabled: false });

  const hooks = removeCursorHooks({ hooksFile, createdByConnect: config?.createdByConnect ?? false, createdKeys: config?.createdHookKeys });
  if (hooks.status === "updated") lines.push(`Removed the CodeTelemetry hook entries from ${hooksFile}; your other hooks are untouched.`);
  if (hooks.status === "deleted") {
    removed.push(hooksFile);
    lines.push(`Deleted ${hooksFile}: Connect created it and it held nothing else.`);
    if (config?.createdByConnect) updateCursorConfig(layout.configPath, { createdByConnect: false });
  }
  // An entry that could not be removed runs nothing once the hook pair is gone.
  const ours = realDirectory(shareDir);
  if (ours && (uninstall || hooks.status === "skipped")) removed.push(...removeCursorHookFiles(shareDir));
  if (hooks.status === "skipped") {
    warnings.push(`${hooks.detail ?? `${hooksFile} still holds CodeTelemetry hook entries.`}${ours ? " The hook program was removed, so those entries now do nothing." : ""}`);
  }
  if (!ours && present(shareDir)) warnings.push(`${shareDir} is a link or a file, not a directory. Nothing inside it was touched.`);

  let serviceStopped = true;
  if (ownsUnit(layout.unitPath)) {
    const manager = serviceHost(layout.home, host);
    try {
      stopCollectorService(CURSOR_SERVICE, manager);
      lines.push("Stopped the background collector service.");
    } catch {
      serviceStopped = false;
      lines.push(`The service manager could not confirm that the collector stopped, so ${layout.unitPath} was left in place. Collection is disabled in the settings, so the collector exits on its own. Run the command again when the service manager answers.`);
    }
    if (serviceStopped && uninstall) {
      try {
        removeCollectorUnit(CURSOR_SERVICE, manager);
      } catch { /* The definition is gone; only the reload failed. */ }
      removed.push(layout.unitPath);
    }
  } else if (present(layout.unitPath)) {
    lines.push(`${layout.unitPath} was not written by CodeTelemetry and was left unchanged.`);
  }
  // The launcher stays while a service definition that starts it does.
  const launcher = cursorShareFiles(shareDir).collectorLauncher;
  if (uninstall && serviceStopped && ours && present(launcher)) {
    fs.rmSync(launcher, { force: true });
    removed.push(launcher);
  }
  const detail = !serviceStopped ? `Cursor collection is disabled in the settings, but the service could not be ${uninstall ? "removed" : "stopped"}.`
    : uninstall ? "Cursor collection uninstalled: the hook entries, the hook program, the launchers and the service are removed."
      : `Cursor collection disabled. Records already captured stay in ${layout.stateDirs[0]} and are sent after \`${subcommand("enable", layout.flag)}\`.`;
  return { ok: serviceStopped, detail, lines: [detail, ...lines, ...warnings], warnings, removed, serviceStopped };
}

/** Stop collecting. Settings, the hook program, the runtime copy and unsent
 *  records stay, and `enableCursor` turns collection back on. */
export async function disableCursor(configPath: string, opts: { host?: CursorHost } = {}): Promise<CursorLifecycleResult> {
  const host = opts.host ?? {}, layout = layoutFor(configPath, host);
  if (!layout.config) return { ok: false, detail: NOT_SET_UP, lines: [NOT_SET_UP] };
  const { serviceStopped: _unused, ...result } = await withInstallLock(layout.shareDir, host, () => stopCollection(layout, host, false));
  return result;
}

const STATE_PURPOSES: Readonly<Record<string, string>> = {
  spool: `records waiting to be sent; ${CONTENT_NOTE}`,
  "pending.json": `the batch being sent; ${CONTENT_NOTE}`,
  rejected: `batches the service refused; ${CONTENT_NOTE}`,
  "checkpoint.json": "what has been read and sent",
  "health.json": "the collector's last status",
  dropped: "count of events the hook could not record",
  "spool-size": "the hook's running total of the spool's size",
  "node-path": "Node.js path the hook found",
  "node-stale": "marker: the recorded Node.js path is gone",
  "collector.lock": "collector lock",
  "retry-rejected": "a waiting retry request",
};
const SHARE_PURPOSES: Readonly<Record<string, string>> = {
  "hook.sh": "hook launcher",
  "hook.cjs": "hook program",
  "collector.sh": "collector launcher",
  "collector.lock": "install lock",
};
const UNKNOWN_PURPOSE = "not written by this version of Connect";

function entries(directory: string): string[] {
  const names: string[] = [];
  let handle: fs.Dir;
  try {
    if (!fs.lstatSync(directory).isDirectory()) return names;
    handle = fs.opendirSync(directory, { bufferSize: 32 });
  } catch {
    return names;
  }
  try {
    for (let entry = handle.readSync(); entry && names.length < LISTED_ENTRIES; entry = handle.readSync()) names.push(entry.name);
  } finally {
    handle.closeSync();
  }
  return names.sort();
}

/** Every path of ours still on the machine. A directory is listed after its
 *  entries and stands for everything inside it. */
function remaining(layout: Layout): CursorOwnedPath[] {
  const left: CursorOwnedPath[] = [];
  const add = (file: string, purpose: string): void => {
    if (present(file)) left.push({ path: file, purpose });
  };
  // A --settings path that holds something else is not ours to list or delete.
  if (layout.config || !layout.flag) {
    add(layout.configPath, "settings; holds the ingest key in plain text");
    add(`${layout.configPath}.previous`, "previous settings; holds an ingest key in plain text");
  }
  for (const stateDir of layout.stateDirs) {
    for (const name of entries(stateDir)) add(path.join(stateDir, name), STATE_PURPOSES[name] ?? UNKNOWN_PURPOSE);
    add(stateDir, "collector state directory, with everything in it");
  }
  for (const name of entries(layout.shareDir)) {
    add(path.join(layout.shareDir, name), RUNTIME.test(name) ? "copy of the Connect runtime the collector ran from" : SHARE_PURPOSES[name] ?? UNKNOWN_PURPOSE);
  }
  add(layout.shareDir, "install directory, with everything in it");
  add(`${layout.hooksFile}.codetelemetry-backup`, "your hooks.json as it was before the first install");
  if (ownsUnit(layout.unitPath)) add(layout.unitPath, "background collector service definition");
  return left;
}

/** Wait for a collector that is shutting down. False when one still holds the state. */
async function collectorGone(stateDir: string, host: CursorCommandHost): Promise<boolean> {
  const sleep = host.sleep ?? ((ms: number) => delay(ms).then(() => {}));
  for (let waited = 0; ; waited += 250) {
    try {
      await (await claimCursorState(stateDir, host.bootId))();
      return true;
    } catch (error) {
      // Only a live owner is a reason to wait. A lock nobody can be shown to hold is not.
      if (!/already running/.test(errorText(error))) return true;
      if (waited >= PURGE_WAIT_MS) return false;
      await sleep(250);
    }
  }
}

/** Delete one of our two directories. A link is never followed or removed, and
 *  a directory whose name is not ours is left alone, whatever the settings say. */
function purgeDirectory(directory: string, removed: string[], kept: string[]): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    kept.push(`${directory} is a link or a file, not a directory. It was not followed or removed.`);
    return;
  }
  if (!ownDirectory(directory)) {
    kept.push(`${directory} is not one of CodeTelemetry's own directories (.../codetelemetry/cursor-hooks-v1). It was not removed.`);
    return;
  }
  fs.rmSync(directory, { recursive: true, force: true });
  removed.push(directory);
}

function purgeFile(file: string, removed: string[]): void {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  // A link is unlinked itself; its target is never touched.
  if (!stat || stat.isDirectory()) return;
  fs.rmSync(file, { force: true });
  removed.push(file);
}

/** Remove the hook entries, the hook program, the launchers and the service.
 *  Settings, the runtime copy and state stay unless `purge` is set; the result
 *  lists every path left and what it holds. */
export async function uninstallCursor(configPath: string, opts: { purge?: boolean; host?: CursorCommandHost } = {}): Promise<CursorLifecycleResult> {
  const host = opts.host ?? {}, layout = layoutFor(configPath, host);
  if (!remaining(layout).length && cursorHooksState({ hooksFile: layout.hooksFile }) === "missing") {
    const detail = "Nothing of the Cursor collector is installed on this machine.";
    return { ok: true, detail, lines: [detail], removed: [], left: [] };
  }
  const stopped = await withInstallLock(layout.shareDir, host, () => stopCollection(layout, host, true));
  const lines = [...stopped.lines], removed = [...stopped.removed];
  let ok = stopped.ok;

  // State is never deleted under a collector that is still alive.
  let held: string | undefined;
  if (opts.purge && stopped.serviceStopped) {
    for (const stateDir of layout.stateDirs) {
      if (!held && realDirectory(stateDir) && ownDirectory(stateDir) && !(await collectorGone(stateDir, host))) held = stateDir;
    }
  }
  if (opts.purge && !stopped.serviceStopped) {
    lines.push("Nothing was purged, because the service could not be removed.");
  } else if (opts.purge && held) {
    ok = false;
    lines.push(`A Cursor collector process is still running and holds ${held}, so nothing was purged. Stop it and run the command again.`);
  } else if (opts.purge) {
    const kept: string[] = [], purged: string[] = [];
    for (const stateDir of layout.stateDirs) purgeDirectory(stateDir, purged, kept);
    purgeDirectory(layout.shareDir, purged, kept);
    // The default settings path is ours by name; a --settings path only when it holds our settings.
    if (layout.config || !layout.flag) {
      for (const suffix of ["", ".previous", ".tmp", ".previous.tmp"]) purgeFile(`${layout.configPath}${suffix}`, purged);
    } else if (present(layout.configPath)) {
      kept.push(`${layout.configPath} does not hold Cursor collector settings. It was not removed.`);
    }
    for (const file of [`${layout.hooksFile}.codetelemetry-backup`, `${layout.hooksFile}.codetelemetry-tmp`, `${layout.unitPath}.tmp`]) purgeFile(file, purged);
    // A parent named "codetelemetry" goes only when nothing else is in it.
    for (const directory of [path.dirname(layout.configPath), path.dirname(layout.shareDir), ...layout.stateDirs.map(stateDir => path.dirname(stateDir))]) {
      if (path.basename(directory) !== "codetelemetry") continue;
      try {
        fs.rmdirSync(directory);
      } catch { /* Holds other CodeTelemetry files, or is already gone. */ }
    }
    removed.push(...purged);
    lines.push(...purged.map(file => `Deleted ${file}`), ...kept);
    if (kept.length) ok = false;
  }

  const left = remaining(layout);
  if (!left.length) lines.push("Nothing of the Cursor collector is left on this machine.");
  else {
    lines.push(opts.purge ? "Still on this machine:" : "Left on this machine:", ...left.map(item => `  ${item.path}  ${item.purpose}`));
    if (!opts.purge) lines.push(`Run \`${subcommand("uninstall --purge", layout.flag)}\` to delete them.`);
  }
  return { ok, detail: stopped.detail, lines, warnings: stopped.warnings, removed, left };
}

// ---------------------------------------------------------------------------
// Status

export type CursorStatus = {
  /** A collector process answers and made a pass in the last 30 seconds. */
  running: boolean;
  enabled: boolean;
  capture: { prompts: boolean; toolDetails: boolean };
  identity: { email: boolean };
  /** The capture mode line `login` prints. */
  mode: string;
  hooks: HooksState;
  service: "installed" | "not_installed";
  /** Host and port of the recorded proxy; credentials are never shown. */
  proxy: string | null;
  /** False while the recorded Node.js path is gone or no launcher candidate can run. */
  nodePathValid: boolean;
  /** The collector's own counters; null until it has reported. */
  health: CursorHealthFile | null;
  /** What needs attention, in plain sentences. */
  notices: string[];
  paths: { config: string; stateDir: string; hooksFile: string };
};

function executable(file: string | undefined): boolean {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function firstLine(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return undefined;
    return fs.readFileSync(file, "utf8").split("\n", 1)[0];
  } catch {
    return undefined;
  }
}

export const CURSOR_NODE_NOTICE = "The Cursor collector's Node.js path changed; run `login --client cursor` again to refresh it.";

/** The notice every Connect command shows while the hook reports that the
 *  recorded interpreter is gone. Null when there is nothing to say; never throws. */
export function cursorNodeNotice(home?: string): string | null {
  try {
    const file = resolveCursorConfigPath({ home });
    if (!present(file)) return null;
    return present(cursorStateFiles(readCursorConfig(file).stateDir).nodeStale) ? CURSOR_NODE_NOTICE : null;
  } catch {
    return null;
  }
}

function deliveryNotice(health: CursorHealthFile, flag: string): string | null {
  switch (health.lastOutcome) {
    case "auth": return `The ingest key was refused. Run \`${CURSOR_LOGIN_COMMAND}\` again.`;
    case "budget": return "The workspace is out of credit. Records wait in the spool and are retried every 15 minutes.";
    case "unsupported": return "The service does not accept Cursor records yet. Records wait in the spool and are retried every 15 minutes; none is set aside.";
    case "rejected": return `The service refused the last batch. It is retried for 24 hours and then set aside; \`${subcommand("retry-rejected", flag)}\` sends set-aside batches again.`;
    case "retry": return "The service asked the collector to retry. Delivery resumes on its own.";
    case "network":
      if (health.lastErrorClass === "proxy") {
        return `The proxy did not answer. To record proxy settings for the collector, export HTTPS_PROXY (and NO_PROXY if needed) and run \`${CURSOR_LOGIN_COMMAND}\` again; add --no-proxy-settings to clear them.`;
      }
      if (health.lastErrorClass === "tls") {
        return `The TLS connection failed. If your network uses its own certificate authority, export NODE_EXTRA_CA_CERTS=<file> and run \`${CURSOR_LOGIN_COMMAND}\` again.`;
      }
      return `The ingest endpoint could not be reached (${health.lastErrorClass ?? "network"}). Delivery is retried on its own.`;
    default: return null;
  }
}

/** What `cursor status` reports. Null when no settings can be read. Reads only. */
export async function cursorStatus(configPath: string, host: CursorHost = {}): Promise<CursorStatus | null> {
  const layout = layoutFor(configPath, host), config = layout.config;
  if (!config) return null;
  const state = cursorStateFiles(config.stateDir), share = cursorShareFiles(layout.shareDir);
  const enable = subcommand("enable", layout.flag);
  const health = await readCursorHealth(config.stateDir);
  const now = (host.now ?? Date.now)();
  let running = false;
  if (health?.running && health.pid > 0 && now - health.lastTickAt >= 0 && now - health.lastTickAt < 30_000) {
    try {
      process.kill(health.pid, 0);
      running = true;
    } catch { /* No such process. */ }
  }
  const hooks = cursorHooksState({ hooksFile: config.hooksFile, command: share.hook });
  const service = ownsUnit(layout.unitPath) ? "installed" : "not_installed";
  const nodePathValid = !present(state.nodeStale) && [config.node.execPath, config.node.commandPath, firstLine(state.nodePath)].some(executable);

  const notices: string[] = [];
  if (!config.enabled) notices.push(`Collection is disabled. \`${enable}\` turns it back on.`);
  if (!nodePathValid) notices.push(CURSOR_NODE_NOTICE);
  if (config.enabled && hooks !== "installed") {
    notices.push(`${config.hooksFile} holds ${hooks === "partial" ? "only some" : "none"} of the six CodeTelemetry hook entries, so Cursor reports ${hooks === "partial" ? "only part of each session" : "nothing"}. ` +
      `Another tool may have rewritten the file; \`${enable}\` adds them back.`);
  }
  if (config.enabled && !running) {
    notices.push(service === "installed"
      ? `The collector is not running. Records wait in the spool (at most 128 MiB) for up to 14 days; \`${enable}\` starts it again.${(host.platform ?? process.platform) === "linux" ? " A systemd user service stops at logout unless lingering is enabled for your user." : ""}`
      : `No collector is running and no service is installed. Start it under your own supervisor, or in a terminal that stays open: /bin/sh ${share.collectorLauncher}`);
  }
  if (health) {
    const delivery = deliveryNotice(health, layout.flag);
    if (delivery) notices.push(delivery);
    if (health.hookDrops > 0) notices.push(`${health.hookDrops} event(s) could not be recorded by the hook (a spool at its 128 MiB bound, oversized input or a failed write).`);
    if (health.rejectedEnvelopes > 0) notices.push(`${health.rejectedEnvelopes} refused batch(es) are set aside (${health.rejectedBytes} bytes). \`${subcommand("retry-rejected", layout.flag)}\` sends them again.`);
  }
  return {
    running, enabled: config.enabled,
    capture: { prompts: config.content.prompts, toolDetails: config.content.toolDetails },
    identity: { email: config.identity.email },
    mode: cursorCaptureSummary(config),
    hooks, service, proxy: cursorProxyDisplay(config.network), nodePathValid, health, notices,
    paths: { config: layout.configPath, stateDir: config.stateDir, hooksFile: config.hooksFile },
  };
}

function ago(now: number, then: number | null): string {
  if (then === null || then <= 0) return "never";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  return seconds < 120 ? `${seconds}s ago` : seconds < 7200 ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 3600)} h ago`;
}

function statusLines(status: CursorStatus, now: number): string[] {
  const health = status.health;
  return [
    `Cursor collection: ${status.enabled ? "enabled" : "disabled"}; collector ${status.running ? `running (pid ${health?.pid})` : "not running"}; service ${status.service === "installed" ? "installed" : "not installed"}`,
    `Hooks: ${status.hooks} (${status.paths.hooksFile})`,
    status.mode,
    ...(status.proxy ? [`Proxy: ${status.proxy}`] : []),
    ...(health ? [
      `Last pass ${ago(now, health.lastTickAt)}; last accepted delivery ${ago(now, health.lastAckAt)}; last answer: ${health.lastDetail ?? "none yet"}`,
      `Records: ${health.recordsSpooled} read, ${health.recordsAcknowledged} sent, ${health.pendingRecords} being sent; ${health.recordsMalformed} malformed, ${health.recordsExpired} expired, ${health.recordsRejected} refused, ${health.recordsLost} lost; ${health.hookDrops} dropped by the hook`,
      `Spool: ${health.spoolBytes} of at most ${CURSOR_HOOK_LIMITS.spoolBytes} bytes in ${health.spoolSegments} segment(s), ${health.backlogBytes} not yet read; set aside: ${health.rejectedEnvelopes} batch(es), ${health.rejectedBytes} bytes`,
    ] : ["The collector has not reported yet."]),
    ...status.notices,
  ];
}

/** What `status --json` shows for a collector that has not reported yet. */
const NO_HEALTH: CursorHealthFile = {
  version: 1, status: "idle", lastTickAt: 0, lastOutcome: null, lastDetail: null, lastErrorClass: null, lastAckAt: null, nextAttemptAt: null,
  pendingRecords: 0, recordsSpooled: 0, recordsAcknowledged: 0, recordsMalformed: 0, recordsExpired: 0, recordsRejected: 0, recordsLost: 0,
  envelopesReframed: 0, requests: 0, requestsLastMinute: 0, rejectedBytes: 0, rejectedEnvelopes: 0, hookDrops: 0, spoolBytes: 0,
  spoolSegments: 0, backlogBytes: 0, running: false, pid: 0,
};

/** `cursor status --json`: one flat object with the same keys every time. The
 *  collector's counters keep their names, its own status is `delivery` (null
 *  until it has reported), and `running` is this command's judgement. */
function statusJson(status: CursorStatus): Record<string, unknown> {
  const { health, ...rest } = status;
  const { running: _reported, version: _version, status: delivery, ...counters } = health ?? NO_HEALTH;
  return { installed: true, ...rest, delivery: health ? delivery : null, ...counters };
}

// ---------------------------------------------------------------------------
// The `cursor ...` subcommands

type Flags = Record<string, string | boolean | undefined>;
/** `CursorHost` plus what only the subcommands need. Tests inject all of it. */
export type CursorCommandHost = CursorHost & {
  fetchImpl?: FetchLike;
  /** Sent with every envelope as the Connect release that framed it. */
  connectVersion?: string;
  sleep?: (ms: number) => Promise<void>;
};

const OPERATIONS = ["status", "collect", "enable", "disable", "uninstall", "retry-rejected"] as const;
const USAGE = `Usage: codetelemetry-connect cursor ${OPERATIONS.join("|")} [--settings <path>] [--json]; collect takes --once, enable takes --hooks-only and --hooks-manual, uninstall takes --purge.`;
const SWITCHES: Readonly<Record<string, readonly string[]>> = {
  json: OPERATIONS, once: ["collect"], "hooks-only": ["enable"], "hooks-manual": ["enable"], purge: ["uninstall"],
};

/** What a running collector is bound to. A change to any of it needs a new process. */
const binding = (config: CursorConfig): string =>
  createHash("sha256").update(JSON.stringify([config.key, config.ingestEndpoint, config.stateDir, config.content, config.identity, config.network])).digest("hex");

async function collect(file: string, once: boolean, out: (line: string) => void, host: CursorCommandHost): Promise<number> {
  if (Number((host.nodeVersion ?? process.versions.node).split(".")[0]) < CURSOR_NODE_MAJOR) {
    out(`Cursor collection requires Node.js ${CURSOR_NODE_MAJOR} or newer.`);
    return 1;
  }
  const config = readCursorConfig(file);
  // Exit 0, so a service that restarts on failure stays stopped while collection is disabled.
  if (!config.enabled) {
    out(`Cursor collection is disabled. \`${subcommand("enable", settingsFlag(host.home ?? os.homedir(), file))}\` turns it on.`);
    return 0;
  }
  const bound = binding(config);
  const collector = new CursorCollector({
    stateDir: config.stateDir, destinationHash: cursorDestinationHash(config), policy: cursorPolicy(config),
    post: cursorTransport({ endpoint: config.ingestEndpoint, key: config.key, fetchImpl: host.fetchImpl, env: host.env }),
    connectVersion: host.connectVersion, now: host.now, bootId: host.bootId,
  });
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let exit = 0, opened = false;
  try {
    await collector.open();
    opened = true;
    const health = await runCursorCollector(collector, {
      signal: abort.signal, once,
      // Asked before every pass: a collector holding wider capture options
      // than the settings now allow must not frame another envelope.
      proceed: () => {
        let current: CursorConfig;
        try {
          current = readCursorConfig(file);
        } catch {
          exit = 1;
          return false;
        }
        if (!current.enabled) return false;
        if (binding(current) === bound) return true;
        out("Cursor collector settings changed; a restart applies them. Unsent records are kept.");
        exit = 1;
        return false;
      },
      report: health => writeCursorHealth(config.stateDir, health, { running: !once, pid: process.pid }),
      ...(host.sleep ? { sleep: (ms: number) => host.sleep!(ms) } : {}),
    });
    if (once) {
      out(JSON.stringify(health));
      if (health.status !== "idle") exit = 1;
    }
  } finally {
    try {
      if (opened) await writeCursorHealth(config.stateDir, collector.snapshot(), { running: false, pid: process.pid });
    } finally {
      try {
        await collector.close();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
  }
  return exit;
}

export async function runCursorCommand(args: string[], flags: Flags, out: (line: string) => void, host: CursorCommandHost = {}): Promise<number> {
  const operation = args[0] ?? "status";
  if (args.length > 1 || !(OPERATIONS as readonly string[]).includes(operation)) {
    out(USAGE);
    return 1;
  }
  for (const [name, value] of Object.entries(flags)) {
    if (name === "settings") {
      if (typeof value !== "string" || !value.trim()) {
        out("--settings needs a path.");
        return 1;
      }
    } else if (!SWITCHES[name]?.includes(operation)) {
      out(`Unknown option --${name} for cursor ${operation}.\n${USAGE}`);
      return 1;
    } else if (value !== true) {
      out(`--${name} takes no value.`);
      return 1;
    }
  }
  const file = resolveCursorConfigPath({ path: typeof flags.settings === "string" ? flags.settings : undefined, home: host.home });
  const json = flags.json === true;
  const finish = (result: CursorLifecycleResult): number => {
    if (json) out(JSON.stringify({ ok: result.ok, detail: result.detail, warnings: result.warnings, removed: result.removed, left: result.left }));
    else for (const line of result.lines) out(line);
    return result.ok ? 0 : 1;
  };

  if (operation === "collect") return collect(file, flags.once === true, out, host);
  if (operation === "enable") {
    return finish(await enableCursor(file, { hooksOnly: flags["hooks-only"] === true, hooksManual: flags["hooks-manual"] === true, host }));
  }
  if (operation === "disable") return finish(await disableCursor(file, { host }));
  if (operation === "uninstall") return finish(await uninstallCursor(file, { purge: flags.purge === true, host }));

  const status = await cursorStatus(file, host);
  if (!status) {
    out(json ? JSON.stringify({ installed: false, detail: NOT_SET_UP }) : NOT_SET_UP);
    return 1;
  }
  const now = (host.now ?? Date.now)();
  if (operation === "retry-rejected") {
    const { envelopes } = await requestCursorRetryRejected(status.paths.stateDir, now);
    const detail = envelopes === 0 ? "No refused batches are set aside; there is nothing to send again."
      : `${envelopes} set-aside batch(es) will be sent again ${status.running ? "by the running collector" : "when the collector next starts"}.`;
    out(json ? JSON.stringify({ ok: true, envelopes, detail }) : detail);
    return 0;
  }
  if (json) out(JSON.stringify(statusJson(status)));
  else for (const line of statusLines(status, now)) out(line);
  return 0;
}
