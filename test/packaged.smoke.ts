// Drives the RELEASE SMOKE itself, end to end, against a stand-in backend:
// pack the package, extract it the way an install would, launch the
// packaged `bin` as a real stdio MCP server, discover the tools, and run the two
// sizing requests — then assert the report is correct AND redacted.
//
// The production run is the same command with `--endpoint https://codetelemetry.com`
// and a real key in CODETELEMETRY_INGEST_KEY. Here the endpoint is a local server
// returning canned estimates, so the harness — packaging, discovery, contract
// checking, session search, and redaction — is proven without touching a customer workspace.
//
// Run:  npm run test:packaged   (needs `npm install`: it packs and spawns)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { MCP_SERVER_VERSION } from "../src/version.ts";
import { ISSUE_SIZING_ERRORS, TOOLS } from "../src/tools.ts";
import { registryIdentity } from "../src/manifest.ts";
import {
  ROUTE_PROVEN_REFUSALS,
  artifactDigest,
  extractTarball,
  linkNodeModules,
  npxLaunch,
  packLocal,
  probeServer,
  resolveBin,
  runNpm,
  sanitizeEnvForSubprocess,
} from "../scripts/harness.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = path.join(PKG_ROOT, "scripts", "mcpSmoke.ts");

// A key-shaped credential that must never appear in the smoke's output.
const KEY = "cot_" + "packagedsmokepackagedsmoke01";

const ESTIMATE = {
  task: { text: "release smoke", source: "text", issueKey: null, terms: ["release"] },
  sizingRequestId: "sr_packaged0000000000000000000",
  size: "S",
  range: { minTokens: 10_000, maxTokens: 40_000 },
  tokens: { point: 20_000, low: 10_000, high: 40_000 },
  basis: "matched",
  sampleCount: 4,
  confidence: { band: "medium", ladder: "medium", similarity: 0.6, evidence: 0.5, corpus: 0.5, agreement: 0.5, reasons: [] },
  matches: [{ sessionId: "s-1", kind: "session", title: "a past session title", useCase: "x", similarityPct: 61, totalTokens: 22_000, lastSeen: "2026-07-01" }],
  model: { rulesVersion: "sizing-2026-07", cohortKey: "repo:acme-api", cohortSampleSize: 12, observationCount: 40 },
  evidence: { lookbackDays: 30, sessions: 20, describedSessions: 12 },
  linearEstimate: null,
  calibrationTask: null,
};

const ISSUE_SOURCE = {
  reference: "ELL-44",
  connectionId: "conn-acme",
  workspace: { id: "ws-acme", name: "Acme Inc", urlKey: "acme" },
  identifier: "ELL-44",
  url: "https://linear.app/acme/issue/ELL-44",
  title: "SECRET-ISSUE-TITLE",
  description: "SECRET-ISSUE-BODY",
  labels: ["mcp"],
  project: null,
  team: null,
  estimate: null,
  normalizedText: "SECRET-NORMALIZED-TEXT",
};

type Seen = { path: string; auth: string | undefined; body: Record<string, unknown> };

/** Spawn the smoke ASYNCHRONOUSLY. spawnSync would block this process's event
 *  loop, so the stand-in backend below could never answer — the requests would
 *  time out and the smoke would "fail" for a reason that has nothing to do with
 *  the artifact. */
function runSmoke(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SMOKE, ...args], { cwd: PKG_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { stdout += c; });
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** How the stand-in backend answers the Linear sizing route. `sized` is the happy
 *  path; `{refusal}` is a route that answered with a typed code; `absent` is the
 *  route missing from the deployment — the case the gate must catch. */
type IssueMode = "sized" | "absent" | { refusal: string };
type SearchMode = "available" | "absent";
type PlanningMode = "available" | "disabled" | "absent";

