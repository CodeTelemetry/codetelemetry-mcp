import {
  bootstrapWorkspace,
  type BootstrapOptions,
} from "./client/bootstrap.ts";
import {
  bindingOf,
  bindWorkspace,
  findWorkspaceBinding,
  listWorkspaces,
  loadWorkspace,
  sameWorkspace,
  saveWorkspace,
  workspaceOrigin,
  type WorkspaceBinding,
  type WorkspaceContext,
} from "./client/workspaces.ts";
import { verifyScope } from "./client/connectivity.ts";
import { resolveEndpoints } from "./client/config.ts";
import type { ToolContext, ToolDef } from "./tools.ts";

export async function activateWorkspace(
  ctx: ToolContext,
  context: WorkspaceContext,
): Promise<void> {
  if (
    ctx.endpointsOverride?.apiBase &&
    workspaceOrigin(ctx.endpointsOverride.apiBase) !== context.apiBase
  )
    throw new Error("Workspace conflicts with the host's pinned service.");
  const checked = await verifyScope({
    key: context.ingestKey,
    connectivityUrl: resolveEndpoints({ apiBase: context.apiBase })
      .connectivityUrl,
    expected: context.scope,
    fetchImpl: ctx.fetchImpl,
  });
  if (
    !["scope_verified", "budget_exhausted"].includes(checked.state) ||
    !checked.scope ||
    !sameWorkspace({ ...context, scope: checked.scope }, context)
  )
    throw new Error(
      `Workspace credentials could not be verified: ${checked.state}. Run bootstrap_workspace to reconnect.`,
    );
  ctx.session.setKey(context.ingestKey, "workspace");
  ctx.session.apiBase = context.apiBase;
  ctx.session.ingestEndpoint = context.ingestEndpoint;
  ctx.session.keyScope = context.scope;
  ctx.session.keyExpectedScope = context.scope;
  if (context.clientConfig) {
    ctx.configPathsOverride = {
      ...ctx.configPathsOverride,
      [context.clientConfig.client]:
        ctx.configPathsOverride?.[context.clientConfig.client] ??
        context.clientConfig.path,
    };
    ctx.workspaceClient = context.clientConfig.client;
  }
  ctx.workspace = bindingOf(context);
  ctx.workspaceInitialized = true;
}
export async function restoreWorkspace(ctx: ToolContext): Promise<void> {
  if (ctx.workspaceInitialized) return;
  const binding = findWorkspaceBinding();
  const name = process.env.CODETELEMETRY_WORKSPACE || binding?.name;
  if (!name) {
    ctx.workspaceInitialized = true;
    return;
  }
  const context = loadWorkspace(name);
  if (binding && !sameWorkspace(binding, context))
    throw new Error(
      "Repository and selected workspace disagree. Select the intended context explicitly.",
    );
  if (ctx.session.hasKey() && ctx.session.useKey() !== context.ingestKey)
    throw new Error(
      "Environment credential conflicts with the repository workspace.",
    );
  await activateWorkspace(ctx, context);
}

