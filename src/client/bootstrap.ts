// A bounded, restartable setup operation. Remote results are always rechecked;
// checkpoints describe progress, never substitute for authorization or readiness.
import { prepareGitHubWorkflow, verifyGitHubSetup } from "./bootstrapGitHub.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  bindWorkspace,
  bindingOf,
  codexWorkspaceProfilePath,
  writeCodexWorkspaceProfile,
  workspaceCaptureDefault,
  WORKSPACE_MCP_PACKAGE,
  contextPath,
  workspaceLock,
  loadWorkspace,
  readWorkspaceFile,
  saveWorkspace,
  workspaceHome,
  workspaceName,
  workspaceOrigin,
  writeWorkspaceFile,
  type WorkspaceContext,
} from "./workspaces.ts";
import { resolveEndpoints } from "./config.ts";
import type { KeyScope } from "./connectivity.ts";
import { verifyScope, confirmLanded } from "./connectivity.ts";
import { pollOnce } from "./deviceClient.ts";
import { CLIENTS } from "./clients.ts";
import { sendTestEvent, type FetchLike } from "./otlp.ts";
import { scrub, keyHash } from "./keys.ts";
import { writeGraderArtifact } from "./graderArtifact.ts";

export type BootstrapOptions = {
  name: string;
  repositoryPath?: string;
  organizationName?: string;
  organizationId?: string;
  client?: "claude" | "codex";
  configPath?: string;
  features?: string;
  checks?: Record<string, unknown>[];
  publish?: boolean;
  githubRepository?: string;
  terraform?: boolean;
  enrich?: boolean;
  repositoryObservation?: boolean;
  reauthorize?: boolean;
};
type Pending = {
  deviceCode: string;
  userCode: string;
  uri: string;
  expiresAt: number;
  interval: number;
  nextPoll: number;
};
type State = {
  version: 1;
  name: string;
  startedAt: number;
  operationId: string;
  apiBase: string;
  plan: BootstrapOptions & {
    repositoryPath: string;
    client: "claude" | "codex";
  };
  pending?: Pending;
  probe?: { id: string; key: string; at: number };
  publishedRevision?: string;
  reconnect?: boolean;
  steps: Record<string, string>;
};

