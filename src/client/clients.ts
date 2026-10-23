// The clients onboarding can configure, one descriptor each: where the client
// reads its config, how its OTEL block is written and read back, and what the
// config looks like without a key. The CLI (`--client`), the MCP tools
// (`client`) and the onboard orchestrator all resolve a client here, so a new
// client is one descriptor (plus its writer), not another claude/codex ternary.
// The set of ids is ONBOARD_CLIENTS (assistants.ts), the registry's twin.

import fs from "node:fs";
import {resolveKiroConfigPath, writeKiroConfig, readKiroKey, readKiroSummary} from "./kiro/config.ts";
import { resolveSettingsPath, type SettingsScope } from "./config.ts";
import { buildEnvBlock, readSettingsSummary, writeSettings, type WriteResult } from "./settings.ts";
import { buildOtelSection, readCodexKey, readCodexSummary, resolveCodexConfigPath, writeCodexConfig } from "./codexConfig.ts";
import { buildPiOtelBlock, readPiKey, readPiSummary, resolvePiConfigPath, writePiConfig } from "./piConfig.ts";
import { ONBOARD_CLIENTS, isOnboardClient, type OnboardClient } from "./assistants.ts";

export type ClientSummary = {
  exists: boolean;
  otelKeys: string[];
  hasKey: boolean;
  /** pi only: whether its pi-otel exporter extension appears installed. */
  extensionInstalled?: boolean;
};

export type ClientDescriptor = {
  id: OnboardClient;
  label: string;
  /** What the written settings are called in progress lines. */
  noun: string;
  /** The CLI flag that selects this client (empty for the default). */
  cliFlag: string;
  resolveConfigPath(opts: { scope?: SettingsScope; path?: string }): string;
  write(opts: { key: string; ingestEndpoint: string; configPath: string; enrich?: boolean; repositoryObservation?: boolean; backup?: boolean }): WriteResult;
  readKey(configPath: string): string | null;
  readSummary(configPath: string): ClientSummary;
  /** The config block with a placeholder key (print-config). */
  printConfig(ingestEndpoint: string, enrich: boolean): string;
};

/** Claude Code's configured key: the bearer token in its OTLP headers env. */
export function readClaudeKey(settingsPath: string): string | null {
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const headers = JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.env?.OTEL_EXPORTER_OTLP_HEADERS;
    const match = typeof headers === "string" ? /Bearer\s+(cot_[A-Za-z0-9_-]+)/.exec(headers) : null;
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export const CLIENTS: Readonly<Record<OnboardClient, ClientDescriptor>> = Object.freeze({
  kiro: {
    id:"kiro",label:"Kiro",noun:"collector settings",cliFlag:" --client kiro",
    resolveConfigPath:opts=>resolveKiroConfigPath({path:opts.path}),write:writeKiroConfig,readKey:readKiroKey,readSummary:readKiroSummary,
    printConfig:(ingestEndpoint,enrich)=>JSON.stringify({kind:"codetelemetry-kiro-v3",version:1,enabled:true,key:"cot_<YOUR_INGEST_KEY>",ingestEndpoint,
      sourceRoot:"<HOME>/.kiro/sessions",stateDir:"<HOME>/.local/state/codetelemetry/kiro-v3",backfill:false,content:{prompts:enrich,toolDetails:enrich}},null,2),
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    noun: "OTEL vars",
    cliFlag: "",
    resolveConfigPath: (opts) => resolveSettingsPath({ scope: opts.scope, path: opts.path }),
    write: (opts) => writeSettings({
      key: opts.key, ingestEndpoint: opts.ingestEndpoint, settingsPath: opts.configPath, enrich: opts.enrich, repositoryObservation: opts.repositoryObservation, backup: opts.backup,
    }),
    readKey: readClaudeKey,
    readSummary: readSettingsSummary,
    printConfig: (ingestEndpoint, enrich) =>
      JSON.stringify({ env: buildEnvBlock("<YOUR_INGEST_KEY>", ingestEndpoint, enrich) }, null, 2),
  },
  codex: {
    id: "codex",
    label: "Codex",
    noun: "OTEL keys",
    cliFlag: " --codex",
    // `--scope project` is a Claude concept; for Codex an explicit path is the
    // only override.
    resolveConfigPath: (opts) => resolveCodexConfigPath({ path: opts.path }),
    write: (opts) => writeCodexConfig({
      key: opts.key, ingestEndpoint: opts.ingestEndpoint, configPath: opts.configPath, enrich: opts.enrich, repositoryObservation: opts.repositoryObservation, backup: opts.backup,
    }),
    readKey: readCodexKey,
    readSummary: readCodexSummary,
    printConfig: (ingestEndpoint, enrich) => buildOtelSection("cot_<YOUR_INGEST_KEY>", ingestEndpoint, enrich),
  },
  pi: {
    id: "pi",
    label: "pi",
    noun: "otel settings",
    cliFlag: " --client pi",
    resolveConfigPath: (opts) => resolvePiConfigPath({ path: opts.path }),
    write: (opts) => writePiConfig({
      key: opts.key, ingestEndpoint: opts.ingestEndpoint, configPath: opts.configPath, enrich: opts.enrich, backup: opts.backup,
    }),
    readKey: readPiKey,
    readSummary: readPiSummary,
    printConfig: (ingestEndpoint, enrich) =>
      JSON.stringify({ otel: buildPiOtelBlock("cot_<YOUR_INGEST_KEY>", ingestEndpoint, enrich) }, null, 2),
  },
});

/** What a pi user still has to do once its config is written. */
export const PI_EXTENSION_HINT = "pi exports through its pi-otel extension: run `pi install npm:pi-otel` once, then start pi.";

/** Resolve a `--client` / MCP `client` value; undefined means Claude Code. */
export function resolveClient(name: unknown): ClientDescriptor {
  if (name === undefined) return CLIENTS.claude;
  if (isOnboardClient(name)) return CLIENTS[name];
  throw new Error(`unknown client ${JSON.stringify(name)} (expected one of: ${ONBOARD_CLIENTS.join(", ")})`);
}
