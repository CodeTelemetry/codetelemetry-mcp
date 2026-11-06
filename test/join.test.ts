import "./support/isolateHome.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinOrganization, joinPlan } from "../src/client/join.ts";
import { callTool, type ToolContext } from "../src/tools.ts";
import { OnboardingSession } from "../src/session.ts";
import { importWorkspaceHistory } from "../src/client/workspaceImport.ts";
import { loadWorkspace, saveWorkspace, bindWorkspace, findWorkspaceBinding, workspaceHome,
  writeWorkspaceFile, contextPath } from "../src/client/workspaces.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-member-join-"));
process.env.CODETELEMETRY_CONTEXT_HOME = path.join(root, "contexts");
process.env.CODEX_HOME = path.join(root, "codex-home");
const repository = path.join(root, "project");
fs.mkdirSync(repository);
const scope = { tenantId: "synthetic-member", teamId: "tm_synthetic", billingAccountId: "tm_synthetic" };
const key = "cot_synthetic_member_join_000000000000";
const options = { organizationId: scope.teamId, repositoryPath: repository, client: "codex" as const, apiBase: "https://api.example.test" };
let deviceRequests = 0, probes = 0;
const fetchImpl: typeof fetch = async (url, init) => {
  const route = new URL(String(url)).pathname;
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (route === "/api/device/code/scope-v1") {
    deviceRequests++; assert.deepEqual(body.expected, { teamId: scope.teamId });
    return Response.json({ device_code: "synthetic-device", user_code: "TEST-CODE", expires_in: 600, interval: 1 });
  }
  if (route === "/api/device/token/scope-v1") return Response.json({ api_key: key, ingest_endpoint: "https://ingest.example.test", scope });
  if (route === "/api/connectivity/check") return Response.json({ seen: Boolean(body.probeId), scope,
    state: body.probeId ? "connected" : "scope_verified", budget: { creditBalanceUsd: 10, seats: 0, remainingIncludedTokens: 0 } });
  if (route === "/v1/logs") { probes++; assert.match(JSON.stringify(body), /codetelemetry.probe.client/); return Response.json({}); }
  throw new Error(`Unexpected request: ${route}`);
};

