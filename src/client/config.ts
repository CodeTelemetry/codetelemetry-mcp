// Endpoints + local paths, with env overrides so the same code drives prod,
// another CodeTelemetry server, or a test backend.

import os from "node:os";
import path from "node:path";

export type Endpoints = {
  /** Where the SPA + onboarding API live (device flow, connectivity, /activate). */
  apiBase: string;
  /** OTLP ingest front door (per-tenant key auth). */
  ingestEndpoint: string;
  deviceCodeUrl: string;
  deviceScopedCodeUrl: string;
  deviceOrganizationCodeUrl: string;
  deviceApproveUrl: string;
  deviceScopedApproveUrl: string;
  deviceOrganizationApproveUrl: string;
  deviceTokenUrl: string;
  deviceScopedTokenUrl: string;
  connectivityUrl: string;
  verificationUri: string;
  /** Agent read tools (MCP use-cases plan). Ingest-key-authed. */
  agentCostUrl: string;
  agentSessionPerformanceUrl: string;
  agentSimilarErrorsUrl: string;
  agentSessionSearchUrl: string;
  agentTaskSizeUrl: string;
  /** Size an existing Linear issue resolved through the tenant's own connected
   *  workspace. */
  agentLinearIssueSizeUrl: string;
  /** Read a bounded, materialized interpretation of one personal coding session. */
  agentInterpretSessionUrl: string;
  /** Read one personal coding session's recorded events. */
  agentReadSessionEventsUrl: string;
  /** Compare 2–10 current, materialized personal-session interpretations. */
  agentCompareSessionsUrl: string;
  /** Produce a bounded, read-only next-session recommendation from materialized precedents. */
  agentPlanNextSessionUrl: string;
  /** The workspace's GitHub PR gate: its view, and changes to it. */
  agentGitHubGateUrl: string;
  agentGitHubGateConfigureUrl: string;
};

const DEFAULT_API_BASE = "https://codetelemetry.com";
const DEFAULT_INGEST = "https://ingest.codetelemetry.com";

export function resolveEndpoints(overrides: Partial<{ apiBase: string; ingestEndpoint: string }> = {}): Endpoints {
  const apiBase = (
    overrides.apiBase || process.env.CODETELEMETRY_API_BASE || DEFAULT_API_BASE
  ).replace(/\/$/, "");
  const ingestEndpoint = (
    overrides.ingestEndpoint || process.env.CODETELEMETRY_INGEST_ENDPOINT || DEFAULT_INGEST
  ).replace(/\/$/, "");
  return {
    apiBase,
    ingestEndpoint,
    deviceCodeUrl: `${apiBase}/api/device/code`,
    deviceScopedCodeUrl: `${apiBase}/api/device/code/scope-v1`,
    deviceOrganizationCodeUrl: `${apiBase}/api/device/code/organization-v1`,
    deviceApproveUrl: `${apiBase}/api/device/approve`,
    deviceScopedApproveUrl: `${apiBase}/api/device/approve/scope-v1`,
    deviceOrganizationApproveUrl: `${apiBase}/api/device/approve/organization-v1`,
    deviceTokenUrl: `${apiBase}/api/device/token`,
    deviceScopedTokenUrl: `${apiBase}/api/device/token/scope-v1`,
    connectivityUrl: `${apiBase}/api/connectivity/check`,
    verificationUri: `${apiBase}/activate`,
    agentCostUrl: `${apiBase}/api/agent/cost`,
    agentSessionPerformanceUrl: `${apiBase}/api/agent/session-performance`,
    agentSimilarErrorsUrl: `${apiBase}/api/agent/similar-errors`,
    agentSessionSearchUrl: `${apiBase}/api/agent/session-search`,
    agentTaskSizeUrl: `${apiBase}/api/agent/task-size`,
    agentLinearIssueSizeUrl: `${apiBase}/api/agent/linear-issue-size`,
    agentInterpretSessionUrl: `${apiBase}/api/agent/interpret-session`,
    agentReadSessionEventsUrl: `${apiBase}/api/agent/read-session-events`,
    agentCompareSessionsUrl: `${apiBase}/api/agent/compare-sessions`,
    agentPlanNextSessionUrl: `${apiBase}/api/agent/plan-next-session`,
    agentGitHubGateUrl: `${apiBase}/api/agent/github-gate`,
    agentGitHubGateConfigureUrl: `${apiBase}/api/agent/github-gate/configure`,
  };
}

export type SettingsScope = "user" | "project";

/**
 * Where Claude Code reads settings: `~/.claude/settings.json` (user-global) or
 * `<cwd>/.claude/settings.json` (per-project). An explicit path wins.
 */
export function resolveSettingsPath(opts: { scope?: SettingsScope; path?: string; cwd?: string; home?: string } = {}): string {
  if (opts.path) return path.resolve(opts.path);
  const scope = opts.scope ?? "user";
  if (scope === "project") {
    return path.join(opts.cwd ?? process.cwd(), ".claude", "settings.json");
  }
  return path.join(opts.home ?? os.homedir(), ".claude", "settings.json");
}