async function startBackend(
  seen: Seen[],
  issueMode: IssueMode = "sized",
  searchMode: SearchMode = "available",
  planningMode: PlanningMode = "available",
) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      const performance = { totalMs: 11, queryMs: 9, readRows: 100, readBytes: 1_000 };
      if ((req.url ?? "").includes("plan-next-session")) {
        if (planningMode === "absent") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (planningMode === "disabled") {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "planning_disabled", message: "planning capability is disabled" }));
          return;
        }
        res.end(JSON.stringify({
          ok: true,
          state: "insufficient_history",
          message: "Capture one comparable session to calibrate this plan.",
          task: { text: body.taskText, taskText: body.taskText, draftPlan: null, truncated: false },
          budget: { retrievals: 1, interpretationReads: 0, sizingScans: 0, deadlineMs: 4_000 },
          coverage: { retrieved: 0, readable: 0, unavailable: 0, partial: 0 },
          confidence: "low",
          tokenEffort: { point: 0, low: 0, high: 0, basis: "none" },
          sessionBoundaries: [],
          recommendations: [],
          calibrationTask: "Capture one comparable session.",
          limitations: ["No relevant authorized history was available."],
        }));
        return;
      }
      if ((req.url ?? "").includes("session-search")) {
        if (searchMode === "absent") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.end(JSON.stringify({
          ok: true,
          scope: "personal",
          report: {
            results: [],
            total: 0,
            limit: 1,
            offset: 0,
            hasMore: false,
            nextOffset: null,
            query: {
              repo: null,
              model: null,
              text: body.q,
              minDurationMs: null,
              maxDurationMs: null,
              textFields: ["sessionName", "intent", "prompts", "sessionId", "repo", "models", "user", "sourceService"],
              assistant: body.assistant,
              sort: "lastSeen",
              direction: "desc",
              hideEmpty: false,
            },
            repos: [],
            promptSearchAvailable: true,
            contentRedacted: true,
          },
        }));
        return;
      }
      if ((req.url ?? "").includes("linear-issue-size")) {
        if (issueMode === "absent") {
          // What an undeployed route actually looks like: the server's 404, with no
          // typed error the tool could pass through.
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (typeof issueMode === "object") {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: issueMode.refusal, message: `refused: ${issueMode.refusal}` }));
          return;
        }
        res.end(JSON.stringify({
          ok: true,
          scope: "personal",
          estimate: { ...ESTIMATE, issueSource: { ...ISSUE_SOURCE, descriptionChars: 17, descriptionTruncated: false } },
          source: ISSUE_SOURCE,
          performance,
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, scope: "personal", estimate: ESTIMATE, performance }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("npm lifecycle scripts never see the release credentials", { timeout: 300_000 }, async () => {
  // The pre-publish gate installs the candidate tarball with install scripts ENABLED
  // (a customer runs them), while the release job holds a production ingest key and an
  // npm publish token. Anything left in the environment is readable by third-party
  // postinstall code, so npm subprocesses get a stripped environment.
  const env = sanitizeEnvForSubprocess({
    ...process.env,
    CODETELEMETRY_INGEST_KEY: KEY,
    NPM_TOKEN: "npm_tokenvalue",
    NODE_AUTH_TOKEN: "npm_tokenvalue",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "gh-token",
    CODETELEMETRY_API_BASE: "https://codetelemetry.com",
  });
  for (const stripped of [
    "CODETELEMETRY_INGEST_KEY",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
  ]) {
    assert.equal(env[stripped], undefined, `${stripped} must not survive into a subprocess`);
  }
  // Non-secret configuration still has to get through, or npm cannot run at all.
  assert.equal(env.CODETELEMETRY_API_BASE, "https://codetelemetry.com");
  assert.ok(env.PATH ?? env.Path, "PATH must survive");

  // Behavioural: a REAL npm lifecycle script, spawned through the same helper the
  // gate uses, cannot read the key even though this process has it set.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-envprobe-"));
  const previous = process.env.CODETELEMETRY_INGEST_KEY;
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "env-probe",
        version: "1.0.0",
        scripts: {
          prepack: `node -e "require('fs').writeFileSync('probe.txt', process.env.CODETELEMETRY_INGEST_KEY ?? 'ABSENT')"`,
        },
      }),
    );
    process.env.CODETELEMETRY_INGEST_KEY = KEY;
    runNpm(["pack", "--pack-destination", root], root);
    assert.equal(fs.readFileSync(path.join(root, "probe.txt"), "utf8"), "ABSENT");
  } finally {
    if (previous === undefined) delete process.env.CODETELEMETRY_INGEST_KEY;
    else process.env.CODETELEMETRY_INGEST_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--tarball drives a pre-built tarball without running npm install", { timeout: 600_000 }, async () => {
  // The release's credential-bearing job uses this mode: the tarball was already
  // built and install-checked by the secretless job, so here it is only extracted and
  // launched. No `npm install` means no dependency lifecycle script executes beside
  // the production key.
  const seen: Seen[] = [];
  const backend = await startBackend(seen);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ct-tarball-"));
  try {
    const tarball = packLocal(work);
    const run = await runSmoke(
      ["--tarball", tarball, "--endpoint", backend.url, "--require-auth", "--issue", "ELL-44", "--json"],
      {
        ...process.env,
        CODETELEMETRY_INGEST_KEY: KEY,
        CODETELEMETRY_API_BASE: undefined,
        CODETELEMETRY_SMOKE_ISSUE: undefined,
      } as NodeJS.ProcessEnv,
    );
    assert.equal(run.status, 0, `expected a pass
${run.stdout}
${run.stderr}`);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      artifact: string;
      server: { version: string; registryHash: string };
      calls: { tool: string; ok: boolean }[];
    };
    assert.equal(report.ok, true);
    assert.match(report.artifact, /^tarball @codetelemetry\/mcp@.* \(linked\)$/);
    assert.equal(report.server.registryHash, registryIdentity(TOOLS).registryHash);
    for (const tool of ["estimate_plan", "plan_next_session", "search_sessions", "estimate_linear_issue"]) {
      assert.ok(report.calls.find((c) => c.tool === tool)?.ok, `${tool} did not complete`);
    }
    // The tarball it was handed is untouched — this mode consumes, never rebuilds.
    assert.ok(fs.existsSync(tarball));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    await backend.close();
  }
});

