// The orchestrator both the CLI and the MCP server call: turn an ingest key (or a
// key-getter, e.g. the device flow) into a working local setup — write config,
// fire a probe, confirm it landed. The returned result is MODEL-SAFE: it carries
// only a masked key + hash, never the plaintext.

import { resolveEndpoints, resolveSettingsPath, type SettingsScope } from "./config.ts";
import { writeSettings, type WriteResult } from "./settings.ts";
import { resolveCodexConfigPath, writeCodexConfig } from "./codexConfig.ts";
import { sendTestEvent, type SendTestResult, type FetchLike } from "./otlp.ts";
import {
  confirmLanded,
  verifyScope,
  type ConfirmResult,
  type ExpectedKeyScope,
  type KeyScope,
} from "./connectivity.ts";
import { keyHash, mask, assertKey } from "./keys.ts";

export type OnboardStep = { name: string; ok: boolean; detail: string };

export type OnboardResult = {
  ok: boolean;
  key: { masked: string; keyHash: string };
  settings: WriteResult;
  test: SendTestResult | null;
  verify: ConfirmResult | null;
  steps: OnboardStep[];
};

export type OnboardClient = "claude" | "codex";

export type OnboardOptions = {
  /** A pasted key (fast path). */
  key?: string;
  /** Or a getter that yields a key (e.g. the device flow). */
  getKey?: () => Promise<{ apiKey: string; ingestEndpoint?: string; scope?: KeyScope }>;
  /** Which client's local config to write (default "claude"). */
  client?: OnboardClient;
  endpoints?: Partial<{ apiBase: string; ingestEndpoint: string }>;
  settings?: {
    scope?: SettingsScope;
    /** Programmatic/test override. The public MCP tools do not accept arbitrary paths. */
    path?: string;
    enrich?: boolean;
    repositoryObservation?: boolean;
    backup?: boolean;
  };
  sendTest?: boolean;
  verify?: boolean;
  verifyTimeoutMs?: number;
  verifyIntervalMs?: number;
  expectedScope?: ExpectedKeyScope;
  fetchImpl?: FetchLike;
  /** Receives human-facing, already-masked progress lines. */
  logger?: (msg: string) => void;
};

