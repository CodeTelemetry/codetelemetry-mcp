// Zero-dependency CLI. Subcommands:
//   codetelemetry-connect <cot_key>     fast path: write config + test + verify
//   codetelemetry-connect login         device flow → key → write + test + verify
//   codetelemetry-connect doctor        re-fire a probe with the configured key
//   codetelemetry-connect print-config  print the settings.json block (no key)
//
// The key is only ever read from disk / the device flow and used in-process; the
// CLI prints it masked and never echoes the plaintext.

import fs from "node:fs";
import { runKiroCommand } from "./kiro/command.ts";
import { spawn } from "node:child_process";
import { onboard, type OnboardClient } from "./onboard.ts";
import { resolveEndpoints, type SettingsScope } from "./config.ts";
import { CLIENTS, PI_EXTENSION_HINT } from "./clients.ts";
import { ONBOARD_CLIENTS, isOnboardClient } from "./assistants.ts";
import { looksLikeKey, mask } from "./keys.ts";
import { runImport } from "./import/run.ts";
import { parseContentFlag, parseWhen, resolveImportContent, resolveImportKey } from "./import/options.ts";
import { requestDeviceCode, pollForKey } from "./deviceClient.ts";
import { sendTestEvent } from "./otlp.ts";
import { confirmLanded, verifyScope } from "./connectivity.ts";
import type { ExpectedKeyScope } from "./connectivity.ts";
import {
  DEFAULT_KEY_ENV,
  defaultHostMetricsPaths,
  defaultInstanceId,
  hostMetricsOptionsFromFlags,
  renderHostMetricsConfig,
  writeHostMetricsConfig,
  type HostMetricsOptions,
} from "./hostMetrics.ts";

type Parsed = { _: string[]; flags: Record<string, string | boolean> };

