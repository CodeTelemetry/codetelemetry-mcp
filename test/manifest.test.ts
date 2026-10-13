// The registry-identity invariants. Dependency-free, so they run in the
// same `npm test` pass as the tool tests.
//
// What this protects: a tool can be added to src/tools.ts and shipped "Done"
// while the artifact customers install serves a different inventory. The
// committed manifest is the pin that makes that divergence a failing test rather
// than a support ticket.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, callTool, type ToolContext } from "../src/tools.ts";
import {
  canonicalJson,
  diffEntries,
  manifestEntries,
  normalizeEntries,
  registryHash,
  registryIdentity,
  toolManifest,
  type ToolManifest,
  type ToolManifestEntry,
} from "../src/manifest.ts";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../src/version.ts";
import { OnboardingSession } from "../src/session.ts";
import { compareVersions, fetchPackument, publishOrderProblem, publishedProblems, readPackument } from "../scripts/published.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(PKG_ROOT, rel), "utf8")) as Record<string, unknown>;

const entry = (over: Partial<ToolManifestEntry> = {}): ToolManifestEntry => ({
  name: "a_tool",
  title: "A tool",
  description: "does a thing",
  inputSchema: { type: "object", properties: {} },
  ...over,
});

test("canonicalJson is order-independent for keys and order-preserving for arrays", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  // Matches JSON.stringify: an undefined property is absent, not null.
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test("registryHash changes when any wire-visible field changes", () => {
  const base = [entry()];
  const same = [entry({ inputSchema: { properties: {}, type: "object" } })]; // key order only
  assert.equal(registryHash(base), registryHash(same), "key order must not change the hash");

  for (const mutation of [
    entry({ name: "a_tool_2" }),
    entry({ title: "Another tool" }),
    entry({ description: "does another thing" }),
    entry({ inputSchema: { type: "object", properties: { x: { type: "string" } } } }),
  ]) {
    assert.notEqual(registryHash(base), registryHash([mutation]), `hash must react to ${JSON.stringify(mutation.name)}`);
  }
  // Adding a tool — the case — must change the hash.
  assert.notEqual(registryHash(base), registryHash([entry(), entry({ name: "b_tool" })]));
});

test("diffEntries names every kind of drift", () => {
  const a = [entry({ name: "one" }), entry({ name: "two" })];
  assert.deepEqual(diffEntries(a, a), []);
  assert.match(diffEntries(a, [a[0]!])[0]!, /"two".*MISSING/);
  assert.match(diffEntries([a[0]!], a)[0]!, /"two".*not in the expected/);
  assert.match(diffEntries(a, [a[0]!, entry({ name: "two", description: "x" })])[0]!, /"two": description differs/);
  assert.match(diffEntries(a, [a[0]!, entry({ name: "two", inputSchema: { type: "object", properties: { q: {} } } })])[0]!, /inputSchema differs/);
  assert.match(diffEntries(a, [a[1]!, a[0]!])[0]!, /ORDER differs/);
});

test("the committed tool-manifest.json IS the source registry", () => {
  const committed = readJson("tool-manifest.json") as unknown as ToolManifest;
  const live = toolManifest(TOOLS);
  assert.deepEqual(
    diffEntries(live.tools, normalizeEntries(committed.tools), { expected: "source", actual: "committed" }),
    [],
    "run `npm run manifest:write` and commit the result",
  );
  assert.equal(committed.registryHash, live.registryHash);
  assert.equal(committed.toolCount, live.toolCount);
  assert.equal(committed.serverName, MCP_SERVER_NAME);
  assert.equal(committed.serverVersion, MCP_SERVER_VERSION);
});

test("the version a client sees on initialize is the version that was released", () => {
  // Three places claim a version; a client only ever sees the middle one, so a
  // mismatch means the build cannot be identified from a client at all.
  assert.equal(readJson("package.json").version, MCP_SERVER_VERSION);
  assert.equal((readJson("tool-manifest.json") as unknown as ToolManifest).serverVersion, MCP_SERVER_VERSION);
});

test("the published artifact is built JavaScript, not TypeScript source", () => {
  // Node refuses to strip types inside node_modules, so a `bin` pointing at .ts
  // cannot run for anyone who INSTALLED the package — the failure mode that made
  // the sizing tools undiscoverable in production.
  const pkg = readJson("package.json") as { bin?: Record<string, string>; files?: string[] };
  const bin = pkg.bin?.["codetelemetry-mcp"];
  assert.ok(bin, "package.json must declare the codetelemetry-mcp bin");
  assert.ok(bin!.endsWith(".js"), `bin must point at built JavaScript, got ${bin}`);
  assert.ok(bin!.startsWith("./dist/"), `bin must point into dist/, got ${bin}`);
  assert.ok(pkg.files?.includes("dist"), "`files` must ship dist/");
  assert.ok(pkg.files?.includes("tool-manifest.json"), "`files` must ship the inventory record");
  // A `file:` dependency resolves on a developer's machine and nowhere else, so a
  // published package must not declare one.
  const deps = (readJson("package.json").dependencies ?? {}) as Record<string, string>;
  for (const [name, spec] of Object.entries(deps)) {
    assert.ok(!spec.startsWith("file:"), `dependency ${name} is a local link (${spec}) — it cannot resolve for a customer`);
  }
});

test("the sizing and session tools are in the inventory, with their contracts", () => {
  const byName = new Map(manifestEntries(TOOLS).map((t) => [t.name, t]));
  for (const name of [
    "estimate_task_size",
    "estimate_plan",
    "estimate_linear_issue",
    "read_session_events",
    "interpret_session",
    "compare_sessions",
    "plan_next_session",
  ]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be advertised`);
    assert.equal((tool!.inputSchema as { type?: string }).type, "object");
    assert.ok(tool!.description.length > 40, `${name} needs a description a model can act on`);
  }
  // The one required argument of estimate_linear_issue, and the two ways a plan
  // may be submitted: a client that discovers the tool must also be able to call it.
  assert.deepEqual((byName.get("estimate_linear_issue")!.inputSchema as { required?: string[] }).required, ["reference"]);
  const planProps = (byName.get("estimate_plan")!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok(planProps.planText && planProps.steps);
  const interpret = byName.get("interpret_session")!;
  assert.deepEqual((interpret.inputSchema as { required?: string[] }).required, ["sessionId"]);
  const interpretProps = (interpret.inputSchema as { properties: Record<string, any> }).properties;
  assert.equal(interpretProps.evidenceIds.maxItems, 8, "evidence selection must remain bounded");
  const compare = byName.get("compare_sessions")!;
  assert.deepEqual((compare.inputSchema as { required?: string[] }).required, ["sessions"]);
  const compareSessions = ((compare.inputSchema as { properties: Record<string, any> }).properties.sessions);
  assert.equal(compareSessions.minItems, 2); assert.equal(compareSessions.maxItems, 10);
});

test("what npm OFFERS is judged, not just the version we asked about", () => {
  // `npx -y @codetelemetry/mcp` — the documented, unpinned install — resolves the
  // `latest` dist-tag. The release verifies an explicit version, so without this
  // rule a tarball could check out perfectly while customers resolved a different
  // inventory entirely.
  const packument = {
    "dist-tags": { latest: "0.3.0" },
    versions: { "0.1.0": {}, "0.2.0": {}, "0.3.0": {} },
  };

  // The reported case: the requested version exists, but the tag is ahead of it.
  const requested = readPackument(packument, "0.2.0");
  assert.deepEqual(requested, { kind: "ok", version: "0.2.0", latest: "0.3.0" });
  const problems = publishedProblems({ version: "0.2.0", latest: "0.3.0" }, "0.2.0");
  assert.equal(problems.length, 1, `expected exactly the tag problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0]!, /`latest` tag is 0\.3\.0, not 0\.2\.0/);

  // Agreement is silence.
  assert.deepEqual(publishedProblems({ version: "0.3.0", latest: "0.3.0" }, "0.3.0"), []);

  // A published version behind source, and a source behind npm, still report.
  assert.match(publishedProblems({ version: "0.1.0", latest: "0.1.0" }, "0.2.0")[0]!, /BEHIND source/);
  assert.match(publishedProblems({ version: "0.3.0", latest: "0.3.0" }, "0.2.0")[0]!, /AHEAD of this checkout/);
  // No tag at all: the unpinned install cannot resolve.
  assert.match(publishedProblems({ version: "0.2.0", latest: null }, "0.2.0")[0]!, /no `latest` dist-tag/);

  // Resolution rules.
  assert.deepEqual(readPackument(packument, "latest"), { kind: "ok", version: "0.3.0", latest: "0.3.0" });
  assert.deepEqual(readPackument(packument, "9.9.9"), { kind: "missing_version", requested: "9.9.9" });
  assert.deepEqual(readPackument({ versions: {} }, "latest"), { kind: "not_published" });
  // An inherited property must not read as a published version.
  assert.deepEqual(readPackument(packument, "toString"), { kind: "missing_version", requested: "toString" });

  assert.equal(compareVersions("0.2.0", "0.10.0") < 0, true, "semver-core, not lexicographic");
});