test("--install resolves dependencies the way a customer's install does (needs network)", { timeout: 900_000 }, async () => {
  // The packaged check links THIS checkout's dependency graph, so it pins
  // @modelcontextprotocol/sdk to the version in our lockfile while a customer
  // resolves `^1.0.0` fresh. This mode runs a real `npm install` of the candidate
  // tarball and launches what that produced — the release's pre-publish gate uses it,
  // so an install failure or an incompatible graph is caught before the version
  // becomes immutable rather than by the post-publish npx smoke.
  const seen: Seen[] = [];
  const backend = await startBackend(seen);
  try {
    const run = await runSmoke(["--install", "--endpoint", backend.url, "--require-auth", "--issue", "ELL-44", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 0, `expected a pass
${run.stdout}
${run.stderr}`);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      artifact: string;
      server: { version: string; registryHash: string };
      calls: { tool: string; ok: boolean }[];
    };
    assert.equal(report.ok, true);
    assert.match(report.artifact, /^packaged @codetelemetry\/mcp@.* \(installed\)$/);
    assert.equal(report.server.version, MCP_SERVER_VERSION);
    assert.equal(report.server.registryHash, registryIdentity(TOOLS).registryHash);
    // It really ran the tools through the installed copy.
    for (const tool of ["estimate_plan", "plan_next_session", "search_sessions", "estimate_linear_issue"]) {
      assert.ok(report.calls.find((c) => c.tool === tool)?.ok, `${tool} did not complete`);
    }
    assert.ok(!`${run.stdout}
${run.stderr}`.includes(KEY), "the smoke output leaked the plaintext ingest key");
  } finally {
    await backend.close();
  }
});