function parse(argv: string[]): Parsed {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
      } else if (body.includes("=")) {
        const [k, v] = body.split(/=(.*)/s);
        flags[k] = v;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

const HELP = `codetelemetry-connect — wire Claude Code, OpenAI Codex or pi into CodeTelemetry

Usage:
  codetelemetry-connect <cot_key> [options]   Write config, send a test event, confirm it landed
  codetelemetry-connect login [options]       Authenticate via device code, then do the above
  codetelemetry-connect doctor [options]      Re-test the already-configured key
  codetelemetry-connect print-config          Print the config block (no key)
  codetelemetry-connect host-metrics [opts]   Write the OpenTelemetry Collector
                                              config that reports host + agentd
                                              process health (see below)
  codetelemetry-connect kiro status|collect|enable|disable|uninstall
                                           Manage the background V3 transcript collector
  codetelemetry-connect import [opts]         Backfill past Claude Code / Codex
                                              sessions from local history files
                                              (see below)

Options:
  --client claude|codex|pi|kiro
                         Which coding agent to configure (default claude).
                         pi: write the otel block of ~/.pi/agent/settings.json
                         (traces only; pi also needs its exporter extension:
                         \`pi install npm:pi-otel\`).
  --codex                Same as --client codex. Target OpenAI Codex: write the [otel] section of
                         ~/.codex/config.toml (or \$CODEX_HOME/config.toml when set)
                         instead of Claude Code's settings.json. (Codex needs the
                         literal key in the file — it does not expand \${VAR}
                         placeholders — which is why this flag exists.)
  --scope user|project   Which settings.json to write (default: user → ~/.claude/settings.json)
  --settings <path>      Explicit config path (overrides --scope; with --codex,
                         overrides ~/.codex/config.toml; with --client pi,
                         ~/.pi/agent/settings.json)
  --api-base <url>       Onboarding API base (default: https://codetelemetry.com)
  --endpoint <url>       OTLP ingest endpoint (default: https://ingest.codetelemetry.com)
  --enrich               Also enable prompt/body/tool-content flags (richer dashboards)
  --no-open              On \`login\`, don't auto-open the browser (just print the URL)
  --no-test              Skip sending the test event
  --no-verify            Skip waiting for the probe to land
  --expect-team <id>     Require this organization
  --expect-personal      Require a personal key (never accept an org key)
  --expect-tenant <id>   Require the key owner tenant
  --expect-billing-account <id>
                         Require this billing account attribution
  --json                 Emit a JSON result instead of prose
  -h, --help             Show this help

host-metrics options:
  --out <path>           Where to write the collector config
                         (default: per-platform, printed by --print)
  --print                Print the config to stdout instead of writing it
  --instance <id>        service.instance.id (default: this machine's hostname)
  --env <name>           deployment.environment (default: production)
  --interval <seconds>   Scrape interval, 10-3600 (default: 60)
  --gateway <url>        Export to a user-managed collector instead of
                         CodeTelemetry directly; that collector fans out
  --key-env <VAR>        Env var the collector reads the ingest key from
                         (default: ${DEFAULT_KEY_ENV}). The key is never
                         written into the config file.
  --no-auth              Omit the Authorization header (trusted gateway only)
  --allow-insecure       Permit a plaintext http:// endpoint
  --queue-dir <path>     On-disk sending queue (survives collector restarts)
  --no-queue-dir         Use an in-memory queue instead
  --queue-size <n>       Max batches queued before backpressure (default: 1000)
  --memory-limit <mib>   Collector memory ceiling (default: 128)
  --processes <a,b,c>    Executable names counted as agentd process health
  --interfaces           Keep per-interface network breakdown (off by default)
  --mounts               Keep per-mount filesystem breakdown (off by default)

import options:
  Reads ~/.claude/projects/**/*.jsonl (Claude Code) and ~/.codex/sessions/**
  (Codex) locally and sends them as telemetry through the normal ingest, tagged
  ingest.source=history-import. Sessions already captured live, or already
  imported, are skipped; an interrupted import resumes on the next run.
  Imported history has tokens, prompts and tool results, but no per-request
  latency, retries, permission decisions or active time.
  --dry-run              Parse, check and summarize; send nothing
  --source claude-code|codex|all   Which history to read (default: all; --client
                         claude|codex narrows it too). pi is refused: it keeps
                         no local transcripts the importer reads
  --since <Nd|date>      Window start (default: 30d; at most 364d — raw
                         telemetry is kept 365 days by event time)
  --until <Nd|date>      Window end (default: now)
  --project <path>       Only sessions whose working directory is under <path>
  --email <addr>         Stamp user.email on imported rows
  --content none|live|all|prompts,tools
                         Text to include (default: live — exactly what your
                         live exporters send: Claude OTEL_LOG_USER_PROMPTS /
                         OTEL_LOG_TOOL_DETAILS in settings.json, Codex
                         log_user_prompt). none = counts, sizes, models and
                         tool names only; all / prompts,tools = explicit opt-in
  --max-sessions <n>     Send at most n sessions this run
  --rate <n>             Ingest requests per minute (default: 120, max: 300;
                         the key's 600/min limit is shared with live telemetry)
  --time-limit <min>     Stop after this many minutes (default: 60); re-run to continue
  --key-env <VAR>        Env var holding the key (default: CODETELEMETRY_INGEST_KEY);
                         otherwise the key comes from the configured client
                         (--source codex: ~/.codex/config.toml first)
  --codex-config <path>  Codex config to read the key from (default: ~/.codex/config.toml)
  --json                 Emit the full result as JSON`;

function out(line: string): void {
  process.stdout.write(line + "\n");
}

/** Best-effort: open the default browser to `url` (like `gh auth login`). The URL
 *  is always printed too, so a failure here is harmless. Returns false only if we
 *  couldn't even spawn the opener. */
function openBrowser(url: string): boolean {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // opener missing (e.g. headless) → ignore; the URL was printed
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function pickScope(flags: Parsed["flags"]): SettingsScope {
  return flags.scope === "project" ? "project" : "user";
}

/** The client named by `--client` (or its `--codex` alias); a string is the
 *  reason the flags name none. */
function pickClient(flags: Parsed["flags"]): OnboardClient | string {
  const named = flags.client;
  if (named === undefined) return flags.codex ? "codex" : "claude";
  if (typeof named !== "string" || !isOnboardClient(named)) {
    return `--client must be one of ${ONBOARD_CLIENTS.join(", ")}.`;
  }
  if (flags.codex && named !== "codex") return `--codex conflicts with --client ${named}.`;
  return named;
}


const str = (flags: Parsed["flags"], key: string): string | undefined =>
  typeof flags[key] === "string" ? (flags[key] as string) : undefined;

const hasFlag = (flags: Parsed["flags"], key: string): boolean =>
  Object.prototype.hasOwnProperty.call(flags, key);

/** A whole number of `unit`s, or null when the flag is present but unusable. A
 *  bad number must be a usage error, never a silently-defaulted policy. */
function intFlag(flags: Parsed["flags"], key: string): number | null | undefined {
  if (!hasFlag(flags, key)) return undefined;
  const raw = str(flags, key);
  if (raw === undefined) return null; // present with no value
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A flag that must carry a non-empty value when present: `undefined` absent,
 *  `null` present-but-unusable.
 *
 *  Both unusable shapes are real hazards on the dispatch commands. `--instance`
 *  with no value parses to `true` and would silently fall back to the local
 *  host; `--instance=` parses to `""`, which is not a host id at all. Neither
 *  may be quietly reinterpreted as a different targeting mode. */
function textFlag(flags: Parsed["flags"], key: string): string | null | undefined {
  if (!hasFlag(flags, key)) return undefined;
  const raw = flags[key];
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

/** A flag that is only ever a bare switch. `--any-host something` is a mistake,
 *  not a request to consider the whole fleet. */
function boolFlag(flags: Parsed["flags"], key: string): boolean | null {
  if (!hasFlag(flags, key)) return false;
  return flags[key] === true ? true : null;
}

function expectedScopeFromFlags(flags: Parsed["flags"]): ExpectedKeyScope | string {
  const team = textFlag(flags, "expect-team");
  const tenant = textFlag(flags, "expect-tenant");
  const billing = textFlag(flags, "expect-billing-account");
  const personal = boolFlag(flags, "expect-personal");
  if (team === null) return "--expect-team needs an organization id.";
  if (tenant === null) return "--expect-tenant needs a tenant id.";
  if (billing === null) return "--expect-billing-account needs an account id.";
  if (personal === null) return "--expect-personal takes no value.";
  if (personal && team) return "--expect-personal and --expect-team are mutually exclusive.";
  return {
    ...(tenant ? { tenantId: tenant } : {}),
    ...(personal ? { teamId: null } : team ? { teamId: team } : {}),
    ...(billing ? { billingAccountId: billing } : tenant && personal ? { billingAccountId: tenant } : {}),
  };
}

const COMMON_FLAGS = ["json", "help", "h", "api-base", "endpoint", "codex", "client", "scope", "settings"];
const ONBOARDING_FLAGS = new Set([
  ...COMMON_FLAGS,
  "enrich", "open", "test", "verify",
  "expect-team", "expect-personal", "expect-tenant", "expect-billing-account",
]);
const IMPORT_FLAGS = new Set([
  "json", "help", "h", "api-base", "endpoint", "codex", "settings",
  "dry-run", "source", "since", "until", "project", "email", "content", "max-sessions", "rate",
  "time-limit", "key-env", "codex-config", "client",
]);

function unknownFlag(flags: Parsed["flags"], allowed: Set<string>): string | null {
  for (const key of Object.keys(flags)) if (!allowed.has(key)) return key;
  return null;
}

const SKIP_LABELS: Record<string, string> = {
  older: "older than the window",
  newer: "newer than the window",
  active: "still active (written in the last 15 min)",
  filtered: "outside --project",
  ledger: "already imported (unchanged)",
  empty: "nothing importable",
  live: "already captured live",
  already_imported: "already imported",
  changed_since_import: "changed since an earlier import",
  conflicting_partial: "unfinished import of another version (needs cleanup)",
  settling: "imported moments ago — re-run in a few minutes",
  unverifiable: "partial import could not be verified",
  too_large: "file too large",
  too_many_events: "too many events",
  unreadable: "unreadable",
  changed_during_run: "changed while importing",
  deferred: "deferred (session cap / time limit)",
};

async function runImportCommand(
  positional: string[],
  flags: Parsed["flags"],
  endpoints: { apiBase?: string; ingestEndpoint?: string },
  settingsOpts: { scope: SettingsScope; path?: string },
  client: OnboardClient,
): Promise<number> {
  const rogue = unknownFlag(flags, IMPORT_FLAGS);
  if (rogue) {
    out(`Unknown option --${rogue} for import.`);
    return 1;
  }
  // The generic parser lets a bare switch swallow the next word, so a key typed
  // after `--dry-run` / `--json` still counts as the positional key.
  const switchValue = (name: string): { on: boolean; key?: string } => {
    const v = flags[name];
    if (v === undefined || v === false) return { on: false };
    if (typeof v === "string" && looksLikeKey(v)) return { on: true, key: v };
    return { on: true };
  };
  const dry = switchValue("dry-run");
  const json = switchValue("json");
  const explicit = positional[1] ?? dry.key ?? json.key;
  const now = Date.now();

  // `--client` / `--codex` (validated by pickClient) narrow the source. pi keeps
  // no local session transcripts the importer can read, so it is refused
  // outright rather than silently importing nothing.
  const PI_REFUSAL = "import reads Claude Code and Codex history only: pi keeps no local session " +
    "transcripts it can read. Use --source claude-code, codex or all.";
  if (client === "kiro") {
    out("Kiro V3 uses the bounded background collector. Use kiro collect; history import does not support this source."); return 1;
  }
  if (client === "pi" || str(flags, "source") === "pi") {
    out(PI_REFUSAL);
    return 1;
  }
  const fromClient = flags.client === undefined && flags.codex !== true ? undefined
    : client === "codex" ? "codex" : "claude-code";
  const sourceRaw = str(flags, "source") ?? fromClient ?? "all";
  if (!["all", "claude-code", "codex"].includes(sourceRaw)) {
    out("--source must be claude-code, codex or all.");
    return 1;
  }
  if (fromClient && str(flags, "source") && str(flags, "source") !== fromClient) {
    out(`--source ${str(flags, "source")} conflicts with --client ${client}.`);
    return 1;
  }
  const source = sourceRaw as "all" | "claude-code" | "codex";
  const paths = {
    claudeSettings: CLIENTS.claude.resolveConfigPath(settingsOpts),
    codexConfig: CLIENTS.codex.resolveConfigPath({ path: str(flags, "codex-config") }),
  };
  const keyEnv = str(flags, "key-env") ?? DEFAULT_KEY_ENV;
  const resolved = resolveImportKey({ explicit, env: process.env[keyEnv], envName: keyEnv, source, paths });
  if ("error" in resolved) {
    out(resolved.error);
    return 1;
  }
  const content = parseContentFlag(str(flags, "content"));
  if (!content) {
    out("--content must be none, live, all, or a comma list of prompts,tools.");
    return 1;
  }
  const when = (name: string): number | undefined | null => {
    if (!hasFlag(flags, name)) return undefined;
    const raw = str(flags, name);
    return raw === undefined ? null : parseWhen(raw, now);
  };
  const sinceMs = when("since");
  const untilMs = when("until");
  if (sinceMs === null || untilMs === null) {
    out("--since/--until take a number of days or hours (30d, 12h) or an ISO date (2026-09-01).");
    return 1;
  }
  const maxSessions = intFlag(flags, "max-sessions");
  const rate = intFlag(flags, "rate");
  const timeLimit = intFlag(flags, "time-limit");
  if (maxSessions === null || rate === null || timeLimit === null) {
    out("--max-sessions, --rate and --time-limit take a positive whole number.");
    return 1;
  }
  const project = textFlag(flags, "project");
  const email = textFlag(flags, "email");
  if (project === null || email === null) {
    out("--project and --email need a value.");
    return 1;
  }

  const log = json.on ? undefined : out;
  log?.(`${dry.on ? "Dry run: reading" : "Importing"} local history with ${mask(resolved.key)} (from ${resolved.from})…`);
  const result = await runImport({
    key: resolved.key,
    endpoints,
    source,
    sinceMs,
    untilMs,
    project,
    email,
    content: resolveImportContent(content, paths),
    dryRun: dry.on,
    maxSessions,
    ratePerMinute: rate,
    timeLimitMs: timeLimit === undefined ? undefined : timeLimit * 60_000,
    importTool: "connect-cli",
    logger: log,
  });
  if (json.on) {
    out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  out("");
  out(`Window ${result.window.sinceIso.slice(0, 10)} → ${result.window.untilIso.slice(0, 16).replace("T", " ")} UTC`);
  const contentLabel = (c: { prompts: boolean; toolDetails: boolean }) =>
    c.prompts || c.toolDetails ? [c.prompts ? "prompt text" : "", c.toolDetails ? "tool inputs" : ""].filter(Boolean).join(" + ") : "no text";
  for (const s of result.sources) {
    out("");
    out(`${s.source === "claude-code" ? "Claude Code" : "Codex"}: ${s.filesFound} session file(s), ${s.sessionsParsed} parsed, ` +
      `content: ${contentLabel(result.content[s.source])}`);
    out(`  ${dry.on ? "would import" : "imported"}: ${s.imported} session(s)` +
      (s.resumed ? ` (${s.resumed} resumed)` : "") +
      `, ${s.events} event(s), ${s.metricPoints} token point(s)`);
    const tok = s.tokens;
    if (tok.input + tok.output + tok.cacheRead + tok.cacheCreation > 0) {
      out(`  tokens: ${tok.input} input, ${tok.output} output, ${tok.cacheRead} cache read, ${tok.cacheCreation} cache write`);
    }
    for (const [reason, n] of Object.entries(s.skipped)) {
      if (n) out(`  skipped ${n}: ${SKIP_LABELS[reason] ?? reason}`);
    }
  }
  if (result.remaining) out(`\n${result.remaining} session(s) remain — re-run the same command to continue.`);
  for (const c of result.cleanup) out(`  cleanup: ${c.source} ${c.sessionId} → import.plan ${c.plans.join(", ")}`);
  for (const w of result.warnings.slice(0, 20)) out(`warning: ${w}`);
  if (result.warnings.length > 20) out(`…and ${result.warnings.length - 20} more warning(s) (use --json for all)`);
  for (const e of result.errors) out(`error: ${e}`);
  if (dry.on && result.ok) out("\nNothing was sent. Re-run without --dry-run to import.");
  return result.ok ? 0 : 1;
}

export async function run(argv: string[]): Promise<number> {
  const { _, flags } = parse(argv);
  const cmd = _[0];

  if (flags.help || flags.h || cmd === "help") {
    out(HELP);
    return 0;
  }

  if (cmd === "kiro") return runKiroCommand(_.slice(1), flags, out);

  const picked = pickClient(flags);
  if (!isOnboardClient(picked)) {
    out(picked);
    return 1;
  }
  const client = picked;
  const settingsOpts = { scope: pickScope(flags), path: typeof flags.settings === "string" ? flags.settings : undefined };
  const endpoints = {
    apiBase: typeof flags["api-base"] === "string" ? (flags["api-base"] as string) : undefined,
    ingestEndpoint: typeof flags.endpoint === "string" ? (flags.endpoint as string) : undefined,
  };
  const common = {
    client,
    endpoints,
    settings: { ...settingsOpts, enrich: !!flags.enrich },
    sendTest: flags.test !== false,
    verify: flags.verify !== false,
    logger: flags.json ? undefined : out,
  };
  if (cmd === "login" || cmd === "doctor" || cmd === "print-config" || (typeof cmd === "string" && looksLikeKey(cmd))) {
    const rogue = unknownFlag(flags, ONBOARDING_FLAGS);
    if (rogue) {
      out(`Unknown option --${rogue}; refusing to continue because a misspelled scope fence could target another organization.`);
      return 1;
    }
  }
  const expectedScope = expectedScopeFromFlags(flags);
  if (typeof expectedScope === "string") {
    out(expectedScope);
    return 1;
  }

  // print-config: no key, no network.
  if (cmd === "print-config") {
    out(CLIENTS[client].printConfig(resolveEndpoints(endpoints).ingestEndpoint, !!flags.enrich));
    if (client === "pi") out(`\n${PI_EXTENSION_HINT}`);
    return 0;
  }

  // host-metrics: generate the bundled collector's config. No network, no key —
  // the config references the key by env var, so this is safe to run anywhere
  // and safe to check the output into config management.
  if (cmd === "host-metrics") {
    const ep = resolveEndpoints(endpoints);
    let opts: HostMetricsOptions & { configPath: string };
    try {
      opts = hostMetricsOptionsFromFlags(flags, {
        ingestEndpoint: ep.ingestEndpoint,
        paths: defaultHostMetricsPaths(),
        instanceId: defaultInstanceId(),
      });
    } catch (err) {
      out((err as Error).message);
      return 1;
    }

    try {
      if (flags.print === true) {
        process.stdout.write(renderHostMetricsConfig(opts));
        return 0;
      }
      const result = writeHostMetricsConfig(opts);
      if (flags.json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      out(`${result.created ? "Wrote" : "Updated"} ${result.path}`);
      if (result.backupPath) out(`Previous config backed up to ${result.backupPath}`);
      out(`Exporting to ${opts.endpoint} every ${opts.intervalSec ?? 60}s as ${opts.instanceId}`);
      if (result.requiredEnv.length) {
        out("");
        out("Before starting the collector, set the ingest key in its environment:");
        for (const v of result.requiredEnv) out(`  ${v}=cot_…`);
      }
      out("");
      out("Then run:  otelcol-contrib --config " + result.path);
      out("Setup and troubleshooting: docs/otel/agentd-host-metrics.md");
      return 0;
    } catch (err) {
      out(`Could not generate the host-metrics config: ${(err as Error).message}`);
      return 1;
    }
  }

  // import: session-history backfill (#165).
  if (cmd === "import") {
    return runImportCommand(_, flags, endpoints, settingsOpts, client);
  }

  // doctor: reuse the configured key.
  if (cmd === "doctor") {
    const path = CLIENTS[client].resolveConfigPath(settingsOpts);
    const key = CLIENTS[client].readKey(path);
    if (!key) {
      // "No ACTIVE key" — a commented-out exporter reads as not configured, which
      // is exactly what Codex sees, so don't imply the file is empty.
      const flag = CLIENTS[client].cliFlag;
      out(`No active CodeTelemetry key found in ${path} (a commented-out exporter doesn't count).`);
      out(`Run \`codetelemetry-connect <key>${flag}\` or \`codetelemetry-connect login${flag}\` first.`);
      return 1;
    }
    const ep = resolveEndpoints(endpoints);
    if (Object.keys(expectedScope).length > 0) {
      const preflight = await verifyScope({ key, connectivityUrl: ep.connectivityUrl, expected: expectedScope });
      if (preflight.state !== "scope_verified") {
        out(preflight.state === "wrong_scope"
          ? `Wrong organization/tenant/billing attribution (${(preflight.mismatches ?? []).join(", ") || "scope mismatch"}); no probe was sent.`
          : preflight.state === "budget_exhausted"
            ? "The key has the expected scope, but its billing pool is exhausted; no probe was sent."
            : preflight.state === "invalid_key"
              ? "The key is invalid or revoked; no probe was sent."
              : `Could not verify the expected key scope (${preflight.state}); no probe was sent.`);
        return 1;
      }
    }
    out(`Re-testing ${mask(key)} → ${ep.ingestEndpoint}`);
    const test = await sendTestEvent({ key, ingestEndpoint: ep.ingestEndpoint });
    if (!test.ok) {
      out(test.httpStatus === 401
        ? "Invalid or revoked key (ingest returned HTTP 401)."
        : test.httpStatus === 402
          ? "The expected billing pool is exhausted (ingest returned HTTP 402)."
          : `Test event rejected (HTTP ${test.httpStatus}).`);
      return 1;
    }
    const verify = await confirmLanded({ key, connectivityUrl: ep.connectivityUrl, probeId: test.probeId, expected: expectedScope });
    const destination = verify.scope?.teamId ? `organization ${verify.scope.teamId}` : "personal scope";
    out(verify.landed
      ? `✓ Telemetry landed in ${verify.elapsedMs}ms; destination ${destination}; billing ${verify.scope?.billingAccountId ?? "unreported"}.`
      : verify.state === "wrong_scope"
        ? `Wrong organization/tenant/billing attribution (${(verify.mismatches ?? []).join(", ") || "scope mismatch"}).`
        : verify.state === "budget_exhausted"
          ? "The key is valid, but its billing pool is exhausted."
          : verify.state === "dashboard_read_failure"
            ? "Ingest accepted the probe, but the dashboard read failed."
            : verify.state === "invalid_key"
              ? "The key is invalid or revoked."
              : "Probe accepted but not confirmed within the ingestion-delay window.");
    return verify.landed ? 0 : 1;
  }

  // login: device flow.
  if (cmd === "login") {
    const ep = resolveEndpoints(endpoints);
    const code = await requestDeviceCode(ep, fetch, undefined, expectedScope);
    // Prefill the code in the URL so the /activate page is one click.
    const expectedTeam = expectedScope.teamId || undefined;
    const activateUrl = `${code.verificationUri}?code=${encodeURIComponent(code.userCode)}` +
      `${expectedTeam ? `&teamId=${encodeURIComponent(expectedTeam)}` : ""}` +
      `${code.scopeFenced ? "&scope=v1" : ""}`;
    out("");
    out("  To connect, approve in your browser:");
    out(`    ${activateUrl}`);
    out(`    code: ${code.userCode}`);
    // Auto-open the browser (like `gh auth login`) unless --no-open or --json.
    if (flags.open !== false && !flags.json && openBrowser(activateUrl)) {
      out("  Opening your browser…");
    }
    out("");
    out("  Waiting for approval…");
    const result = await onboard({
      ...common,
      expectedScope,
      getKey: async () => {
        // Track the server's actual poll cadence AND expiry window rather than the
        // client's hardcoded fallbacks.
        const k = await pollForKey(ep, code.deviceCode, {
          intervalMs: code.interval * 1000,
          timeoutMs: code.expiresIn * 1000,
          scopeFenced: code.scopeFenced,
        });
        return { apiKey: k.apiKey, ingestEndpoint: k.ingestEndpoint, scope: k.scope };
      },
    });
    if (flags.json) out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  // default: a pasted key.
  if (looksLikeKey(cmd)) {
    const result = await onboard({ ...common, key: cmd, expectedScope });
    if (flags.json) out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  out(HELP);
  return cmd ? 1 : 0;
}
