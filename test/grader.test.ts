import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedGraderConfig } from "../src/client/graderSeed.ts";
import { callTool, type ToolContext } from "../src/tools.ts";
import { OnboardingSession } from "../src/session.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-grader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, write(file: string, text: string) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); } };
}

test("seed discovers instructions, scoped skills, nested scripts, targets and language conventions without executing files", (t) => {
  const f = fixture(t);
  f.write("AGENTS.md", "Run unit tests and lint. Follow the security-review skill.");
  f.write("packages/service/agents.md", "Service-specific instruction.");
  f.write(".claude/skills/security-review/SKILL.md", "Check for unsafe queries.");
  f.write(".agents/skills/review/SKILL.md", "Review changes.");
  f.write(".codex/skills/test/SKILL.md", "Test changes.");
  f.write("package.json", JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: {
    test: "node tests.js", lint: "eslint .", build: "tsc", deploy: "touch SHOULD_NOT_EXIST",
    "test:watch": "vitest --watch", "lint:fix": "eslint --fix .", format: "prettier --write .", "format:check": "prettier --check .",
  } }));
  f.write("packages/service/package.json", '{"scripts":{"test":"vitest run"}}');
  f.write("Makefile", "test lint: setup\n\t$(shell touch SHOULD_NOT_EXIST)\n.PHONY: test lint\nrelease: test\n");
  f.write("justfile", "check:\n    echo check\n");
  f.write("py/pyproject.toml", '[project]\ndependencies = ["pytest>=8"]\n[tool.ruff.lint]\n');
  f.write("rust/Cargo.toml", '[package]\nname = "example"');
  f.write("go/go.mod", "module example.com/example\n");
  f.write("java/pom.xml", "<project/>");
  f.write("gradle/build.gradle.kts", "plugins {}");
  f.write("gradle/gradlew", "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n");
  f.write("php/composer.json", '{"scripts":{"test":"phpunit"}}');
  f.write("dotnet/App.csproj", "<Project/>");
  f.write("ruby/Rakefile", "task :test do\nend\n");
  f.write("elixir/mix.exs", "defmodule Example.MixProject do\nend");
  f.write("swift/Package.swift", "import PackageDescription");
  f.write("c/CMakeLists.txt", "enable_testing()");
  f.write("node_modules/hidden/AGENTS.md", "hidden instruction");
  f.write(".git/AGENTS.md", "hidden git instruction");
  f.write(".claude/settings.json", '{"secrets":"never read"}');
  const result = seedGraderConfig({ root: f.root, features: "Tests and lint", repositoryId: "example/repo" });
  assert.equal(result.features, "Tests and lint");
  assert.equal(result.sources.length, 5);
  const commands = [...result.candidates, ...["swift", "rust", "c", "elixir", "dotnet", "java", "gradle", "php", "ruby", "py", "go"].flatMap((directory) => seedGraderConfig({ root: path.join(f.root, directory), features: "Tests and lint" }).candidates)].map((c) => c.command);
  for (const command of ["pnpm run test", "pnpm run lint", "pnpm run format:check", "npm run test", "make test", "make lint", "just check", "python -m pytest", "ruff check .", "go test ./...", "cargo test", "mvn test", "./gradlew test", "composer run test", "dotnet test App.csproj", "rake test", "mix test", "swift test", "ctest --test-dir build"]) assert.ok(commands.includes(command), `Missing ${command}`);
  assert.ok(!commands.some((command) => /deploy|release|watch|fix|run format$/.test(command)));
  assert.ok(result.candidates.every((candidate) => candidate.check.repositoryId === "example/repo"));
  const go = result.candidates.find((c) => c.command === "go test ./...")!;
  assert.equal(go.inferred, true);
  assert.deepEqual((go.check.matcherRule.include as any).all[0].all.slice(-2), [
    { field: "operation", operator: "equals", value: "test" },
    { field: "normalizedArguments", operator: "contains", value: ["<path>"] },
  ]);
  assert.equal(fs.existsSync(path.join(f.root, "SHOULD_NOT_EXIST")), false);
  assert.ok(result.candidates.length > 10);
});

test("seed bounds malformed/oversized sources, skips links and never scans global skills implicitly", (t) => {
  const f = fixture(t);
  f.write("AGENTS.md", "A".repeat(10_000));
  f.write("package.json", "bad json");
  f.write("large/Makefile", "x".repeat(70_000));
  f.write("external/SKILL.md", "External skill contents");
  fs.symlinkSync(path.join(f.root, "external"), path.join(f.root, "linked"), "dir");
  fs.symlinkSync(path.join(f.root, "external/SKILL.md"), path.join(f.root, "external/AGENTS.md"));
  const result = seedGraderConfig({ root: f.root, features: "Review" });
  assert.equal(result.truncated, true);
  assert.equal(result.sources[0]?.text.length, 3000);
  assert.ok(result.warnings.some((w) => w.includes("Invalid JSON")));
  assert.ok(result.warnings.some((w) => w.includes("oversized")));
  assert.ok(result.sources.every((s) => !s.path.startsWith("linked/")));
  assert.throws(() => seedGraderConfig({ root: f.root, features: "Review", skillPaths: ["linked/SKILL.md"] }), /symbolic links/);
  assert.throws(() => seedGraderConfig({ root: f.root, features: "Review", skillPaths: ["package.json"] }), /SKILL.md/);
});