test("join resumes one authorization, retains project isolation and capture, and distinguishes live verification", async () => {
  const first = await joinOrganization(options, { fetchImpl, interactive: false });
  assert.equal(first.status, "authorization_required");
  assert.equal(deviceRequests, 1);
  const stateFile = path.join(workspaceHome(), `${first.workspace}.bootstrap.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.plan.enrich, true);
  assert.equal(state.plan.organizationName, undefined);
  state.pending.nextPoll = 0;
  writeWorkspaceFile(stateFile, state);
  const logs: string[] = [], opened: string[] = [];
  const result = await joinOrganization(options, { fetchImpl, interactive: false, log: message => logs.push(message), open: url => { opened.push(url); } });
  assert.equal(result.status, "ready");
  assert.equal(deviceRequests, 1); assert.equal(probes, 1);
  assert.equal((result as any).liveSessionVerified, false);
  const progress = new URL((result as any).progressUrl);
  assert.equal(progress.searchParams.get("project"), repository);
  assert.equal(progress.searchParams.get("workspace"), first.workspace);
  assert.equal(progress.pathname, `/app/teams/${scope.teamId}/connect`);
  assert(!logs.join("\n").includes(key));
  assert(!JSON.stringify(result).includes(key));
  const saved = loadWorkspace(first.workspace);
  assert.equal(saved.clientConfig?.enrich, true);
  assert.equal(saved.clientConfig?.repositoryObservation, true);
  assert(!fs.existsSync(path.join(process.env.CODEX_HOME!, "config.toml")), "user-wide settings are preserved");
  assert.throws(() => joinPlan({ ...options, organizationId: "tm_other" }), /another destination/);
  assert.throws(() => joinPlan({ ...options, enrich: false }), /saved capture choice/);
  assert.throws(() => joinPlan({ ...options, repositoryPath: os.homedir() }), /project directory/);
  const second = { ...saved, name: "synthetic-second-client", clientConfig: { ...saved.clientConfig!, client: "claude" as const } };
  saveWorkspace(second); bindWorkspace(repository, second, "claude");
  assert.equal(findWorkspaceBinding(repository, second.name)?.name, second.name);
  assert.equal(findWorkspaceBinding(repository, saved.name)?.name, saved.name);
  assert(!fs.readFileSync(path.join(repository, ".codetelemetry/workspace.json"), "utf8").includes(key));
});

test("workspace import previews locally, fences destination, selects exact plans, and deduplicates retries", async () => {
  const project = path.join(root, "history-project"); fs.mkdirSync(project);
  const config = path.join(root, "history.config.toml");
  fs.writeFileSync(config, "[otel]\nlog_user_prompt = true\n");
  const context = { version: 1 as const, name: "synthetic-history", apiBase: "https://api.example.test",
    ingestEndpoint: "https://ingest.example.test", ingestKey: key, scope,
    clientConfig: { client: "codex" as const, path: config, enrich: true, repositoryObservation: true } };
  saveWorkspace(context); bindWorkspace(project, context, "codex");
  writeWorkspaceFile(path.join(workspaceHome(), `${context.name}.bootstrap.json`), { plan: { repositoryPath: project } });
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "client/fixtures/import/codex-sessions");
  const history = path.join(root, "history"); fs.cpSync(fixtures, history, { recursive: true });
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else { fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("/work/svc", project)); fs.utimesSync(file, Date.parse("2026-10-03") / 1000, Date.parse("2026-10-03") / 1000); }
  } }; walk(history);
  // A busy machine can have enormous transcripts for unrelated projects.
  // Their cheap metadata must exclude them before charging a full-file read.
  const unrelated = path.join(history, "rollout-unrelated.jsonl");
  fs.writeFileSync(unrelated, JSON.stringify({ type: "session_meta", payload: { id: "unrelated", cwd: "/another-project" } }) + "\n");
  fs.truncateSync(unrelated, 200 * 1024 * 1024);
  fs.utimesSync(unrelated, Date.parse("2026-10-03") / 1000, Date.parse("2026-10-03") / 1000);
  const injected = { codexDir: history, ledgerPath: path.join(root, "history-ledger.json"), nowMs: Date.parse("2026-10-10T12:00:00Z"), sleep: async () => {} };
  const preview = await importWorkspaceHistory({ name: context.name, preview: true }, {
    ...injected, fetchImpl: async () => { throw new Error("A preview must never use the network."); },
  });
  assert.equal(preview.previewSessions?.length, 2);
  assert.equal(preview.sources[0].skipped.filtered, 1);
  assert.equal(preview.content.codex.prompts, true);
  assert.equal(fs.existsSync(injected.ledgerPath), false);
  const serializedPreview = fs.readFileSync(path.join(workspaceHome(), `${context.name}.import-preview.json`), "utf8");
  assert(!serializedPreview.includes(key)); assert(!serializedPreview.includes("add caching"));
  const calls: Array<{ url: string; body: any }> = [];
  const transport: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")); calls.push({ url: String(url), body });
    if (String(url).endsWith("/api/connectivity/check")) return Response.json({ state: "scope_verified", scope, seen: false });
    if (String(url).endsWith("/api/agent/import-status")) return Response.json({ ok: true, sessions: body.sessions.map((s: any) => ({ sessionId: s.sessionId, live: false, plans: [] })), settleMs: 300000, nowMs: injected.nowMs });
    return Response.json({});
  };
  await assert.rejects(importWorkspaceHistory({ name: context.name, selections: [1] }, { ...injected, fetchImpl: transport }), /confirm/);
  const session = new OnboardingSession(); session.setKey(key, "workspace");
  const mcp: ToolContext = { session, workspace: context, workspaceInitialized: true, workspaceClient: "codex",
    configPathsOverride: { codex: config }, endpointsOverride: endpointsForTest(context), importOverrides: injected, fetchImpl: transport };
  const dry = await callTool("import_history", {}, mcp) as any;
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.totals.sessions, 2);
  assert.equal((await callTool("import_history", { project: root }, mcp)).ok, false);
  const imported = await importWorkspaceHistory({ name: context.name, selections: [1], confirm: true }, { ...injected, fetchImpl: transport });
  assert.equal(imported.totals.sessions, 1);
  const importedBodies = JSON.stringify(calls.filter(c => c.url.endsWith("/v1/logs") || c.url.endsWith("/v1/metrics")));
  assert(importedBodies.includes(preview.previewSessions![0].sessionId));
  assert(!importedBodies.includes(preview.previewSessions![1].sessionId), "unselected sessions cannot upload");
  const repeat = await importWorkspaceHistory({ name: context.name, selections: [1], confirm: true }, { ...injected, fetchImpl: transport });
  assert.equal(repeat.totals.sessions, 0);
  const previousUploads = calls.filter(c => c.url.endsWith("/v1/logs")).length;
  const other = { ...context, scope: { ...scope, teamId: "tm_other" } };
  // Simulate a destination change after preview. The repository fence rejects it before network.
  writeWorkspaceFile(contextPath(context.name), other);
  await assert.rejects(importWorkspaceHistory({ name: context.name, selections: [2], confirm: true }, { ...injected, fetchImpl: transport }), /binding|destination/);
  assert.equal(calls.filter(c => c.url.endsWith("/v1/logs")).length, previousUploads);
  assert(fs.existsSync(contextPath(context.name)));
});

function endpointsForTest(context: { apiBase: string; ingestEndpoint: string }) {
  return { apiBase: context.apiBase, ingestEndpoint: context.ingestEndpoint };
}
