// Release smoke: drive the MCP server a CUSTOMER would launch, against a DEPLOYED
// CodeTelemetry endpoint, over real stdio — then report what was discovered and
// what one safe request returned.
//
// Registry unit tests prove the source inventory. They cannot prove that the
// artifact a client downloads serves that inventory, or that the routes behind the
// sizing tools answer in production. This does both:
//
//   npm run smoke                                  # pack this checkout, hit prod
//   npm run smoke -- --tarball path/to.tgz         # use these exact bytes
//   npm run smoke -- --install                     # deps via real `npm install`
//   npm run smoke -- --npx                         # the documented customer path
//   npm run smoke -- --npx=@codetelemetry/mcp@0.3.9
//   npm run smoke -- --endpoint http://127.0.0.1:8787 --source
//
// Credentials come from the environment ONLY — never a flag, which would land in
// shell history and CI logs:
//
//   CODETELEMETRY_INGEST_KEY    a cot_… ingest key; without it the run is
//                               DISCOVERY-ONLY and says so in the report (pass
//                               --require-auth to make that a failure instead,
//                               which is what the release gate does)
//   CODETELEMETRY_SMOKE_ISSUE   a Linear issue URL/identifier to size (optional)
//
// The report is model-safe and log-safe by construction: every field is copied
// into it explicitly (allowlist), so issue bodies, matched session titles and plan
// text can't leak in, and the whole thing is scrubbed for key-shaped strings as a
// backstop before it is printed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scrub } from "../src/client/keys.ts";
import { diffEntries, normalizeEntries, type ToolManifest } from "../src/manifest.ts";
import { MANIFEST_PATH, readJsonFile } from "./paths.ts";
import {
  extractTarball,
  installTarball,
  linkNodeModules,
  makeTempDir,
  npxLaunch,
  ROUTE_PROVEN_REFUSALS,
  packLocal,
  probeServer,
  removeDir,
  resolveBin,
  sourceLaunch,
  type Launch,
  type ServerProbe,
} from "./harness.ts";

const DEFAULT_ENDPOINT = "https://codetelemetry.com";
const PACKAGE_NAME = "@codetelemetry/mcp";

// Bounded on purpose: this proves the deployed contracts with the smallest legal
// history read. Release validation must not become a production scan.
const SMOKE_LOOKBACK_DAYS = 1;
const SMOKE_LIMIT = 1;
const SIZING_TOOLS = ["estimate_task_size", "estimate_plan", "estimate_linear_issue"];

/** A plan that says what it is, so an operator seeing it in their own telemetry
 *  knows why. Deliberately generic: it is sized against the caller's history, and
 *  a smoke must not describe unreleased work. */
const SMOKE_PLAN = {
  title: "CodeTelemetry MCP release smoke",
  steps: [
    "Confirm the deployed MCP server advertises the sizing tools",
    "Record the served registry hash and the estimate contract version",
  ],
  // Bounded on purpose: this verifies the deployed route and response contract.
  // It is not a corpus-quality benchmark, and must stay cheap enough to be a
  // reliable release gate even when the smoke tenant has a large history.
  lookbackDays: 1,
  limit: 20,
};

/** Deliberately unlikely to match customer content. Supplying it still exercises
 * the prompt-aware predicate and new projection columns while returning at most
 * one model-safe metadata row if it happens to collide. */
const SESSION_SEARCH_PROBE = "codetelemetry-mcp-release-smoke-probe";

type ToolOutcome = {
  tool: string;
  ok: boolean;
  /** Present when the tool refused for an environmental reason (no Linear
   *  workspace connected, say) rather than failing. */
  skipped?: string;
  /** The typed refusal code a route answered with. Its presence means the route is
   *  deployed and authenticated the caller even though no estimate was produced. */
  routeProbed?: string;
  error?: string;
  summary?: Record<string, unknown>;
};

type Report = {
  ok: boolean;
  startedAt: string;
  endpoint: string;
  artifact: string;
  /** The checkout that produced/verified this run. */
  sourceSha: string | null;
  /** What the DEPLOYED server said it is. */
  server: { name: string | null; version: string | null; registryHash: string | null; toolCount: number | null };
  discovery: { toolCount: number; matchesCommittedManifest: boolean; sizingToolsPresent: string[] };
  authenticated: boolean;
  calls: ToolOutcome[];
  problems: string[];
};