test("seed candidate ids are stable, external skills explicit, and candidate limits report truncation", (t) => {
  const f = fixture(t);
  const external = fixture(t);
  f.write("package.json", JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`test:${i}`, "node test.js"])) }));
  external.write("SKILL.md", "Selected user skill");
  const a = seedGraderConfig({ root: f.root, features: "Tests" });
  const b = seedGraderConfig({ root: f.root, features: "Tests", skillPaths: [path.join(external.root, "SKILL.md")] });
  assert.ok(a.candidates.length > 0 && a.candidates.length <= 30);
  assert.equal(a.truncated, true);
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources[0]?.text, "Selected user skill");
  assert.deepEqual(a.candidates.slice(0, b.candidates.length).map((c) => c.check.id), b.candidates.map((c) => c.check.id));
});

test("Grader tools read/write only selected checks and retain typed failures and secrets", async (t) => {
  const f = fixture(t);
  f.write("package.json", '{"scripts":{"test":"node --test"}}');
  const session = new OnboardingSession();
  let requests: Array<{ url: string; auth: string | null; body: any }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, config: { revision: "a".repeat(64), draft: { checks: [] } } } };
  const ctx: ToolContext = { session, endpointsOverride: { apiBase: "https://example.test" }, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  } };
  const seed = await callTool("seed_grader_config", { repositoryPath: f.root, features: "Tests" }, ctx);
  assert.equal(seed.ok, true, "local seeding needs no key");
  assert.equal(requests.length, 0);
  assert.equal((await callTool("get_grader_config", {}, ctx)).error, "no_key");
  const key = "cot_" + "graderconfigtest00000000000001";
  session.setKey(key, "pasted");
  const read = await callTool("get_grader_config", { offset: 2, limit: 3 }, ctx);
  assert.equal(read.ok, true);
  assert.equal(requests[0]!.url, "https://example.test/api/agent/grader");
  assert.equal(requests[0]!.auth, `Bearer ${key}`);
  assert.deepEqual(requests[0]!.body, { offset: 2, limit: 3 });
  assert.equal(read.settingsUrl, "https://example.test/app/validation");
  const change = { expectedRevision: "a".repeat(64), features: "Only unit tests", upsertChecks: [(seed.seed as any).candidates[0].check] };
  const saved = await callTool("update_grader_config", change, ctx);
  assert.equal(saved.ok, true);
  assert.equal(requests[1]!.url, "https://example.test/api/agent/grader/configure");
  assert.deepEqual(requests[1]!.body, change);
  assert.ok(!JSON.stringify(saved).includes(key));
  for (const [status, body, expected] of [
    [409, { error: "conflict", message: "changed draft" }, "conflict"],
    [401, {}, "unauthenticated"], [429, {}, "rate_limited"], [404, {}, "not_supported"],
    [503, { error: "not_configured" }, "not_configured"], [200, {}, "grader_failed"],
  ] as const) {
    reply = { status, body };
    assert.equal((await callTool("update_grader_config", change, ctx)).error, expected);
  }
  const count = requests.length;
  for (const [name, args] of [
    ["seed_grader_config", { features: "" }], ["seed_grader_config", { features: "Tests", skillPaths: [5] }],
    ["get_grader_config", { tenantId: "other" }], ["get_grader_config", { offset: -1 }], ["get_grader_config", { limit: 20 }],
    ["update_grader_config", { ...change, expectedRevision: "bad" }],
    ["update_grader_config", { ...change, upsertChecks: [] }],
    ["update_grader_config", { ...change, upsertChecks: [null] }],
    ["update_grader_config", { ...change, upsertChecks: [{}] }],
    ["update_grader_config", { ...change, upsertChecks: [change.upsertChecks[0], change.upsertChecks[0]] }],
    ["update_grader_config", { ...change, upsertChecks: [{ ...change.upsertChecks[0], weight: -1 }] }],
    ["update_grader_config", { ...change, upsertChecks: [{ ...change.upsertChecks[0], matcherRule: { include: { field: "unknown", operator: "equals", value: "test" } } }] }],
    ["update_grader_config", { ...change, publish: true }],
    ["update_grader_config", { ...change, removeCheckIds: [3] }],
  ] as const) assert.equal((await callTool(name, args, ctx)).error, "bad_input");
  assert.equal(requests.length, count, "invalid requests never reach the backend");
  ctx.fetchImpl = async () => new Response("x".repeat(70 * 1024), { status: 200 });
  assert.equal((await callTool("update_grader_config", change, ctx)).error, "save_uncertain", "oversized responses require readback");
  let attempts = 0;
  ctx.fetchImpl = async () => { attempts++; throw new Error("connection lost"); };
  const uncertain = await callTool("update_grader_config", change, ctx);
  assert.equal(uncertain.error, "save_uncertain");
  assert.match(String(uncertain.message), /Read the current draft before retrying/);
  assert.equal(attempts, 1, "uncertain writes are never retried automatically");
});