export async function onboard(opts: OnboardOptions): Promise<OnboardResult> {
  const log = opts.logger ?? (() => {});
  const steps: OnboardStep[] = [];

  // 1. Acquire the key (paste or device flow). Plaintext stays in this function.
  let apiKey: string;
  let deviceIngest: string | undefined;
  let approvedScope: KeyScope | undefined;
  if (opts.key) {
    apiKey = assertKey(opts.key);
    steps.push({ name: "authenticate", ok: true, detail: "used provided ingest key" });
  } else if (opts.getKey) {
    const got = await opts.getKey();
    apiKey = assertKey(got.apiKey);
    deviceIngest = got.ingestEndpoint;
    approvedScope = got.scope;
    steps.push({ name: "authenticate", ok: true, detail: "obtained ingest key via device flow" });
  } else {
    throw new Error("onboard requires either `key` or `getKey`");
  }
  const endpoints = resolveEndpoints({
    apiBase: opts.endpoints?.apiBase,
    ingestEndpoint: deviceIngest ?? opts.endpoints?.ingestEndpoint,
  });
  log(`Using ingest key ${mask(apiKey)} → ${endpoints.ingestEndpoint}`);

  // An explicit destination is a safety boundary. Pasted keys need a live
  // preflight before changing files. Device-flow keys carry the scope from the
  // server's strong persisted-key read immediately before one-time redemption,
  // avoiding a fallible post-redemption check that could orphan the secret.
  if (opts.expectedScope && Object.keys(opts.expectedScope).length > 0) {
    const scopeAttested = approvedScope
      && (opts.expectedScope.tenantId === undefined || opts.expectedScope.tenantId === approvedScope.tenantId)
      && (opts.expectedScope.teamId === undefined || opts.expectedScope.teamId === approvedScope.teamId)
      && (opts.expectedScope.billingAccountId === undefined || opts.expectedScope.billingAccountId === approvedScope.billingAccountId);
    if (scopeAttested) {
      steps.push({ name: "verify_scope", ok: true, detail: "device authorization attested key destination and billing scope" });
    } else {
      const preflight = await verifyScope({
        key: apiKey,
        connectivityUrl: endpoints.connectivityUrl,
        fetchImpl: opts.fetchImpl,
        expected: opts.expectedScope,
      });
      if (preflight.state !== "scope_verified") {
        const mismatches = preflight.mismatches?.join(", ");
        throw new Error(`refusing to configure key: ${preflight.state}${mismatches ? ` (${mismatches})` : ""}`);
      }
      steps.push({ name: "verify_scope", ok: true, detail: "key destination and billing scope verified" });
    }
  }

  // 2. Write the local client config — Claude Code's settings.json env block, or
  // Codex's ~/.codex/config.toml [otel] section. (`--scope project` is a Claude
  // concept; for Codex an explicit `path` is the only override.)
  const settings =
    opts.client === "codex"
      ? writeCodexConfig({
          key: apiKey,
          ingestEndpoint: endpoints.ingestEndpoint,
          configPath: resolveCodexConfigPath({ path: opts.settings?.path }),
          enrich: opts.settings?.enrich,
          repositoryObservation: opts.settings?.repositoryObservation,
          backup: opts.settings?.backup,
        })
      : writeSettings({
          key: apiKey,
          ingestEndpoint: endpoints.ingestEndpoint,
          settingsPath: resolveSettingsPath({ scope: opts.settings?.scope, path: opts.settings?.path }),
          enrich: opts.settings?.enrich,
          repositoryObservation: opts.settings?.repositoryObservation,
          backup: opts.settings?.backup,
        });
  const varsNoun = opts.client === "codex" ? "OTEL keys" : "OTEL vars";
  steps.push({
    name: "write_config",
    ok: true,
    detail: `${settings.created ? "created" : "updated"} ${settings.path} (${settings.wrote.length} ${varsNoun})`,
  });
  log(`Wrote ${settings.wrote.length} ${varsNoun} to ${settings.path}${settings.backupPath ? ` (backup: ${settings.backupPath})` : ""}`);

  // 3. Fire a test event.
  let test: SendTestResult | null = null;
  if (opts.sendTest !== false) {
    test = await sendTestEvent({ key: apiKey, ingestEndpoint: endpoints.ingestEndpoint, fetchImpl: opts.fetchImpl });
    steps.push({
      name: "send_test_event",
      ok: test.ok,
      detail: test.ok ? `probe accepted (HTTP ${test.httpStatus})` : `ingest returned HTTP ${test.httpStatus}`,
    });
    log(test.ok ? `Test event accepted (probe ${test.probeId})` : `Test event rejected (HTTP ${test.httpStatus})`);
  }

  // 4. Confirm it landed.
  let verify: ConfirmResult | null = null;
  if (opts.verify !== false && test?.ok) {
    log("Waiting for the probe to land…");
    verify = await confirmLanded({
      key: apiKey,
      connectivityUrl: endpoints.connectivityUrl,
      probeId: test.probeId,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.verifyTimeoutMs,
      intervalMs: opts.verifyIntervalMs,
      expected: opts.expectedScope,
    });
    steps.push({
      name: "verify_telemetry",
      ok: verify.landed,
      detail: verify.landed
        ? `landed in ${verify.elapsedMs}ms for ${verify.scope?.teamId ? `organization ${verify.scope.teamId}` : "personal scope"}`
        : `${verify.state} (${verify.elapsedMs}ms)`,
    });
    log(verify.landed ? `✓ Telemetry landed in ${verify.elapsedMs}ms` : "Telemetry not confirmed yet — it can take a moment to appear");
  }

  const ok = steps.every((s) => s.ok);
  return { ok, key: { masked: mask(apiKey), keyHash: keyHash(apiKey) }, settings, test, verify, steps };
}