// ── Arguments ─────────────────────────────────────────────────────────────────
type Args = {
  /** WHERE the artifact comes from. `tarball` means "these exact bytes" — the release
   *  packs once and every check runs against that one file, so what is published is
   *  what was verified. */
  artifact:
    | { kind: "tarball"; path: string | null }
    | { kind: "source" }
    | { kind: "npx"; spec: string };
  /** HOW its dependencies are provided: a real `npm install` (resolves the declared
   *  ranges fresh from the registry, runs lifecycle scripts — what a customer gets) or
   *  linking this checkout's declared closure (hermetic, and safe in a job that holds
   *  credentials because no third-party install script runs). */
  install: boolean;
  endpoint: string;
  issue: string | null;
  jsonOnly: boolean;
  /** Fail unless the run actually exercised a sizing tool against the endpoint.
   *  Used when the smoke IS a release gate: without it, a missing key silently
   *  degrades the run to "the tools are listed", which proves nothing about the
   *  deployed backend the tools call. */
  requireAuth: boolean;
};

function parseArgs(argv: string[]): Args {
  let artifact: Args["artifact"] = { kind: "tarball", path: null };
  let install = false;
  let endpoint = process.env.CODETELEMETRY_API_BASE || DEFAULT_ENDPOINT;
  let issue = process.env.CODETELEMETRY_SMOKE_ISSUE || null;
  let jsonOnly = false;
  let requireAuth = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `--packaged` is the default (pack this checkout) and stays accepted as a no-op
    // for the many places that spell it out.
    if (arg === "--packaged") artifact = { kind: "tarball", path: null };
    else if (arg === "--tarball") artifact = { kind: "tarball", path: argv[++i] ?? "" };
    else if (arg.startsWith("--tarball=")) artifact = { kind: "tarball", path: arg.slice("--tarball=".length) };
    else if (arg === "--install") install = true;
    else if (arg === "--source") artifact = { kind: "source" };
    else if (arg === "--npx" || arg.startsWith("--npx=")) {
      artifact = { kind: "npx", spec: arg.split("=")[1] || PACKAGE_NAME };
    } else if (arg === "--endpoint") endpoint = argv[++i] ?? endpoint;
    else if (arg.startsWith("--endpoint=")) endpoint = arg.slice("--endpoint=".length);
    else if (arg === "--issue") issue = argv[++i] ?? issue;
    else if (arg.startsWith("--issue=")) issue = arg.slice("--issue=".length);
    else if (arg === "--json") jsonOnly = true;
    else if (arg === "--require-auth") requireAuth = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (!/^https?:\/\//.test(endpoint)) throw new Error(`--endpoint must be an http(s) URL, got "${endpoint}"`);
  if (artifact.kind === "tarball" && artifact.path === "") throw new Error("--tarball needs a path");
  if (install && artifact.kind !== "tarball") throw new Error("--install applies to a packed tarball, not --source/--npx");
  return { artifact, endpoint: endpoint.replace(/\/$/, ""), issue, jsonOnly, requireAuth, install };
}

/** The checkout this run came from. Recorded so a report can be tied back to the
 *  code that produced it; null rather than a guess when git isn't available. */
function sourceSha(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.dirname(MANIFEST_PATH), encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ── The estimate contract ─────────────────────────────────────────────────────
const BASES = new Set(["matched", "corpus-median", "none"]);
const BANDS = new Set(["high", "medium", "low"]);

/**
 * Assert the shared versioned estimate contract, and reduce it to a summary that
 * is safe to print. The summary is built field by field — never spread — so the
 * issue body, the matched sessions' titles and the submitted text cannot ride
 * along into a log.
 */
function checkEstimate(raw: unknown, problems: string[], tool: string): Record<string, unknown> {
  const e = (raw ?? {}) as Record<string, unknown>;
  const bad = (what: string) => problems.push(`${tool}: estimate ${what}`);
  if (typeof e.sizingRequestId !== "string" || !e.sizingRequestId) bad("has no sizingRequestId");
  if (!BASES.has(String(e.basis))) bad(`basis "${String(e.basis)}" is not one of matched|corpus-median|none`);
  const tokens = (e.tokens ?? {}) as Record<string, unknown>;
  for (const k of ["point", "low", "high"] as const) {
    if (typeof tokens[k] !== "number") bad(`tokens.${k} is not a number`);
  }
  const confidence = (e.confidence ?? {}) as Record<string, unknown>;
  if (!BANDS.has(String(confidence.band))) bad(`confidence.band "${String(confidence.band)}" is not high|medium|low`);
  // The sizing MODEL version. Null is legitimate (no calibrated cohort yet), but a
  // present model without a version means the contract lost its versioning.
  const model = (e.model ?? null) as Record<string, unknown> | null;
  if (model !== null && (typeof model.rulesVersion !== "string" || !model.rulesVersion)) {
    bad("model is present but carries no rulesVersion");
  }
  if (e.size !== null && !["XS", "S", "M", "L", "XL"].includes(String(e.size))) {
    bad(`size "${String(e.size)}" is not a t-shirt size`);
  }
  const calibration = (e.calibrationTask ?? null) as Record<string, unknown> | null;
  return {
    size: e.size ?? null,
    basis: e.basis ?? null,
    sampleCount: e.sampleCount ?? null,
    confidenceBand: confidence.band ?? null,
    rulesVersion: model?.rulesVersion ?? null,
    tokens: { point: tokens.point ?? null, low: tokens.low ?? null, high: tokens.high ?? null },
    // Kind only: the calibration task's prose describes the caller's own history.
    calibrationTask: calibration ? (calibration.kind ?? "present") : null,
    sizingRequestIdPresent: typeof e.sizingRequestId === "string" && e.sizingRequestId.length > 0,
  };
}

/** Validate the session-search envelope without copying any session metadata or
 * match content into the release log. */
function checkSessionSearch(raw: unknown, problems: string[]): Record<string, unknown> {
  const report = (raw ?? {}) as Record<string, unknown>;
  const total = report.total;
  const results = report.results;
  if (!Number.isSafeInteger(total) || Number(total) < 0) {
    problems.push("search_sessions: report.total is not a non-negative safe integer");
  }
  if (!Array.isArray(results) || results.length > 1) {
    problems.push("search_sessions: report.results is not an array bounded to one row");
  }
  if (typeof report.promptSearchAvailable !== "boolean") {
    problems.push("search_sessions: report.promptSearchAvailable is not a boolean");
  }
  const query = (report.query ?? {}) as Record<string, unknown>;
  if (query.text !== SESSION_SEARCH_PROBE || query.assistant !== "codex") {
    problems.push("search_sessions: response did not echo the bounded probe query");
  }
  return {
    total: Number.isSafeInteger(total) ? total : null,
    resultCount: Array.isArray(results) ? results.length : null,
    promptSearchAvailable: typeof report.promptSearchAvailable === "boolean"
      ? report.promptSearchAvailable
      : null,
  };
}

/** A well-formed identifier used to PROBE the Linear sizing route when no smoke
 *  issue is configured. It resolves to nothing, which is the point: the route still
 *  has to answer in its own typed vocabulary, which proves it exists, authenticated
 *  the key, and speaks its contract. A missing or incompatible route cannot produce
 *  one of those codes. */
const ISSUE_PROBE_REFERENCE = "SMOKE-0";

/** Refusals that mean "this workspace isn't set up for that yet" rather than "the
 *  deployment is broken". The route was reached, authenticated and answered — which
 *  is what the smoke is proving — so these are recorded as evidence, not failures.
 *  The set is defined (and justified code by code) in harness.ts; a test pins it as
 *  a strict SUBSET of the tool's typed vocabulary, so it can neither drift into
 *  codes the tool doesn't speak nor quietly widen to cover deployment faults. */
const ENVIRONMENTAL = ROUTE_PROVEN_REFUSALS;

// ── Run ───────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const key = process.env.CODETELEMETRY_INGEST_KEY ?? "";
  const committed = readJsonFile(MANIFEST_PATH) as ToolManifest;
  const problems: string[] = [];
  const calls: ToolOutcome[] = [];
  const say = (line: string) => {
    if (!args.jsonOnly) process.stdout.write(`${line}\n`);
  };

  // Whichever artifact we were asked for, resolve it to a command a client would
  // run. `npx` is the literal documented install; `packaged` is this checkout's
  // release candidate; `source` is for iterating locally.
  const work = makeTempDir("ct-mcp-smoke-");
  try {
    let launch: Launch;
    // Run npx outside this package checkout. Otherwise npm sees the local package
    // with the same name, skips installing it, and then cannot find its self-bin.
    if (args.artifact.kind === "npx") launch = npxLaunch(args.artifact.spec, process.platform, work);
    else if (args.artifact.kind === "source") launch = sourceLaunch();
    else {
      // Exact bytes when given, otherwise pack this checkout.
      const tarball = args.artifact.path ? path.resolve(args.artifact.path) : packLocal(work);
      const pkgDir = args.install ? installTarball(tarball, work) : extractTarball(tarball, work);
      if (!args.install) linkNodeModules(pkgDir);
      const version = (JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string })
        .version;
      launch = {
        command: process.execPath,
        args: [resolveBin(pkgDir)],
        label: `${args.artifact.path ? "tarball" : "packaged"} ${PACKAGE_NAME}@${version} (${args.install ? "installed" : "linked"})`,
      };
    }
    const artifactLabel = launch.label;

    say(`▶ artifact  ${artifactLabel}`);
    say(`▶ endpoint  ${args.endpoint}`);
    say(`▶ auth      ${key ? "ingest key from CODETELEMETRY_INGEST_KEY" : "NONE — discovery only"}`);

    const probe: ServerProbe = await probeServer({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      withStatus: true,
      env: {
        CODETELEMETRY_API_BASE: args.endpoint,
        // The server must receive the key the way a real agent gives it — through
        // the get_ingest_key tool — so it is deliberately withheld from the child's
        // environment. That also keeps a credential out of a process the smoke
        // spawns but does not need to hold one.
        CODETELEMETRY_INGEST_KEY: undefined,
      },
      // Long enough for the server's worst-case successful sizing path.
      timeoutMs: 120_000,
      calls: async (call) => {
        if (!key) return;
        const held = await call("get_ingest_key", { key });
        if (held.ok !== true) {
          problems.push(`get_ingest_key refused the supplied key: ${String(held.message ?? held.error)}`);
          return;
        }

        const plan = await call("estimate_plan", SMOKE_PLAN);
        if (plan.ok === true) {
          calls.push({ tool: "estimate_plan", ok: true, summary: checkEstimate(plan.estimate, problems, "estimate_plan") });
        } else {
          problems.push(`estimate_plan failed: ${String(plan.error)} — ${String(plan.message)}`);
          calls.push({ tool: "estimate_plan", ok: false, error: String(plan.error ?? "unknown") });
        }
        const planning = await call("plan_next_session", { taskText: "Validate a bounded authenticated planning release smoke." });
        if (!planning?.ok || !["complete", "partial", "insufficient_history"].includes(String(planning.state)) ||
          !planning.task || !planning.coverage || !Array.isArray(planning.recommendations)) {
          problems.push(`plan_next_session failed or is dark/unwired: ${String(planning?.error)} — ${String(planning?.message)}`);
          calls.push({ tool: "plan_next_session", ok: false, error: String(planning?.error ?? planning?.state ?? "unknown") });
        } else calls.push({ tool: "plan_next_session", ok: true, summary: { state: planning.state } });

        const search = await call("search_sessions", {
          q: SESSION_SEARCH_PROBE,
          assistant: "codex",
          limit: 1,
        });
        if (search.ok === true) {
          calls.push({
            tool: "search_sessions",
            ok: true,
            summary: checkSessionSearch(search.report, problems),
          });
        } else {
          problems.push(`search_sessions failed: ${String(search.error)} — ${String(search.message)}`);
          calls.push({ tool: "search_sessions", ok: false, error: String(search.error ?? "unknown") });
        }

        // Without a configured issue there is nothing to size — but the ROUTE must
        // still be probed when this run is a gate, or a release could ship
        // estimate_linear_issue while /api/agent/linear-issue-size is absent or
        // incompatible.
        if (!args.issue && !args.requireAuth) {
          calls.push({
            tool: "estimate_linear_issue",
            ok: false,
            skipped: "no CODETELEMETRY_SMOKE_ISSUE / --issue given — discovery verified, invocation not attempted",
          });
          return;
        }
        const reference = args.issue ?? ISSUE_PROBE_REFERENCE;
        const issue = await call("estimate_linear_issue", {
          reference,
          lookbackDays: SMOKE_LOOKBACK_DAYS,
          limit: SMOKE_LIMIT,
        });
        if (issue.ok === true) {
          const source = (issue.source ?? {}) as Record<string, unknown>;
          const workspace = (source.workspace ?? {}) as Record<string, unknown>;
          calls.push({
            tool: "estimate_linear_issue",
            ok: true,
            summary: {
              ...checkEstimate(issue.estimate, problems, "estimate_linear_issue"),
              // Identifier + workspace key only. The issue's title, description and
              // normalized text are content the smoke has no business logging.
              issue: { identifier: source.identifier ?? null, workspace: workspace.urlKey ?? null },
            },
          });
        } else if (ENVIRONMENTAL.has(String(issue.error))) {
          // A typed refusal IS a healthy route: it answered in its own vocabulary,
          // having authenticated the key. Recorded as `routeProbed` so the report
          // distinguishes "the workspace isn't set up" from "not attempted".
          calls.push({
            tool: "estimate_linear_issue",
            ok: false,
            routeProbed: String(issue.error),
            skipped: args.issue
              ? `Linear connectivity not available in this workspace: ${String(issue.error)}`
              : `no smoke issue configured; the route answered a typed refusal (${String(issue.error)}), which proves it is deployed`,
          });
        } else {
          problems.push(`estimate_linear_issue failed: ${String(issue.error)} — ${String(issue.message)}`);
          calls.push({ tool: "estimate_linear_issue", ok: false, error: String(issue.error ?? "unknown") });
        }
      },
    });

    // ── Discovery: the inventory a fresh client sees must be the committed one ──
    const drift = diffEntries(normalizeEntries(committed.tools), probe.tools, {
      expected: "committed manifest",
      actual: "deployed server",
    });
    problems.push(...drift);
    const sizingTools = SIZING_TOOLS;
    const discovered = new Set(probe.tools.map((t) => t.name));
    for (const name of sizingTools) {
      if (!discovered.has(name)) problems.push(`the deployed server does not advertise "${name}"`);
    }

    const server = (probe.status?.server ?? {}) as Record<string, unknown>;
    if (probe.serverInfo?.version && server.version && probe.serverInfo.version !== server.version) {
      problems.push(`initialize reported version ${probe.serverInfo.version} but status reported ${String(server.version)}`);
    }

    // When the smoke is a release gate, discovery alone is not a pass: `tools/list`
    // never touches the backend, so a run without a completed request says nothing
    // about whether the deployed routes these tools call actually answer.
    if (args.requireAuth) {
      if (!key) {
        problems.push("--require-auth was given but CODETELEMETRY_INGEST_KEY is unset — the run could not exercise any tool against the endpoint");
      } else {
        // Every backend route exercised by this gate must answer. A typed refusal
        // from the Linear route counts (the route answered); a skip does not.
        for (const tool of ["estimate_plan", "search_sessions", "estimate_linear_issue", "plan_next_session"]) {
          const outcome = calls.find((c) => c.tool === tool);
          if (!outcome) {
            problems.push(`--require-auth was given but ${tool} was never called against the endpoint`);
          } else if (!outcome.ok && !outcome.routeProbed) {
            problems.push(`--require-auth was given but ${tool} did not reach a working route (${outcome.error ?? outcome.skipped ?? "no result"})`);
          }
        }
      }
    }

    const report: Report = {
      ok: problems.length === 0,
      startedAt,
      endpoint: args.endpoint,
      artifact: artifactLabel,
      sourceSha: sourceSha(),
      server: {
        name: probe.serverInfo?.name ?? null,
        version: probe.serverInfo?.version ?? null,
        registryHash: typeof server.registryHash === "string" ? server.registryHash : null,
        toolCount: typeof server.toolCount === "number" ? server.toolCount : null,
      },
      discovery: {
        toolCount: probe.tools.length,
        matchesCommittedManifest: drift.length === 0,
        sizingToolsPresent: sizingTools.filter((n) => discovered.has(n)),
      },
      authenticated: Boolean(key),
      calls,
      problems,
    };

    // Backstop, not the control: every field above is copied in explicitly, but a
    // key-shaped string must never survive to stdout even if that changes.
    const serialized = scrub(JSON.stringify(report, null, 2));
    if (key && serialized.includes(key)) {
      process.stderr.write("✗ the smoke report contained the plaintext ingest key — refusing to print it\n");
      return 1;
    }
    say("");
    process.stdout.write(`${serialized}\n`);
    if (!report.ok) {
      process.stderr.write(`\n✗ MCP release smoke FAILED (${problems.length} problem(s)) — see report.problems\n`);
      return 1;
    }
    say(
      `\n✓ MCP release smoke passed — ${report.discovery.toolCount} tools discovered from ${artifactLabel}` +
        ` (version ${report.server.version ?? "?"}, registryHash ${(report.server.registryHash ?? "?").slice(0, 12)}…)` +
        `${report.authenticated ? "" : "; DISCOVERY ONLY — set CODETELEMETRY_INGEST_KEY to exercise a real request"}`,
    );
    return 0;
  } finally {
    removeDir(work);
  }
}

// A smoke that cannot run is not a smoke that passed: exit 2 on an unexpected
// error so release automation treats it as a hard stop.
process.exitCode = await main().catch((err: unknown) => {
  process.stderr.write(`\n✗ MCP release smoke could not run: ${scrub((err as Error)?.message ?? String(err))}\n`);
  return 2;
});
