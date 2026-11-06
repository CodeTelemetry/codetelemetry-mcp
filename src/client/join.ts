import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { bootstrapWorkspace, type BootstrapOptions } from "./bootstrap.ts";
import { contextPath, findWorkspaceBinding, loadWorkspace, readWorkspaceFile, sameWorkspace,
  workspaceHome, workspaceOrigin, type WorkspaceContext } from "./workspaces.ts";
import type { FetchLike } from "./otlp.ts";

export type JoinOptions = { organizationId: string; repositoryPath?: string; client: "claude" | "codex";
  enrich?: boolean; reauthorize?: boolean; apiBase?: string };

export function joinPlan(options: JoinOptions): BootstrapOptions {
  if (!/^tm_[a-zA-Z0-9_-]{1,128}$/.test(options.organizationId)) throw new Error("Choose a valid existing organization ID.");
  if (options.client !== "claude" && options.client !== "codex") throw new Error("Choose Claude Code or Codex.");
  const repositoryPath = fs.realpathSync(options.repositoryPath ?? process.cwd());
  if (!fs.statSync(repositoryPath).isDirectory() || repositoryPath === os.homedir() || repositoryPath === path.parse(repositoryPath).root)
    throw new Error("Choose a project directory, rather than your home or filesystem root.");
  const binding = findWorkspaceBinding(repositoryPath);
  if (binding && (binding.scope.teamId !== options.organizationId ||
    (options.apiBase && binding.apiBase !== workspaceOrigin(options.apiBase)))) throw new Error("This project is connected to another destination; its connection was preserved.");
  const digest = createHash("sha256").update(JSON.stringify([options.organizationId, repositoryPath, options.client])).digest("hex").slice(0, 12);
  const slug = path.basename(repositoryPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 36) || "project";
  let name = `project-${slug}-${digest}`;
  if (binding) {
    const context = loadWorkspace(binding.name);
    if (context.clientConfig?.client === options.client) name = binding.name;
  }
  const selected = findWorkspaceBinding(repositoryPath, name);
  if (selected?.name === name) {
    const saved = loadWorkspace(name);
    if (!sameWorkspace(saved, selected)) throw new Error("The project's saved destination has changed.");
  }
  const checkpoint = path.join(workspaceHome(), `${name}.bootstrap.json`);
  if (fs.existsSync(checkpoint)) {
    const saved = readWorkspaceFile(checkpoint) as { plan?: BootstrapOptions };
    if (saved.plan?.repositoryPath !== repositoryPath || saved.plan?.client !== options.client ||
      (saved.plan.organizationId && saved.plan.organizationId !== options.organizationId)) throw new Error("The saved connection does not match this project and coding tool.");
    if (options.enrich !== undefined && saved.plan.enrich !== options.enrich)
      throw new Error("This connection has a saved capture choice. Resume without a capture flag to preserve it.");
    return { name, ...(options.reauthorize ? { reauthorize: true } : {}) };
  }
  if (fs.existsSync(contextPath(name)) && loadWorkspace(name).scope.teamId !== options.organizationId)
    throw new Error("Saved connection belongs to another organization.");
  return { name, organizationId: options.organizationId, repositoryPath, client: options.client,
    repositoryObservation: true, ...(options.enrich === undefined ? {} : { enrich: options.enrich }),
    ...(options.reauthorize ? { reauthorize: true } : {}) };
}

export function workspaceProject(context: WorkspaceContext): string {
  const checkpoint = path.join(workspaceHome(), `${context.name}.bootstrap.json`);
  const state = readWorkspaceFile(checkpoint) as { plan?: { repositoryPath?: string } };
  if (typeof state.plan?.repositoryPath !== "string") throw new Error("This workspace has no saved project; connect it with join first.");
  const project = fs.realpathSync(state.plan.repositoryPath);
  const binding = findWorkspaceBinding(project, context.name);
  if (!binding || !sameWorkspace(binding, context)) throw new Error("The saved project binding differs from this workspace.");
  return project;
}

/** Interactive CLI drives the same bounded steps used by MCP. JSON callers get
 * one bounded attempt; terminal callers can wait for the single browser approval. */
export async function joinOrganization(options: JoinOptions, environment: {
  fetchImpl?: FetchLike; interactive?: boolean; open?: (url: string) => void;
  log?: (message: string) => void; timeoutMs?: number; sleep?: (ms: number) => Promise<void>;
} = {}) {
  let plan = joinPlan(options);
  const deadline = Date.now() + Math.min(600_000, environment.timeoutMs ?? 600_000);
  const since = Date.now();
  let opened = "";
  let lastState = "";
  while (true) {
    const result = await bootstrapWorkspace(plan, { apiBase: options.apiBase, fetchImpl: environment.fetchImpl, connectionOnly: true,
      timeoutMs: Math.min(45_000, Math.max(1, deadline - Date.now())) });
    plan = { name: plan.name }; // The durable plan owns every subsequent choice.
    const authorizationUrl = (result as { authorizationUrl?: string }).authorizationUrl;
    if (authorizationUrl && authorizationUrl !== opened) {
      opened = authorizationUrl;
      environment.log?.(`Approve your connection to ${options.organizationId}:\n${authorizationUrl}`);
      environment.open?.(authorizationUrl);
    }
    if (result.status !== lastState) {
      lastState = result.status;
      if (result.status.startsWith("authorization_")) environment.log?.("Waiting for browser approval. You can interrupt and run the same join command to resume.");
      else if (result.nextAction) environment.log?.(result.nextAction);
    }
    if (result.status === "ready") {
      const context = loadWorkspace(plan.name);
      if (context.scope.teamId !== options.organizationId) throw new Error("Connected destination differs from the requested organization.");
      const project = workspaceProject(context);
      const progress = new URL(`/app/teams/${encodeURIComponent(options.organizationId)}/connect`, context.apiBase);
      progress.search = new URLSearchParams({ client: options.client, project, workspace: context.name, since: String(since) }).toString();
      environment.log?.(`Connection test received. Saved workspace: ${context.name}\n${result.steps.clientLaunch}\nRecord a real session to finish verification:\n${progress}`);
      environment.open?.(String(progress));
      return { ...result, progressUrl: String(progress), liveSessionVerified: false };
    }
    if (!environment.interactive || Date.now() >= deadline ||
      !["authorization_required", "authorization_pending", "ingestion_pending"].includes(result.status)) return result;
    await (environment.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(Math.min(5_000, Math.max(1, deadline - Date.now())));
  }
}
