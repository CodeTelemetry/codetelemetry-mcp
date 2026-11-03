import test from "node:test";
import { MCP_SERVER_VERSION } from "../src/version.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveWorkspace,
  loadWorkspace,
  bindWorkspace,
  findWorkspaceBinding,
  listWorkspaces,
  contextPath,
  WORKSPACE_MCP_PACKAGE,
  writeCodexWorkspaceProfile,
  codexWorkspaceProfilePath,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../src/client/workspaces.ts";
import { bootstrapWorkspace } from "../src/client/bootstrap.ts";
import { callTool } from "../src/tools.ts";
import { OnboardingSession } from "../src/session.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-contexts-"));
process.env.CODETELEMETRY_CONTEXT_HOME = path.join(root, "contexts");
const scope = {
  tenantId: "synthetic-owner",
  teamId: "tm_synthetic",
  billingAccountId: "synthetic-billing",
};
const context = {
  version: 1 as const,
  name: "synthetic",
  apiBase: "https://api.example.test",
  ingestEndpoint: "https://ingest.example.test",
  scope,
  ingestKey: "cot_synthetic_private_key_00000000000000",
};
const repository = path.join(root, "repo");
fs.mkdirSync(repository);
const check = {
  id: "custom.unit",
  name: "Unit",
  weight: 100,
  enabled: true,
  category: "unit_test",
  satisfactionMode: "successful",
  minimumOccurrences: 1,
  aggregationMode: "once",
  matcherRule: {
    include: { field: "packageScript", operator: "equals", value: "test:unit" },
  },
};
let funded = false,
  probes = 0,
  publications = 0,
  failPublicationResponse = false;
let checks: Record<string, unknown>[] = [],
  revision = "a".repeat(64),
  publishedMatchesDraft = false;
const fetchImpl: typeof fetch = async (url, init) => {
  const route = new URL(String(url)).pathname,
    body = JSON.parse(String(init?.body ?? "{}"));
  const reply = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status });
  if (route === "/api/device/code/bootstrap-v1")
    return reply({
      device_code: "synthetic-device-code",
      user_code: "TEST-CODE",
      expires_in: 600,
      interval: 1,
    });
  if (route === "/api/device/token")
    return reply({
      api_key: context.ingestKey,
      ingest_endpoint: context.ingestEndpoint,
      scope,
    });
  if (route === "/api/connectivity/check")
    return reply(
      {
        scope,
        state: body.probeId
          ? "connected"
          : funded
            ? "scope_verified"
            : "budget_exhausted",
        seen: !!body.probeId,
      },
      funded ? 200 : 402,
    );
  if (route === "/v1/logs") {
    probes++;
    return reply({});
  }
  assert.deepEqual(
    JSON.parse(new Headers(init?.headers).get("x-codetelemetry-workspace")!),
    scope,
  );
  if (route === "/api/agent/grader")
    return reply({
      ok: true,
      config: {
        revision,
        draft: { checks },
        totalChecks: checks.length,
        publishedVersion: publications + 1,
        publishedMatchesDraft,
      },
    });
  if (route === "/api/agent/grader/configure") {
    assert.equal(body.expectedRevision, revision);
    checks = body.upsertChecks;
    revision = "b".repeat(64);
    return reply({ ok: true, config: { revision } });
  }
  if (route === "/api/agent/grader/publish") {
    publications++;
    publishedMatchesDraft = true;
    revision = "c".repeat(64);
    if (failPublicationResponse) {
      failPublicationResponse = false;
      throw new Error("synthetic interrupted response");
    }
    return reply({
      ok: true,
      config: { revision, publishedVersion: publications + 1 },
    });
  }
  throw new Error(`Unexpected synthetic route ${route}`);
};