test("the registry lookup requests the same abbreviated metadata npm install uses", async () => {
  let accept = "";
  const result = await fetchPackument("https://registry.example/package", async (_input, init) => {
    accept = String((init?.headers as Record<string, string> | undefined)?.accept ?? "");
    return new Response(JSON.stringify({ "dist-tags": { latest: "0.3.0" }, versions: { "0.3.0": {} } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(accept, "application/vnd.npm.install-v1+json");
  assert.deepEqual(readPackument(result!, "0.3.0"), { kind: "ok", version: "0.3.0", latest: "0.3.0" });
});

test("a downgrade is refused BEFORE it is published", () => {
  // The published-parity check would notice that a lower version never became
  // `latest` — but only after `npm publish` made it permanent and installable by
  // anyone who pins it. `verify:publish-order` runs ahead of the publish step and is
  // the reason a lower candidate never gets there.
  const problem = publishOrderProblem("0.3.0", "0.2.1");
  assert.ok(problem, "publishing 0.2.1 while latest is 0.3.0 must be refused");
  assert.match(problem!, /DOWNGRADE/);
  assert.match(problem!, /Bump past 0\.3\.0/);

  // Forward releases, and the very first one, are fine.
  assert.equal(publishOrderProblem("0.2.0", "0.2.1"), null);
  assert.equal(publishOrderProblem("0.9.9", "1.0.0"), null);
  assert.equal(publishOrderProblem(null, "0.2.0"), null, "the first release has nothing to be behind");
  // Same core version is not a downgrade — "already published" is a different check.
  assert.equal(publishOrderProblem("0.2.0", "0.2.0"), null);
  // Numeric, not lexicographic: 0.10.0 really is ahead of 0.9.0.
  assert.ok(publishOrderProblem("0.10.0", "0.9.0"));

  // Prereleases rank BELOW the release that shares their core (semver §11), so
  // publishing 1.0.0-beta.1 once 1.0.0 exists is a downgrade — an earlier
  // core-only comparison called those two equal and let it through.
  assert.ok(publishOrderProblem("1.0.0", "1.0.0-beta.1"), "a prerelease under a release is a downgrade");
  assert.ok(publishOrderProblem("1.0.0-beta.2", "1.0.0-beta.1"), "and so is an earlier prerelease");
  assert.ok(
    publishOrderProblem("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"),
    "a prerelease one below npm's, past 2^53, is still a downgrade",
  );
  assert.equal(publishOrderProblem("1.0.0-beta.1", "1.0.0"), null, "the release itself is forward");
  assert.equal(publishOrderProblem("1.0.0-beta.1", "1.0.0-beta.2"), null);
});

test("version precedence follows semver, prereleases included", () => {
  const lower = (a: string, b: string) => {
    assert.equal(compareVersions(a, b), -1, `${a} must rank below ${b}`);
    assert.equal(compareVersions(b, a), 1, `${b} must rank above ${a}`);
  };
  lower("0.9.0", "0.10.0"); // numeric, not lexicographic
  lower("1.0.0-beta.1", "1.0.0"); // a prerelease is below its release
  lower("1.0.0-beta.1", "1.0.0-beta.2"); // numeric identifiers compare numerically
  lower("1.0.0-beta.9", "1.0.0-beta.10");
  // Numeric identifiers have no ceiling in semver, and Number() rounds past 2^53:
  // these two differ by one and must not compare equal.
  lower("1.0.0-beta.9007199254740992", "1.0.0-beta.9007199254740993");
  lower("1.0.0-beta.99999999999999999999", "1.0.0-beta.100000000000000000000");
  lower("1.0.0-alpha", "1.0.0-alpha.1"); // more identifiers, all else equal, is higher
  lower("1.0.0-alpha.1", "1.0.0-alpha.beta"); // numeric ranks below alphanumeric
  lower("1.0.0-alpha.beta", "1.0.0-beta"); // ASCII order
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1"), 0);
  // Build metadata is excluded from precedence.
  assert.equal(compareVersions("1.0.0+exp.sha.5114f85", "1.0.0+exp.sha.999"), 0);
  assert.equal(compareVersions("1.0.0-rc.1+build.1", "1.0.0-rc.1+build.2"), 0);
});

test("status reports the running build and inventory, without a key", async () => {
  const ctx: ToolContext = { session: new OnboardingSession() };
  ctx.configPathsOverride = { claude: path.join(PKG_ROOT, "does-not-exist.json") };
  const status = await callTool("status", {}, ctx);
  assert.equal(status.ok, true);
  assert.deepEqual(status.server, registryIdentity(TOOLS));
  const server = status.server as { name: string; version: string; registryHash: string; toolCount: number };
  assert.equal(server.version, MCP_SERVER_VERSION);
  assert.equal(server.toolCount, TOOLS.length);
  assert.equal(server.registryHash, (readJson("tool-manifest.json") as unknown as ToolManifest).registryHash);
});
