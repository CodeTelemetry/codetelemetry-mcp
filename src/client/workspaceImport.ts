import path from "node:path";
import { loadWorkspace, workspaceHome, writeWorkspaceFile, readWorkspaceFile, workspaceCaptureDefault } from "./workspaces.ts";
import { workspaceProject } from "./join.ts";
import { keyHash } from "./keys.ts";
import { verifyScope } from "./connectivity.ts";
import { resolveEndpoints } from "./config.ts";
import { runImport, type ImportRunOptions } from "./import/run.ts";
import type { ImportRunResult } from "./import/core.ts";
import { sessionKeyOf } from "./import/model.ts";

type Preview = {
  version: 1; workspace: string; keyHash: string; project: string; createdAt: number;
  scope: { tenantId: string; teamId: string | null; billingAccountId: string };
  window: ImportRunResult["window"]; content: ImportRunResult["content"];
  sessions: NonNullable<ImportRunResult["previewSessions"]>;
};
export async function importWorkspaceHistory(options: {
  name: string; preview?: boolean; confirm?: boolean; selections?: number[]; sinceMs?: number;
}, deps: Pick<ImportRunOptions, "fetchImpl" | "claudeDir" | "codexDir" | "ledgerPath" | "nowMs" | "sleep"> = {}) {
  const context = loadWorkspace(options.name);
  if (!context.scope.teamId || !context.clientConfig) throw new Error("Choose a connected organization workspace.");
  const project = workspaceProject(context);
  const endpoints = { apiBase: context.apiBase, ingestEndpoint: context.ingestEndpoint };
  const expected = context.scope;
  const previewFile = path.join(workspaceHome(), `${context.name}.import-preview.json`);
  const source = context.clientConfig.client === "claude" ? "claude-code" : "codex";
  if (options.preview) {
    if (options.confirm || options.selections) throw new Error("Preview and import confirmation are separate actions.");
    const capture = workspaceCaptureDefault(context);
    const content = { prompts: capture, toolDetails: capture };
    const result = await runImport({ ...deps, key: context.ingestKey, endpoints, project, source,
      sinceMs: options.sinceMs, content: { "claude-code": content, codex: content }, previewOnly: true });
    const preview: Preview = { version: 1, workspace: context.name, keyHash: keyHash(context.ingestKey),
      project, createdAt: Date.now(), scope: expected, window: result.window, content: result.content,
      sessions: result.previewSessions ?? [] };
    writeWorkspaceFile(previewFile, preview);
    return result;
  }
  if (!options.confirm || !options.selections?.length || options.selections.length > 100 ||
    options.sinceMs !== undefined) throw new Error("Preview first, then use --select 1,2,… --confirm to import only those sessions.");
  const preview = readWorkspaceFile(previewFile) as Preview;
  if (preview.version !== 1 || preview.workspace !== context.name || preview.keyHash !== keyHash(context.ingestKey) ||
    preview.project !== project || JSON.stringify(preview.scope) !== JSON.stringify(expected) ||
    !Number.isFinite(preview.createdAt) || Date.now() - preview.createdAt > 24 * 60 * 60_000 ||
    !Array.isArray(preview.sessions) || preview.sessions.length > 100) throw new Error("The preview expired or its destination changed. Preview again.");
  const selectedPlans: Record<string, string> = Object.create(null);
  for (const index of options.selections) {
    if (!Number.isInteger(index) || index < 1 || index > preview.sessions.length) throw new Error("Choose session numbers from the latest preview.");
    const item = preview.sessions[index - 1];
    if ((item.source !== "codex" && item.source !== "claude-code") || typeof item.sessionId !== "string" || item.sessionId.length > 512 || !/^[a-f0-9]{32}$/.test(item.planId)) throw new Error("Invalid preview; generate it again.");
    selectedPlans[sessionKeyOf(item.source, item.sessionId)] = item.planId;
  }
  const verified = await verifyScope({ key: context.ingestKey, expected,
    connectivityUrl: resolveEndpoints(endpoints).connectivityUrl, fetchImpl: deps.fetchImpl });
  if (verified.state !== "scope_verified") throw new Error(`Workspace is unavailable: ${verified.state}. No history was uploaded.`);
  return runImport({ ...deps, key: context.ingestKey, endpoints, project, source,
    sinceMs: Date.parse(preview.window.sinceIso), untilMs: Date.parse(preview.window.untilIso),
    content: preview.content, selectedPlans, maxSessions: 100, timeLimitMs: 120_000 });
}