test("contexts survive a fresh MCP session and bindings contain no credential", async () => {
  saveWorkspace(context);
  bindWorkspace(repository, context);
  assert.equal(fs.statSync(contextPath(context.name)).mode & 0o777, 0o600);
  assert.equal(loadWorkspace(context.name).ingestKey, context.ingestKey);
  assert.deepEqual(findWorkspaceBinding(repository)?.scope, scope);
  assert.ok(
    !fs
      .readFileSync(
        path.join(repository, ".codetelemetry/workspace.json"),
        "utf8",
      )
      .includes("ingestKey"),
  );
  assert.ok(!JSON.stringify(listWorkspaces()).includes(context.ingestKey));
  const previous = process.cwd();
  process.chdir(repository);
  try {
    const ctx = { session: new OnboardingSession(), fetchImpl };
    const status = await callTool("status", {}, ctx);
    assert.equal(status.ok, true);
    assert.equal((status.workspace as any).name, context.name);
    assert.equal(ctx.session.source, "workspace");
    assert.ok(!JSON.stringify(status).includes(context.ingestKey));
  } finally {
    process.chdir(previous);
  }
});
test("scope changes, unsafe names, symlinks, permissions and versions fail closed", () => {
  assert.throws(
    () =>
      saveWorkspace({ ...context, scope: { ...scope, teamId: "tm_other" } }),
    /identity changed/,
  );
  assert.throws(
    () => bindWorkspace(repository, { ...context, name: "other" }),
    /another workspace/,
  );
  assert.throws(() => loadWorkspace("../secret"), /Workspace name/);
  const file = contextPath(context.name);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadWorkspace(context.name), /private/);
  fs.chmodSync(file, 0o600);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...context, version: 99 }));
  assert.throws(() => loadWorkspace(context.name), /version/);
  fs.writeFileSync(file, original);
  const link = contextPath("linked");
  fs.symlinkSync(file, link);
  assert.throws(() => loadWorkspace("linked"), /symbolic/);
  fs.unlinkSync(link);
});
test("bootstrap pauses before config writes for funding and resumes publication after an uncertain response", async () => {
  const plan = {
    name: context.name,
    repositoryPath: repository,
    client: "codex" as const,
    checks: [check],
    features: "Unit tests",
    publish: true,
    terraform: true,
  };
  const environment = { apiBase: context.apiBase, fetchImpl };
  const first = await bootstrapWorkspace(plan, environment);
  assert.equal(first.status, "funding_required");
  assert.equal(probes, 0);
  assert.equal(
    fs.existsSync(path.join(repository, ".codex/config.toml")),
    false,
  );
  const baseConfig = path.join(process.env.CODEX_HOME!, "config.toml");
  fs.mkdirSync(path.dirname(baseConfig), { recursive: true });
  fs.writeFileSync(baseConfig, "[otel]\nlog_user_prompt = true\n");
  funded = true;
  failPublicationResponse = true;
  await assert.rejects(
    () => bootstrapWorkspace({ name: context.name }, environment),
    /interrupted/,
  );
  assert.equal(publications, 1);
  const resumed = await bootstrapWorkspace({ name: context.name }, environment);
  assert.equal(resumed.status, "ready");
  assert.equal(publications, 1);
  assert.equal(probes, 1);
  assert.equal(resumed.steps.publication, "policy_2");
  assert.equal(
    fs.readFileSync(baseConfig, "utf8"),
    "[otel]\nlog_user_prompt = true\n",
  );
  assert.ok(
    fs
      .readFileSync(codexWorkspaceProfilePath(context.name), "utf8")
      .includes("log_user_prompt = false"),
  );
  assert.ok(!fs.existsSync(path.join(repository, ".codex/config.toml")));
  assert.ok(
    fs
      .readFileSync(codexWorkspaceProfilePath(context.name), "utf8")
      .includes(context.ingestKey),
  );
  assert.ok(
    !fs
      .readFileSync(
        path.join(repository, "codetelemetry-grader.tf.json"),
        "utf8",
      )
      .includes(context.ingestKey),
  );
  await assert.rejects(
    () =>
      bootstrapWorkspace(
        { name: context.name, organizationId: "tm_other" },
        environment,
      ),
    /plan changed/,
  );
});
test("new-organization authorization persists across invocations and does not duplicate the device request", async () => {
  const name = "new-organization",
    repo = path.join(root, "new-repo");
  fs.mkdirSync(repo);
  const environment = { apiBase: context.apiBase, fetchImpl };
  const first = await bootstrapWorkspace(
    { name, repositoryPath: repo, organizationName: "Synthetic organization" },
    environment,
  );
  assert.equal(first.status, "authorization_required");
  const stateFile = path.join(
    process.env.CODETELEMETRY_CONTEXT_HOME!,
    `${name}.bootstrap.json`,
  );
  const state = readWorkspaceFile(stateFile) as any;
  const device = state.pending.deviceCode;
  const pending = await bootstrapWorkspace({ name }, environment);
  assert.equal(pending.status, "authorization_pending");
  state.pending.nextPoll = 0;
  writeWorkspaceFile(stateFile, state);
  assert.equal(
    (await bootstrapWorkspace({ name }, environment)).status,
    "ready",
  );
  assert.equal(loadWorkspace(name).scope.teamId, scope.teamId);
  assert.equal(device, "synthetic-device-code");
});
test("workspace profile hooks are scoped to the selected profile and never mutate global hooks", () => {
  const hooksFile = path.join(process.env.CODEX_HOME!, "hooks.json");
  fs.writeFileSync(hooksFile, '{"hooks":{}}');
  writeCodexWorkspaceProfile(context, { repositoryObservation: true });
  const profile = fs.readFileSync(
    codexWorkspaceProfilePath(context.name),
    "utf8",
  );
  assert.ok(profile.includes("[[hooks.SessionStart.hooks]]"));
  assert.ok(profile.includes("[mcp_servers.codetelemetry_workspace]"));
  assert.ok(profile.includes(WORKSPACE_MCP_PACKAGE));
  assert.ok(
    !fs
      .readFileSync(
        path.join(
          process.env.CODETELEMETRY_CONTEXT_HOME!,
          context.name + ".hook.cjs",
        ),
        "utf8",
      )
      .includes(context.ingestKey),
  );
  assert.equal(fs.readFileSync(hooksFile, "utf8"), '{"hooks":{}}');
});
test("personal context reauthorization remains personal and installs a bound Claude MCP entry", async () => {
  const name = "personal",
    repo = path.join(root, "personal-repo");
  fs.mkdirSync(repo);
  const personalScope = {
    tenantId: "synthetic-owner",
    teamId: null,
    billingAccountId: "synthetic-owner",
  };
  const personalKey = "cot_synthetic_personal_000000000000000";
  saveWorkspace({
    ...context,
    name,
    scope: personalScope,
    ingestKey: personalKey,
  });
  const personalFetch: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname,
      body = JSON.parse(String(init?.body ?? "{}"));
    const reply = (v: unknown) => new Response(JSON.stringify(v));
    if (route === "/api/device/code/scope-v1") {
      assert.deepEqual(body.expected, personalScope);
      return reply({
        device_code: "synthetic-personal",
        user_code: "SELF-CODE",
        expires_in: 600,
        interval: 1,
      });
    }
    if (route === "/api/device/token/scope-v1")
      return reply({
        api_key: personalKey,
        scope: personalScope,
        ingest_endpoint: context.ingestEndpoint,
      });
    if (route === "/api/connectivity/check")
      return reply({
        scope: personalScope,
        state: body.probeId ? "connected" : "scope_verified",
        seen: !!body.probeId,
      });
    if (route === "/v1/logs") return reply({});
    throw new Error("Unexpected personal route");
  };
  const environment = { apiBase: context.apiBase, fetchImpl: personalFetch };
  const auth = await bootstrapWorkspace(
    { name, client: "claude", repositoryPath: repo, reauthorize: true },
    environment,
  );
  assert.equal(auth.status, "authorization_required");
  assert.ok(!String((auth as any).authorizationUrl).includes("teamId="));
  const file = path.join(
      process.env.CODETELEMETRY_CONTEXT_HOME!,
      `${name}.bootstrap.json`,
    ),
    state = readWorkspaceFile(file) as any;
  state.pending.nextPoll = 0;
  writeWorkspaceFile(file, state);
  assert.equal(
    (await bootstrapWorkspace({ name }, environment)).status,
    "ready",
  );
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.codetelemetry.env.CODETELEMETRY_WORKSPACE, name);
  assert.ok(!JSON.stringify(mcp).includes(personalKey));
  assert.ok(WORKSPACE_MCP_PACKAGE.endsWith("@" + MCP_SERVER_VERSION));
});
test("workspace state enforces byte and context-count bounds before accepting more data", () => {
  const file = contextPath(context.name),
    original = fs.readFileSync(file);
  fs.writeFileSync(file, "x".repeat(65537));
  assert.throws(() => loadWorkspace(context.name), /64 KiB/);
  fs.writeFileSync(file, original);
  const previous = process.env.CODETELEMETRY_CONTEXT_HOME;
  process.env.CODETELEMETRY_CONTEXT_HOME = path.join(root, "limit-store");
  try {
    for (let i = 0; i < 64; i++)
      saveWorkspace({ ...context, name: `limit${i}` });
    assert.equal(listWorkspaces().length, 64);
    assert.throws(
      () => saveWorkspace({ ...context, name: "overflow" }),
      /full/,
    );
  } finally {
    process.env.CODETELEMETRY_CONTEXT_HOME = previous;
  }
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