export const workspaceTools: ToolDef[] = [
  {
    name: "bootstrap_workspace",
    title: "Create or resume a workspace setup",
    description:
      "Create/select an organization and finish repository-scoped setup using a persistent named context. New workspace setups enable prompt and tool-content capture by default; pass enrich:false to opt out. Saved capture choices are preserved on resume. The first call returns one browser approval URL; later calls with the same name resume the saved plan, verify funding and ingestion, optionally save/publish selected Grader checks and write Terraform. No credits or seats are purchased. Pass organizationName to create or organizationId to select. Existing contexts need neither. Each call is bounded; pending steps are explicit. Secrets stay local; unrelated global configurations are unchanged.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        repositoryPath: { type: "string", maxLength: 4096 },
        offset: { type: "integer", minimum: 0, maximum: 63 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        organizationName: { type: "string", minLength: 1, maxLength: 60 },
        organizationId: { type: "string", maxLength: 128 },
        client: { type: "string", enum: ["claude", "codex"] },
        configPath: { type: "string", maxLength: 4096 },
        features: { type: "string", maxLength: 4000 },
        checks: { type: "array", maxItems: 30, items: { type: "object" } },
        publish: { type: "boolean" },
        terraform: { type: "boolean" },
        githubRepository: { type: "string", maxLength: 200 },
        reauthorize: {
          type: "boolean",
          description:
            "Replace an expired or revoked credential after fresh approval, preserving this exact account and organization.",
        },
        enrich: { type: "boolean", default: true, description: "Capture prompts and tool content for new workspace setups (default true). Set false to opt out. Existing saved choices are preserved." },
        repositoryObservation: { type: "boolean" },
      },
    },
    async handler(args, ctx) {
      const result = await bootstrapWorkspace(args as BootstrapOptions, {
        apiBase: ctx.endpointsOverride?.apiBase,
        fetchImpl: ctx.fetchImpl,
      });
      if (["ready", "repository_action_required"].includes(result.status))
        await activateWorkspace(ctx, loadWorkspace(String(args.name)));
      return result;
    },
  },
  {
    name: "workspace_context",
    title: "Manage persistent workspace contexts",
    description:
      "List, save or select a named CodeTelemetry workspace. Credentials stay in private local storage and survive MCP restarts. Repository bindings contain only verified account/organization metadata. Save the currently authenticated key, or use an existing context; repositoryPath binds that repository without changing global telemetry. A conflicting binding requires explicit removal before switching.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "save", "use"] },
        name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        repositoryPath: { type: "string", maxLength: 4096 },
        offset: { type: "integer", minimum: 0, maximum: 63 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    async handler(args, ctx) {
      if (
        Object.keys(args).some(
          (key) =>
            !["action", "name", "repositoryPath", "offset", "limit"].includes(
              key,
            ),
        )
      )
        throw new Error("Unknown workspace context option.");
      if (args.action === "list") {
        const offset = args.offset ?? 0,
          limit = args.limit ?? 10;
        if (
          !Number.isSafeInteger(offset) ||
          Number(offset) < 0 ||
          Number(offset) > 63 ||
          !Number.isSafeInteger(limit) ||
          Number(limit) < 1 ||
          Number(limit) > 10
        )
          throw new Error("Use offset 0–63 and limit 1–10.");
        const all = listWorkspaces(),
          contexts: WorkspaceBinding[] = [];
        for (const context of all.slice(
          Number(offset),
          Number(offset) + Number(limit),
        )) {
          if (
            Buffer.byteLength(
              JSON.stringify({
                contexts: [...contexts, context],
                selected: ctx.workspace ?? null,
              }),
            ) >
            20 * 1024
          )
            break;
          contexts.push(context);
        }
        const next = Number(offset) + contexts.length;
        return {
          ok: true,
          contexts,
          selected: ctx.workspace ?? null,
          total: all.length,
          ...(next < all.length ? { nextOffset: next } : {}),
        };
      }
      if (args.action !== "save" && args.action !== "use")
        throw new Error("Choose list, save or use.");
      const name = String(args.name ?? "");
      let context: WorkspaceContext;
      if (args.action === "save") {
        if (!ctx.session.hasKey())
          throw new Error("Authenticate before saving a workspace.");
        const apiBase = workspaceOrigin(
          ctx.session.apiBase ??
            ctx.endpointsOverride?.apiBase ??
            resolveEndpoints().apiBase,
        );
        const verified = await verifyScope({
          key: ctx.session.useKey(),
          connectivityUrl: resolveEndpoints({ apiBase }).connectivityUrl,
          expected: ctx.session.keyExpectedScope ?? {},
          fetchImpl: ctx.fetchImpl,
        });
        if (
          !["scope_verified", "budget_exhausted"].includes(verified.state) ||
          !verified.scope
        )
          throw new Error(`Workspace verification failed: ${verified.state}.`);
        context = {
          version: 1,
          name,
          apiBase,
          scope: verified.scope,
          ingestEndpoint:
            ctx.session.ingestEndpoint ?? resolveEndpoints().ingestEndpoint,
          ingestKey: ctx.session.useKey(),
        };
        saveWorkspace(context);
      } else context = loadWorkspace(name);
      // Check the repository destination before changing this process's selection.
      if (args.repositoryPath !== undefined) {
        const existing = findWorkspaceBinding(String(args.repositoryPath));
        if (existing && !sameWorkspace(existing, context))
          throw new Error("Repository is bound to another workspace.");
      }
      await activateWorkspace(ctx, context);
      const bindingPath =
        args.repositoryPath === undefined
          ? undefined
          : bindWorkspace(String(args.repositoryPath), context);
      return {
        ok: true,
        workspace: bindingOf(context),
        ...(bindingPath ? { bindingPath } : {}),
      };
    },
  },
];