test("the packaged check supplies only DECLARED dependencies", async () => {
  // If the check linked the whole dev tree, an undeclared bare import would resolve
  // here and nowhere else — so a broken artifact would sail through the pre-publish
  // gate and fail on every customer's install.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-deps-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@codetelemetry/mcp",
        version: "9.9.9",
        dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
        // typescript is installed in this checkout, but as a DEV dependency: the
        // artifact does not declare it, so it must not be reachable.
        devDependencies: { typescript: "^5.9.3" },
      }),
    );
    const linked = linkNodeModules(root);
    assert.ok(linked.includes("@modelcontextprotocol/sdk"), "a declared dependency must be linked");
    assert.ok(linked.some((n) => n === "zod" || n === "express"), "and its transitive closure with it");
    assert.ok(!linked.includes("typescript"), "an undeclared package must not be linked");
    assert.ok(!fs.existsSync(path.join(root, "node_modules", "typescript")));

    // The behaviour that matters: importing it actually fails.
    fs.writeFileSync(path.join(root, "probe.mjs"), 'import "typescript";\n');
    const run = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["probe.mjs"], { cwd: root });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => { stderr += c; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.notEqual(run.status, 0, "an undeclared import must not resolve inside the extracted package");
    assert.match(run.stderr, /Cannot find package|ERR_MODULE_NOT_FOUND/);

    // Sanity: a declared one does resolve, so the closure is sufficient as well as
    // minimal (the packaged launch would otherwise fail for the wrong reason).
    fs.writeFileSync(path.join(root, "ok.mjs"), 'import "@modelcontextprotocol/sdk/client/index.js";\n');
    const good = await new Promise<{ status: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ["ok.mjs"], { cwd: root });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status }));
    });
    assert.equal(good.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only workspace-shaped refusals count as proof that the route is deployed", () => {
  // The gate accepts a typed refusal as evidence, so WHICH codes it accepts is the
  // whole safety property. Two rules: never a code the tool doesn't speak, and never
  // a code that means the sizing path itself is unavailable.
  for (const code of ROUTE_PROVEN_REFUSALS) {
    assert.ok(ISSUE_SIZING_ERRORS.has(code), `${code} is accepted as proof but is not a code the tool passes through`);
  }
  for (const code of [
    "linear_not_configured", // a deployment fault by its own definition
    "linear_unavailable", // upstream Linear is down — the path cannot do its job
    "read_limit_exceeded", // a quota fault, not an answer about the issue
    "invalid_reference", // the smoke sends a well-formed reference…
    "invalid_workspace", // …and no workspace hint, so these mean the server's
    "conflicting_selection", // contract differs from the tool's
  ]) {
    assert.ok(ISSUE_SIZING_ERRORS.has(code), `${code} should be part of the tool's vocabulary`);
    assert.ok(!ROUTE_PROVEN_REFUSALS.has(code), `${code} must NOT count as a healthy route`);
  }
  // Codes outside the typed vocabulary entirely are not accepted either.
  for (const code of ["unauthenticated", "rate_limited", "read_timeout", "sizing_failed", "not_found"]) {
    assert.ok(!ROUTE_PROVEN_REFUSALS.has(code));
  }
});

test("--require-auth fails when the Linear route reports a deployment fault", { timeout: 600_000 }, async () => {
  // `linear_not_configured` is typed, so a broad accept-set would have taken it as
  // proof — while it means the deployment cannot size Linear issues at all.
  const seen: Seen[] = [];
  const backend = await startBackend(seen, { refusal: "linear_not_configured" });
  try {
    const run = await runSmoke(["--packaged", "--endpoint", backend.url, "--require-auth", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 1, `expected a failing exit
${run.stdout}
${run.stderr}`);
    const report = JSON.parse(run.stdout) as { ok: boolean; problems: string[] };
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some((p) => /estimate_linear_issue/.test(p) && /linear_not_configured/.test(p)),
      `expected a problem naming the deployment fault, got ${JSON.stringify(report.problems)}`,
    );
  } finally {
    await backend.close();
  }
});