async function request(
  base: string,
  route: string,
  body: unknown,
  fetchImpl: FetchLike,
  deadline: number,
  key?: string,
  scope?: KeyScope,
): Promise<Record<string, any>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new Error("Bootstrap time limit reached; resume this workspace.");
  const response = await fetchImpl(base + route, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(8_000, remaining)),
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(scope ? { "x-codetelemetry-workspace": JSON.stringify(scope) } : {}),
    },
    body: JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw new Error("Bootstrap response exceeds 64 KiB.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  let result: Record<string, any>;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(
      "Invalid bootstrap response; resume after checking the service.",
    );
  }
  if (!response.ok || result.ok === false)
    throw new Error(
      `Bootstrap request failed (HTTP ${response.status}${typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? `, ${result.error}` : ""}); resume after resolving it.`,
    );
  return result;
}
function validatePlan(options: BootstrapOptions, enrichDefault?: boolean): State["plan"] {
  workspaceName(options.name);
  const allowed = new Set([
    "name",
    "repositoryPath",
    "organizationName",
    "organizationId",
    "client",
    "configPath",
    "features",
    "checks",
    "publish",
    "githubRepository",
    "terraform",
    "enrich",
    "repositoryObservation",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key)))
    throw new Error("Unknown bootstrap option.");
  for (const key of [
    "publish",
    "terraform",
    "enrich",
    "repositoryObservation",
  ] as const)
    if (options[key] !== undefined && typeof options[key] !== "boolean")
      throw new Error(`${key} must be a boolean.`);
  if (
    options.organizationName !== undefined &&
    (typeof options.organizationName !== "string" ||
      !options.organizationName.trim() ||
      options.organizationName.length > 60)
  )
    throw new Error("New organization name must contain 1–60 characters.");
  if (
    options.organizationId !== undefined &&
    !/^tm_[A-Za-z0-9_-]{1,128}$/.test(options.organizationId)
  )
    throw new Error("Invalid organization ID.");
  if (options.organizationName && options.organizationId)
    throw new Error(
      "Choose an existing organization ID or a new organization name.",
    );
  if (
    options.client !== undefined &&
    !["claude", "codex"].includes(options.client)
  )
    throw new Error("Bootstrap supports Claude Code and Codex.");
  if (
    options.githubRepository !== undefined &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.githubRepository)
  )
    throw new Error("GitHub repository must be owner/name.");
  if (
    options.features !== undefined &&
    (typeof options.features !== "string" ||
      options.features.length > 4000 ||
      !options.features.trim())
  )
    throw new Error("Describe Grader features in 1–4000 characters.");
  if (
    options.checks !== undefined &&
    (!Array.isArray(options.checks) ||
      options.checks.length > 30 ||
      options.checks.some(
        (c) =>
          !c ||
          typeof c !== "object" ||
          Array.isArray(c) ||
          typeof c.id !== "string",
      ))
  )
    throw new Error("Select at most 30 Grader checks with IDs.");
  if (options.checks?.length && !options.features)
    throw new Error("Describe the requested Grader features.");
  if ((options.publish || options.terraform) && !options.checks?.length)
    throw new Error("Select the checks to publish.");
  const encoded = JSON.stringify(options);
  if (
    /gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
      encoded,
    )
  )
    throw new Error("Remove credentials from the bootstrap plan.");
  if (encoded !== scrub(encoded))
    throw new Error("Remove credentials from the bootstrap plan.");
  const repositoryPath = fs.realpathSync(
    options.repositoryPath ?? process.cwd(),
  );
  if (
    !fs.statSync(repositoryPath).isDirectory() ||
    repositoryPath === os.homedir() ||
    repositoryPath === path.parse(repositoryPath).root
  )
    throw new Error("Choose a repository directory before authorizing setup.");
  const client = options.client ?? "codex";
  const configPath = options.configPath
    ? path.resolve(options.configPath)
    : client === "codex"
      ? codexWorkspaceProfilePath(options.name)
      : path.join(repositoryPath, ".claude", "settings.local.json");
  const allowedConfig =
    client === "codex"
      ? codexWorkspaceProfilePath(options.name)
      : path.join(repositoryPath, ".claude", "settings.local.json");
  if (configPath !== allowedConfig)
    throw new Error(
      "Bootstrap writes only this workspace's named Codex profile or repository-local Claude settings.",
    );
  return {
    ...options,
    // Freeze the choice in new plans. Validation of an older checkpoint leaves
    // an omitted field omitted, preserving that operation's historical opt-out.
    ...(options.enrich === undefined && enrichDefault !== undefined ? { enrich: enrichDefault } : {}),
    repositoryPath, client, configPath,
  };
}
export async function bootstrapWorkspace(
  options: BootstrapOptions,
  environment: {
    apiBase?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
) {
  if (
    options.reauthorize !== undefined &&
    typeof options.reauthorize !== "boolean"
  )
    throw new Error("reauthorize must be a boolean.");
  const reauthorize = options.reauthorize === true;
  options = { ...options };
  delete options.reauthorize;
  const name = workspaceName(options.name),
    stateFile = path.join(workspaceHome(), `${name}.bootstrap.json`);
  const savedOrigin = fs.existsSync(stateFile)
    ? (readWorkspaceFile(stateFile) as State).apiBase
    : fs.existsSync(contextPath(name))
      ? loadWorkspace(name).apiBase
      : undefined;
  const apiBase = workspaceOrigin(
    environment.apiBase ??
      process.env.CODETELEMETRY_API_BASE ??
      savedOrigin ??
      resolveEndpoints().apiBase,
  );
  const release = workspaceLock(name),
    deadline =
      Date.now() +
      Math.min(50_000, Math.max(1, environment.timeoutMs ?? 45_000));
  const fetchImpl = environment.fetchImpl ?? fetch;
  try {
    let state: State;
    if (fs.existsSync(stateFile)) {
      state = readWorkspaceFile(stateFile) as State;
      if (
        state.version !== 1 ||
        !Number.isFinite(state.startedAt) ||
        state.name !== name ||
        state.plan?.name !== name ||
        typeof state.operationId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(state.operationId) ||
        state.apiBase !== apiBase ||
        !state.plan ||
        !state.steps
      )
        throw new Error("Unsupported or mismatched bootstrap checkpoint.");
      const validated = validatePlan(state.plan);
      if (JSON.stringify(validated) !== JSON.stringify(state.plan))
        throw new Error("Bootstrap repository or configuration path changed.");
      for (const [key, value] of Object.entries(options))
        if (
          key !== "name" &&
          JSON.stringify(value) !== JSON.stringify((state.plan as any)[key])
        )
          throw new Error(
            "Bootstrap plan changed; use another context name for a different setup.",
          );
    } else {
      if (options.organizationName && fs.existsSync(contextPath(name)))
        throw new Error(
          "This context already exists. Omit organizationName to configure it, or choose a new context name to create another organization.",
        );
      const existing = fs.existsSync(contextPath(name)) ? loadWorkspace(name) : null;
      const plan = validatePlan(options, existing ? workspaceCaptureDefault(existing) : true);
      state = {
        version: 1,
        name,
        startedAt: Date.now(),
        operationId: randomUUID(),
        apiBase,
        plan,
        steps: {},
      };
      writeWorkspaceFile(stateFile, state);
    }
    const checkpoint = () => writeWorkspaceFile(stateFile, state);
    const result = (
      status: string,
      nextAction?: string,
      extra: Record<string, unknown> = {},
    ) => ({
      ok: status === "ready",
      status,
      workspace: name,
      steps: state.steps,
      ...(nextAction ? { nextAction } : {}),
      ...extra,
    });
    let context: WorkspaceContext | null = fs.existsSync(contextPath(name))
      ? loadWorkspace(name)
      : null;
    if (
      context &&
      (context.apiBase !== apiBase ||
        (state.plan.organizationId &&
          context.scope.teamId !== state.plan.organizationId))
    )
      throw new Error("Bootstrap and saved context scopes disagree.");
    if (reauthorize) {
      state.reconnect = true;
      delete state.pending;
      checkpoint();
    }
    const priorContext = context;
    if (state.reconnect) context = null;
    if (!context) {
      if (!state.pending || state.pending.expiresAt <= Date.now()) {
        const expected =
          priorContext?.scope ??
          (state.plan.organizationId
            ? { teamId: state.plan.organizationId }
            : undefined);
        if (!state.plan.organizationName && !expected)
          throw new Error(
            "Choose an organizationName or organizationId when bootstrapping a new context.",
          );
        const code = await request(
          apiBase,
          state.plan.organizationName && !priorContext
            ? "/api/device/code/bootstrap-v1"
            : "/api/device/code/scope-v1",
          state.plan.organizationName && !priorContext
            ? {
                organizationName: state.plan.organizationName,
                operationId: state.operationId,
              }
            : { expected },
          fetchImpl,
          deadline,
        );
        if (
          typeof code.device_code !== "string" ||
          typeof code.user_code !== "string" ||
          !Number.isFinite(code.expires_in) ||
          code.expires_in <= 0 ||
          code.expires_in > 900 ||
          !Number.isFinite(code.interval) ||
          code.interval < 1 ||
          code.interval > 60
        )
          throw new Error("Invalid bootstrap authorization response.");
        const uri = new URL("/activate", apiBase);
        uri.searchParams.set("code", code.user_code);
        if (state.plan.organizationName && !priorContext) {
          uri.searchParams.set("bootstrap", "1");
          uri.searchParams.set("organizationName", state.plan.organizationName);
        } else {
          uri.searchParams.set("scope", "v1");
          const team = priorContext?.scope.teamId ?? state.plan.organizationId;
          if (team) uri.searchParams.set("teamId", team);
        }
        state.pending = {
          deviceCode: code.device_code,
          userCode: code.user_code,
          uri: uri.href,
          expiresAt: Date.now() + code.expires_in * 1000,
          interval: code.interval,
          nextPoll: Date.now() + code.interval * 1000,
        };
        checkpoint();
        return result(
          "authorization_required",
          "Approve the displayed account and organization in the browser, then resume bootstrap_workspace with this name.",
          { authorizationUrl: uri.href, userCode: code.user_code },
        );
      }
      if (state.pending.nextPoll > Date.now())
        return result(
          "authorization_pending",
          "Resume after the authorization polling interval.",
          {
            authorizationUrl: state.pending.uri,
            retryAfterMs: state.pending.nextPoll - Date.now(),
          },
        );
      state.pending.nextPoll = Date.now() + state.pending.interval * 1000;
      checkpoint();
      const authorized = await pollOnce(
        resolveEndpoints({ apiBase }),
        state.pending.deviceCode,
        fetchImpl,
        Math.min(8000, Math.max(1, deadline - Date.now())),
        { scopeFenced: !!state.plan.organizationId || !!priorContext },
      );
      if (authorized.status === "pending")
        return result(
          "authorization_pending",
          "Finish browser approval, then resume.",
          { authorizationUrl: state.pending.uri },
        );
      if (authorized.status === "error") {
        delete state.pending;
        checkpoint();
        return result(
          "authorization_expired",
          "Resume to start a new authorization for the same operation.",
        );
      }
      if (
        !authorized.scope ||
        (!priorContext && !authorized.scope.teamId) ||
        (state.plan.organizationId &&
          state.plan.organizationId !== authorized.scope.teamId)
      )
        throw new Error(
          "Device approval did not attest the requested organization.",
        );
      context = {
        version: 1,
        name,
        apiBase,
        scope: authorized.scope,
        ingestKey: authorized.apiKey,
        ingestEndpoint: authorized.ingestEndpoint,
      };
      if (
        priorContext &&
        (context.scope.tenantId !== priorContext.scope.tenantId ||
          context.scope.teamId !== priorContext.scope.teamId ||
          context.scope.billingAccountId !==
            priorContext.scope.billingAccountId)
      )
        throw new Error(
          "Reauthorization changed the workspace identity; the new credential was not kept.",
        );
      delete state.reconnect;
      // Persist the one-time credential before any subsequent network work.
      saveWorkspace(context);
      delete state.pending;
      state.steps.authentication = "verified";
      checkpoint();
    }
    const endpoints = resolveEndpoints({
      apiBase,
      ingestEndpoint: context.ingestEndpoint,
    });
    const verified = await verifyScope({
      key: context.ingestKey,
      connectivityUrl: endpoints.connectivityUrl,
      expected: context.scope,
      fetchImpl,
      timeoutMs: Math.min(8000, Math.max(1, deadline - Date.now())),
    });
    if (
      !["scope_verified", "budget_exhausted"].includes(verified.state) ||
      !verified.scope ||
      verified.scope.tenantId !== context.scope.tenantId ||
      verified.scope.teamId !== context.scope.teamId ||
      verified.scope.billingAccountId !== context.scope.billingAccountId
    )
      return result(
        "credential_unavailable",
        `Workspace verification returned ${verified.state}; reconnect this context before continuing.`,
      );
    state.steps.scope = "verified";
    delete state.steps.funding;
    delete state.steps.telemetry;
    bindWorkspace(state.plan.repositoryPath, context);
    state.steps.repository = "bound";
    checkpoint();
    if (verified.state === "budget_exhausted")
      return result(
        "funding_required",
        "Fund this organization's billing pool, then resume; the context and authorization are saved.",
        {
          billingUrl: context.scope.teamId
            ? `${apiBase}/app/teams/${context.scope.teamId}`
            : `${apiBase}/app`,
          scope: context.scope,
        },
      );
    state.steps.funding = "available";
    const ignoreFile = path.join(state.plan.repositoryPath, ".gitignore");
    let ignored = "";
    if (fs.existsSync(ignoreFile)) {
      const st = fs.lstatSync(ignoreFile);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 65536)
        throw new Error(
          "Repository .gitignore must be a regular file within 64 KiB.",
        );
      ignored = fs.readFileSync(ignoreFile, "utf8");
    }
    const ignoreEntry =
      state.plan.client === "codex"
        ? "/.codex/"
        : "/.claude/settings.local.json";
    if (!ignored.split(/\r?\n/).includes(ignoreEntry)) {
      const fd = fs.openSync(
        ignoreFile,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_NOFOLLOW,
        0o644,
      );
      try {
        fs.writeFileSync(
          fd,
          `${ignored.endsWith("\n") || !ignored ? "" : "\n"}# Local CodeTelemetry credentials\n${ignoreEntry}\n`,
        );
      } finally {
        fs.closeSync(fd);
      }
    }
    const client = CLIENTS[state.plan.client];
    if (
      state.plan.client === "codex" &&
      path.resolve(state.plan.configPath!) !==
        codexWorkspaceProfilePath(name) &&
      path
        .resolve(state.plan.configPath!)
        .startsWith(state.plan.repositoryPath + path.sep)
    )
      throw new Error(
        "Codex ignores project-local telemetry. Use the named user-level workspace profile.",
      );
    const written =
      state.plan.client === "codex" &&
      path.resolve(state.plan.configPath!) === codexWorkspaceProfilePath(name)
        ? writeCodexWorkspaceProfile(context, {
            enrich: state.plan.enrich,
            repositoryObservation: state.plan.repositoryObservation,
          })
        : client.write({
            key: context.ingestKey,
            ingestEndpoint: context.ingestEndpoint,
            configPath: state.plan.configPath!,
            enrich: state.plan.enrich === true,
            repositoryObservation: state.plan.repositoryObservation === true,
          });
    context.clientConfig = {
      client: state.plan.client,
      path: written.path,
      enrich: state.plan.enrich === true,
      repositoryObservation: state.plan.repositoryObservation === true,
    };
    saveWorkspace(context);
    if (state.plan.client === "claude") {
      const file = path.join(state.plan.repositoryPath, ".mcp.json");
      const existing = fs.existsSync(file)
        ? (readWorkspaceFile(file, false) as Record<string, any>)
        : {};
      const servers = existing.mcpServers ?? {};
      if (
        servers.codetelemetry &&
        (servers.codetelemetry.command !== "npx" ||
          !servers.codetelemetry.args?.some(
            (a: unknown) =>
              typeof a === "string" && a.includes("@codetelemetry/mcp"),
          ))
      )
        throw new Error(
          "Existing project MCP entry differs; review it before connecting this workspace.",
        );
      writeWorkspaceFile(file, {
        ...existing,
        mcpServers: {
          ...servers,
          codetelemetry: {
            command: "npx",
            args: [
              "-y",
              `--package=${WORKSPACE_MCP_PACKAGE}`,
              "codetelemetry-mcp",
            ],
            env: {
              CODETELEMETRY_WORKSPACE: name,
              CODETELEMETRY_CONTEXT_HOME: workspaceHome(),
            },
          },
        },
      });
    }
    state.steps.clientConfig = written.path;
    state.steps.clientLaunch =
      state.plan.client === "codex"
        ? `codetelemetry-connect run ${name} -- <codex arguments>`
        : "Open Claude Code in the bound repository.";
    checkpoint();
    if (
      !state.probe ||
      state.probe.key !== keyHash(context.ingestKey) ||
      Date.now() - state.probe.at > 3_000_000
    ) {
      const sent = await sendTestEvent({
        key: context.ingestKey,
        ingestEndpoint: context.ingestEndpoint,
        fetchImpl,
        timeoutMs: Math.min(8000, Math.max(1, deadline - Date.now())),
      });
      if (!sent.ok)
        return result(
          "ingestion_failed",
          `The test event returned HTTP ${sent.httpStatus}; resolve ingestion and resume.`,
        );
      state.probe = {
        id: sent.probeId,
        key: keyHash(context.ingestKey),
        at: Date.now(),
      };
      checkpoint();
    }
    const landed = await confirmLanded({
      key: context.ingestKey,
      connectivityUrl: endpoints.connectivityUrl,
      probeId: state.probe.id,
      expected: context.scope,
      fetchImpl,
      timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())),
    });
    if (!landed.landed)
      return result(
        "ingestion_pending",
        `Telemetry verification returned ${landed.state}; resume to check the same probe.`,
      );
    state.steps.telemetry = "verified";
    checkpoint();
    if (state.plan.checks?.length) {
      const checks: Record<string, unknown>[] = [];
      let config: Record<string, any> = {};
      for (let page = 0, offset = 0; page < 6; page++) {
        const read = await request(
          apiBase,
          "/api/agent/grader",
          { offset, limit: 10 },
          fetchImpl,
          deadline,
          context.ingestKey,
          context.scope,
        );
        if (
          !read.config?.draft ||
          !Array.isArray(read.config.draft.checks) ||
          (config.revision && config.revision !== read.config.revision)
        )
          throw new Error("Grader changed during bootstrap; resume.");
        config = read.config;
        checks.push(...config.draft.checks);
        if (config.nextOffset === undefined) break;
        if (
          config.nextOffset !== offset + config.draft.checks.length ||
          config.nextOffset <= offset ||
          page === 5
        )
          throw new Error("Invalid Grader pagination.");
        offset = config.nextOffset;
      }
      const equal = (a: unknown, b: unknown): boolean =>
        JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
      if (
        state.plan.checks.some(
          (want) =>
            !checks.some((have) => have.id === want.id && equal(have, want)),
        )
      ) {
        const saved = await request(
          apiBase,
          "/api/agent/grader/configure",
          {
            expectedRevision: config.revision,
            features: state.plan.features,
            upsertChecks: state.plan.checks,
          },
          fetchImpl,
          deadline,
          context.ingestKey,
          context.scope,
        );
        config = saved.config;
        state.steps.grader = "draft_saved";
        checkpoint();
      } else state.steps.grader = "draft_verified";
      if (state.plan.terraform) {
        const artifactPath = path.join(
          state.plan.repositoryPath,
          "codetelemetry-grader.tf.json",
        );
        if (!fs.existsSync(artifactPath))
          writeGraderArtifact({
            repositoryPath: state.plan.repositoryPath,
            format: "terraform",
            features: state.plan.features!,
            checks: state.plan.checks,
          });
        else {
          const artifact = readWorkspaceFile(artifactPath, false) as any;
          const raw =
            artifact?.resource?.codetelemetry_grader_config?.instructions
              ?.checks_json;
          if (
            typeof raw !== "string" ||
            !equal(
              JSON.parse(raw.replaceAll("$${", "${").replaceAll("%%{", "%{")),
              state.plan.checks,
            )
          )
            throw new Error(
              "Existing Terraform artifact differs from the saved setup; review it before resuming.",
            );
        }
        state.steps.terraform = "artifact_written; apply remains explicit";
      }
      if (state.plan.publish && config.publishedMatchesDraft === true) {
        state.publishedRevision = config.revision;
        state.steps.publication = `policy_${config.publishedVersion}`;
        checkpoint();
      } else if (
        state.plan.publish &&
        state.publishedRevision !== config.revision
      ) {
        const published = await request(
          apiBase,
          "/api/agent/grader/publish",
          { expectedRevision: config.revision },
          fetchImpl,
          deadline,
          context.ingestKey,
          context.scope,
        );
        state.publishedRevision = published.config.revision;
        state.steps.publication = `policy_${published.config.publishedVersion}`;
        checkpoint();
      }
    }
    if (state.plan.githubRepository) {
      const gate = await request(
        apiBase,
        "/api/agent/github-gate/configure",
        { enabled: true, addRepositories: [state.plan.githubRepository] },
        fetchImpl,
        deadline,
        context.ingestKey,
        context.scope,
      );
      state.steps.gate = "configured";
      if (!gate.gate?.actions?.workflow)
        return result(
          "repository_action_required",
          "The service did not provide a workflow; check the gate deployment.",
        );
      const workflowPath = prepareGitHubWorkflow(
        state.plan.repositoryPath,
        gate.gate.actions.workflow,
      );
      checkpoint();
      let verification: ReturnType<typeof verifyGitHubSetup>;
      try {
        const current = await request(
          apiBase,
          "/api/agent/grader",
          { offset: 0, limit: 1 },
          fetchImpl,
          deadline,
          context.ingestKey,
          context.scope,
        );
        if (!Number.isSafeInteger(current.config?.publishedVersion))
          throw new Error("Current published policy is unavailable.");
        verification = verifyGitHubSetup(
          gate.gate,
          state.plan.githubRepository,
          state.plan.repositoryPath,
          state.startedAt,
          deadline,
          current.config.publishedVersion,
        );
      } catch (error) {
        return result(
          "repository_action_required",
          String((error as Error).message),
          {
            workflowPath,
            requiredCheck: gate.gate.actions.requiredCheck,
            rulesetJson: gate.gate.actions.rulesetJson,
          },
        );
      }
      if (!verification.verified)
        return result("repository_action_required", verification.reason, {
          workflowPath,
          requiredCheck: gate.gate.actions.requiredCheck,
          rulesetJson: gate.gate.actions.rulesetJson,
        });
      state.steps.gate = "verified";
      checkpoint();
      return result("ready", undefined, {
        scope: context.scope,
        verification: {
          ingestion: true,
          gate: verification.decision,
          terraformApply: "not_run",
        },
      });
    }
    checkpoint();
    return result("ready", undefined, {
      scope: context.scope,
      binding: bindingOf(context),
      verification: {
        ingestion: true,
        grader: state.steps.grader ?? "not_requested",
        publication: state.steps.publication ?? "not_requested",
        terraformApply: "not_run",
        pullRequestVerdict: "not_requested",
      },
    });
  } finally {
    release();
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
