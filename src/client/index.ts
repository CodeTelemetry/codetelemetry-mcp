// Public surface of @codetelemetry/connect — the shared core for the CLI and the
// MCP server.

export { looksLikeKey, assertKey, mask, keyHash, scrub } from "./keys.ts";
export {
  resolveEndpoints,
  resolveSettingsPath,
  type Endpoints,
  type SettingsScope,
} from "./config.ts";
export {
  baseEnv,
  enrichEnv,
  buildEnvBlock,
  mergeSettings,
  writeSettings,
  readSettingsSummary,
  type EnvBlock,
  type WriteResult,
  type WriteOptions,
} from "./settings.ts";
export {
  buildProbeLog,
  sendTestEvent,
  PROBE_ATTR,
  PROBE_EVENT,
  PROBE_SERVICE,
  type SendTestResult,
  type SendTestOptions,
  type FetchLike,
} from "./otlp.ts";
export {
  checkOnce,
  confirmLanded,
  verifyScope,
  type CheckResult,
  type ConfirmResult,
  type ConnectivityState,
  type KeyScope,
  type ExpectedKeyScope,
} from "./connectivity.ts";
export {
  getCostSignal,
  getSessionPerformance,
  normalizeSessionPerformanceService,
  findSimilarSessionErrors,
  searchCodingSessions,
  SESSION_SEARCH_REQUEST_TIMEOUT_MS,
  countReplyPhrases,
  type ReplyPhraseTrendsResult,
  estimateTaskSize,
  estimateLinearIssue,
  interpretSession,
  readSessionEvents,
  compareSessions,
  planNextSession,
  getHostHealth,
  readGitHubGate,
  configureGitHubGate,
  type GitHubGateResult,
  type HostState,
  type HostThresholds,
  type HostSignals,
  type HostHeadroom,
  type HostAdmission,
  type HostAgentdProcess,
  type HostHealth,
  type HostHealthReport,
  type HostHealthResult,
  type LinearIssueSource,
  type LinearConnectionChoice,
  type LinearIssueEstimateResult,
  type TaskSize,
  type TaskEffortEstimate,
  type LinearEstimateProjection,
  type LinearEstimateScale,
  type TaskEffortResult,
  type CostSignal,
  type CostSignalResult,
  type AgentReadPerformance,
  type SessionPerformanceReport,
  type SessionPerformanceResult,
  type SimilarSessionErrorsReport,
  type SimilarSessionErrorsResult,
  type SessionSearchHit,
  type SessionSearchLegacyReport,
  type SessionPrecedentReport,
  type SessionSearchReport,
  type SessionSearchResult,
} from "./agent.ts";
export {
  normalizePlan,
  PLAN_PROVIDERS,
  MAX_PLAN_TEXT,
  MAX_PLAN_STEPS,
  type PlanInput,
  type PlanStepInput,
  type PlanProvider,
  type PlanSource,
  type PlanSourceStep,
  type NormalizedPlan,
  type NormalizePlanResult,
} from "./plan.ts";
export {
  requestDeviceCode,
  pollForKey,
  pollOnce,
  type DeviceCodeResponse,
  type DeviceKey,
  type PollOnce,
} from "./deviceClient.ts";
export { onboard, type OnboardOptions, type OnboardResult, type OnboardStep, type OnboardClient } from "./onboard.ts";
export {
  CLIENTS,
  PI_EXTENSION_HINT,
  readClaudeKey,
  resolveClient,
  type ClientDescriptor,
  type ClientSummary,
} from "./clients.ts";
export {
  buildPiOtelBlock,
  mergePiSettings,
  piTracesEndpoint,
  readPiKey,
  readPiSummary,
  resolvePiConfigPath,
  writePiConfig,
  type PiWriteOptions,
  type PiWriteResult,
} from "./piConfig.ts";
export {
  ONBOARD_CLIENTS,
  SESSION_FILTER_ASSISTANTS,
  isOnboardClient,
} from "./assistants.ts";
export {
  buildHostMetricsConfig,
  renderHostMetricsConfig,
  writeHostMetricsConfig,
  hostMetricsOptionsFromFlags,
  defaultHostMetricsPaths,
  defaultInstanceId,
  HOST_METRIC_CONTRACT,
  REDACTED_RESOURCE_ATTRIBUTES,
  DEFAULT_PROCESS_NAMES,
  DEFAULT_KEY_ENV,
  DEFAULT_SERVICE_NAME,
  SERVICE_NAMESPACE,
  type HostMetricsOptions,
  type HostMetricsMode,
  type HostMetricsPaths,
  type HostMetricsWriteOptions,
  type HostMetricsWriteResult,
} from "./hostMetrics.ts";
export {
  resolveCodexConfigPath,
  buildOtelSection,
  writeCodexConfig,
  readCodexKey,
  readCodexSummary,
  readCodexLogUserPrompt,
  type CodexWriteOptions,
} from "./codexConfig.ts";
export { readClaudeContentFlags } from "./settings.ts";
export {
  runImport,
  RETENTION_DAYS,
  DEFAULT_SINCE_DAYS,
  type ImportRunOptions,
  type ImportRunResult,
  type ImportSourceSummary,
  type ContentBySource,
} from "./import/run.ts";
export { resolveImportKey, resolveImportContent, parseContentFlag, parseWhen } from "./import/options.ts";
export { NO_CONTENT, ALL_CONTENT, type ContentPolicy, type ImportSource } from "./import/model.ts";

export { graderConfigRequest } from "./agent.ts";