test("--require-auth probes the Linear sizing route even with no issue configured", { timeout: 600_000 }, async () => {
  // With no smoke issue the route still has to ANSWER — a typed refusal proves it is
  // deployed and authenticated the key, and that is what lets the release proceed.
  const seen: Seen[] = [];
  const backend = await startBackend(seen, { refusal: "no_connected_workspace" });
  try {
    const run = await runSmoke(["--packaged", "--endpoint", backend.url, "--require-auth", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 0, `expected a pass\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      calls: { tool: string; ok: boolean; routeProbed?: string; skipped?: string }[];
    };
    assert.equal(report.ok, true);
    const issueCall = report.calls.find((c) => c.tool === "estimate_linear_issue");
    assert.equal(issueCall?.routeProbed, "no_connected_workspace");
    // It was probed, not skipped-without-asking.
    assert.deepEqual(
      seen.map((s) => s.path),
      ["/api/agent/task-size", "/api/agent/plan-next-session", "/api/agent/session-search", "/api/agent/linear-issue-size"],
    );
    assert.equal(seen[2]!.body.limit, 1);
    assert.equal(seen[3]!.body.reference, "SMOKE-0");
  } finally {
    await backend.close();
  }
});

test("--require-auth fails when the Linear sizing route is not deployed", { timeout: 600_000 }, async () => {
  // The hole this closes: a release could otherwise advertise
  // estimate_linear_issue with its route absent from production.
  const seen: Seen[] = [];
  const backend = await startBackend(seen, "absent");
  try {
    const run = await runSmoke(["--packaged", "--endpoint", backend.url, "--require-auth", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 1, `expected a failing exit\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(run.stdout) as { ok: boolean; problems: string[] };
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some((p) => /estimate_linear_issue/.test(p)),
      `expected a problem naming estimate_linear_issue, got ${JSON.stringify(report.problems)}`,
    );
  } finally {
    await backend.close();
  }
});

test("--require-auth fails when the session search route is not deployed", { timeout: 600_000 }, async () => {
  const seen: Seen[] = [];
  const backend = await startBackend(seen, { refusal: "no_connected_workspace" }, "absent");
  try {
    const run = await runSmoke(["--packaged", "--endpoint", backend.url, "--require-auth", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 1, `expected a failing exit\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(run.stdout) as { ok: boolean; problems: string[] };
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some((p) => /search_sessions/.test(p)),
      `expected a problem naming search_sessions, got ${JSON.stringify(report.problems)}`,
    );
  } finally {
    await backend.close();
  }
});

test("--require-auth blocks publication while planning is disabled", { timeout: 600_000 }, async () => {
  const seen: Seen[] = [];
  const backend = await startBackend(seen, "sized", "available", "disabled");
  try {
    const run = await runSmoke(["--packaged", "--endpoint", backend.url, "--require-auth", "--issue", "ELL-44", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 1, `expected a failing exit\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(run.stdout) as { ok: boolean; problems: string[] };
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some((p) => /plan_next_session/.test(p) && /planning_disabled|dark\/unwired/.test(p)),
      `expected a problem naming the disabled planning route, got ${JSON.stringify(report.problems)}`,
    );
    assert.ok(seen.some((call) => call.path === "/api/agent/plan-next-session"));
  } finally {
    await backend.close();
  }
});

test("--require-auth refuses a discovery-only run", { timeout: 600_000 }, async () => {
  // The release uses this smoke as its pre-publish gate. `tools/list` never touches
  // the backend, so a keyless run proves nothing about the deployed routes — it must
  // fail rather than report a green discovery-only pass.
  const run = await runSmoke(["--packaged", "--endpoint", "http://127.0.0.1:1", "--require-auth", "--json"], {
    ...process.env,
    CODETELEMETRY_INGEST_KEY: undefined,
    CODETELEMETRY_API_BASE: undefined,
    CODETELEMETRY_SMOKE_ISSUE: undefined,
  } as NodeJS.ProcessEnv);
  assert.equal(run.status, 1, `expected a failing exit\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(run.stdout) as { ok: boolean; authenticated: boolean; problems: string[] };
  assert.equal(report.ok, false);
  assert.equal(report.authenticated, false);
  assert.ok(
    report.problems.some((p) => /require-auth/.test(p)),
    `expected a --require-auth problem, got ${JSON.stringify(report.problems)}`,
  );
});

test("a server that never completes the handshake fails fast instead of hanging", { timeout: 30_000 }, async () => {
  // The release job's concurrency group is non-cancellable, so an unbounded wait
  // here would wedge releases behind a stalled `npx` or a broken build until the
  // CI job's multi-hour limit.
  const started = Date.now();
  await assert.rejects(
    probeServer({
      command: process.execPath,
      // Spawns, speaks MCP never, and would happily outlive the check.
      args: ["-e", "setInterval(() => {}, 1000)"],
      handshakeMs: 1_500,
    }),
    /did not complete the MCP handshake/,
  );
  assert.ok(Date.now() - started < 20_000, "the handshake deadline must bound the wait");
});

test("a server that exits before the handshake reports its own stderr, without key-shaped values", { timeout: 30_000 }, async () => {
  // An `npx` that cannot resolve the package exits at once; without its message the
  // release log says only "Connection closed".
  const secret = "cot_" + "stderrshouldneverprintthis01";
  await assert.rejects(
    probeServer({
      command: process.execPath,
      args: ["-e", `console.error("npm error code ETARGET"); console.error(process.env.PROBE_SECRET); process.exit(1)`],
      env: { PROBE_SECRET: secret },
      handshakeMs: 5_000,
    }),
    (err: Error) => {
      assert.match(err.message, /did not complete the MCP handshake/);
      assert.match(err.message, /server stderr[\s\S]*npm error code ETARGET/);
      assert.ok(!err.message.includes(secret), "stderr is scrubbed of key-shaped values");
      return true;
    },
  );
});

test("the artifact digest reacts to shipped payload only", () => {
  // The release gate compares this digest between the local and the published
  // tarball at the SAME version: it must catch anything that changes what an
  // installed server runs, and ignore anything that doesn't — otherwise a README
  // typo fix would demand a version bump.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-digest-"));
  const pkg = {
    name: "@codetelemetry/mcp",
    version: "9.9.9",
    description: "first",
    type: "module",
    bin: { "codetelemetry-mcp": "./dist/mcp/src/server.js" },
    files: ["dist"],
    dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
  };
  const write = (rel: string, body: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  const writePkg = (over: Record<string, unknown> = {}) =>
    write("package.json", JSON.stringify({ ...pkg, ...over }));
  try {
    write("dist/mcp/src/server.js", "console.log(1)\n");
    write("tool-manifest.json", '{"toolCount":1}\n');
    write("README.md", "docs\n");
    writePkg();
    const base = artifactDigest(root);

    assert.equal(artifactDigest(root), base, "the digest must be deterministic");

    // Ignored: presentation, the version itself (versions are only compared when
    // they are already equal), and scripts a consumer never runs.
    write("README.md", "different docs\n");
    writePkg({ description: "second", version: "9.9.10", scripts: { test: "node --test", build: "tsc" } });
    assert.equal(artifactDigest(root), base, "README/description/version/dev scripts must not move the digest");

    // Caught: shipped code, the shipped manifest, and install-affecting metadata.
    write("dist/mcp/src/server.js", "console.log(2)\n");
    const changedCode = artifactDigest(root);
    assert.notEqual(changedCode, base, "a dist change must move the digest");

    write("dist/mcp/src/server.js", "console.log(1)\n");
    writePkg({ dependencies: { "@modelcontextprotocol/sdk": "^2.0.0" } });
    assert.notEqual(artifactDigest(root), base, "a dependency change must move the digest");

    writePkg();
    write("tool-manifest.json", '{"toolCount":2}\n');
    assert.notEqual(artifactDigest(root), base, "a manifest change must move the digest");

    // Caught: everything else that changes what npm resolves, runs on install, or
    // refuses to install. A postinstall hook appearing is the sharp one — it
    // executes on a customer's machine.
    write("tool-manifest.json", '{"toolCount":1}\n');
    for (const over of [
      { scripts: { test: "node --test", postinstall: "node ./evil.js" } },
      { scripts: { preinstall: "echo hi" } },
      { optionalDependencies: { chalk: "^5.0.0" } },
      { peerDependencies: { typescript: "^5.0.0" } },
      { bundleDependencies: ["chalk"] },
      { engines: { node: ">=24" } },
      { os: ["linux"] },
      { cpu: ["arm64"] },
      { exports: { ".": "./dist/other.js" } },
      { files: ["dist", "extra"] },
    ] as Record<string, unknown>[]) {
      writePkg(over);
      assert.notEqual(artifactDigest(root), base, `${Object.keys(over)[0]} must move the digest`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the customer launch command is the documented npx install, on either platform", () => {
  // This is the command the release workflow runs against production, and the one
  // path the local suites cannot execute end to end (it needs a published
  // version) — so at least pin what gets spawned.
  assert.deepEqual(npxLaunch("@codetelemetry/mcp@1.2.3", "linux"), {
    command: "npx",
    args: ["-y", "--package=@codetelemetry/mcp@1.2.3", "codetelemetry-mcp"],
    label: "npx -y --package=@codetelemetry/mcp@1.2.3 codetelemetry-mcp",
  });
  // Node refuses to spawn a .cmd shim directly, so Windows goes through cmd.exe.
  assert.deepEqual(npxLaunch("@codetelemetry/mcp", "win32"), {
    command: "cmd.exe",
    args: ["/c", "npx", "-y", "--package=@codetelemetry/mcp", "codetelemetry-mcp"],
    label: "npx -y --package=@codetelemetry/mcp codetelemetry-mcp",
  });
  assert.deepEqual(npxLaunch("@codetelemetry/mcp@1.2.3", "linux", "/fresh/customer"), {
    command: "npx",
    args: ["-y", "--package=@codetelemetry/mcp@1.2.3", "codetelemetry-mcp"],
    label: "npx -y --package=@codetelemetry/mcp@1.2.3 codetelemetry-mcp",
    cwd: "/fresh/customer",
  });
});

test("the packed artifact discovers and refuses interpret_session without leaking a key", { timeout: 300_000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ct-interpret-pack-"));
  try {
    const pkgDir = extractTarball(packLocal(work), work);
    linkNodeModules(pkgDir);
    let result: Record<string, unknown> | undefined;
    const probe = await probeServer({
      command: process.execPath,
      args: [resolveBin(pkgDir)],
      timeoutMs: 30_000,
      calls: async (call) => { result = await call("interpret_session", { sessionId: "session-a", evidenceIds: ["e0"] }); },
    });
    assert.ok(probe.tools.some(tool => tool.name === "interpret_session"), "packed tools/list must advertise interpret_session");
    assert.equal(result?.ok, false);
    assert.equal(result?.error, "no_key");
    assert.ok(!JSON.stringify(result).includes(KEY), "packed refusal leaked a plaintext key");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("the release smoke packs, launches and verifies the artifact a customer installs", { timeout: 600_000 }, async () => {
  const seen: Seen[] = [];
  const backend = await startBackend(seen);
  try {
    const run = await runSmoke(["--packaged", "--endpoint", backend.url, "--issue", "ELL-44", "--json"], {
      ...process.env,
      CODETELEMETRY_INGEST_KEY: KEY,
      // Must not be inherited from the developer's shell: the endpoint under test
      // is the one passed on the command line.
      CODETELEMETRY_API_BASE: undefined,
      CODETELEMETRY_SMOKE_ISSUE: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(run.status, 0, `smoke exited ${run.status}\n${run.stdout}\n${run.stderr}`);

    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      artifact: string;
      endpoint: string;
      sourceSha: string | null;
      server: { name: string; version: string; registryHash: string; toolCount: number };
      discovery: { toolCount: number; matchesCommittedManifest: boolean; sizingToolsPresent: string[] };
      authenticated: boolean;
      calls: { tool: string; ok: boolean; summary?: Record<string, unknown>; skipped?: string }[];
      problems: string[];
    };

    assert.equal(report.ok, true, `smoke reported problems: ${report.problems.join("; ")}`);
    assert.deepEqual(report.problems, []);

    // ── It captured which build answered, and where ──────────────────────────
    const identity = registryIdentity(TOOLS);
    assert.equal(report.server.version, MCP_SERVER_VERSION);
    assert.equal(report.server.registryHash, identity.registryHash);
    assert.equal(report.server.toolCount, TOOLS.length);
    assert.equal(report.endpoint, backend.url);
    assert.match(report.artifact, /^packaged @codetelemetry\/mcp@.* \(linked\)$/);
    assert.ok(report.sourceSha === null || /^[0-9a-f]{7,40}$/.test(report.sourceSha), "sourceSha must be a SHA or null");

    // ── A fresh client discovered the sizing tools ───────────────────────────
    assert.equal(report.discovery.matchesCommittedManifest, true);
    assert.deepEqual(report.discovery.sizingToolsPresent, [
      "estimate_task_size",
      "estimate_plan",
      "estimate_linear_issue",
    ]);

    // ── The authenticated probes completed and returned their contracts ─────
    assert.equal(report.authenticated, true);
    const byTool = new Map(report.calls.map((c) => [c.tool, c]));
    for (const tool of ["estimate_plan", "plan_next_session", "search_sessions", "estimate_linear_issue"]) {
      const call = byTool.get(tool);
      assert.ok(call?.ok, `${tool} did not complete: ${JSON.stringify(call)}`);
      if (tool === "search_sessions" || tool === "plan_next_session") continue;
      assert.equal(call!.summary!.rulesVersion, "sizing-2026-07");
      assert.equal(call!.summary!.sizingRequestIdPresent, true);
      assert.equal(call!.summary!.size, "S");
      assert.equal(call!.summary!.basis, "matched");
      assert.equal(call!.summary!.confidenceBand, "medium");
    }
    assert.deepEqual(byTool.get("estimate_linear_issue")!.summary!.issue, {
      identifier: "ELL-44",
      workspace: "acme",
    });

    // ── Redaction: the credential and the issue's content stay out of the log ─
    const output = `${run.stdout}\n${run.stderr}`;
    assert.ok(!output.includes(KEY), "the smoke output leaked the plaintext ingest key");
    for (const secret of ["SECRET-ISSUE-TITLE", "SECRET-ISSUE-BODY", "SECRET-NORMALIZED-TEXT", "a past session title"]) {
      assert.ok(!output.includes(secret), `the smoke output leaked issue/history content: ${secret}`);
    }

    // ── The requests were the bounded, read-only ones we think they are ──────
    const paths = seen.map((s) => s.path);
    assert.deepEqual(paths, [
      "/api/agent/task-size",
      "/api/agent/plan-next-session",
      "/api/agent/session-search",
      "/api/agent/linear-issue-size",
    ]);
    for (const call of seen) {
      // The key travels in the Authorization header only — never in a body.
      assert.equal(call.auth, `Bearer ${KEY}`);
      assert.ok(!JSON.stringify(call.body).includes(KEY), "the ingest key appeared in a request body");
      if (call.path === "/api/agent/session-search") {
        assert.equal(call.body.assistant, "codex");
        assert.equal(call.body.limit, 1);
      } else if (call.path === "/api/agent/plan-next-session") {
        assert.match(String(call.body.taskText), /bounded authenticated planning release smoke/);
      } else if (call.path === "/api/agent/task-size") {
        // The plan estimate reads at most 20 sessions from the last day.
        assert.equal(call.body.lookbackDays, 1);
        assert.equal(call.body.limit, 20);
      } else {
        assert.equal(call.body.lookbackDays, 1);
        assert.equal(call.body.limit, 1);
      }
    }
    assert.match(String(seen[0]!.body.taskText), /CodeTelemetry MCP release smoke/);
    assert.equal(seen[3]!.body.reference, "ELL-44");
  } finally {
    await backend.close();
  }
});
