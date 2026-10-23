import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {releaseArtifactProblem} from "../scripts/releaseArtifact.ts";
import {audit} from "../scripts/auditPackage.ts";
import {PUBLIC_MODULES} from "../scripts/publicModules.ts";

test("standalone Connect artifact audit rejects extra server files and credential-shaped content", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-connect-audit-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const files = ["LICENSE", "README.md", "package.json", ...PUBLIC_MODULES.filter(name => name.startsWith("src/client/")).flatMap(name => {
    const rel = name.slice("src/client/".length); return [`dist/${rel}.js`, `dist/${rel}.d.ts`];
  })];
  for (const file of files) {const full = path.join(root, file); fs.mkdirSync(path.dirname(full), {recursive: true}); fs.writeFileSync(full, "");}
  assert.deepEqual(audit(root, true), []);
  fs.writeFileSync(path.join(root, "dist/mcpServer.js"), "export {};");
  assert.ok(audit(root, true).some(problem => problem.includes("unexpected file: dist/mcpServer.js")));
  fs.rmSync(path.join(root, "dist/mcpServer.js"));
  fs.writeFileSync(path.join(root, "README.md"), "npm_" + "synthetic".repeat(4));
  assert.ok(audit(root, true).some(problem => problem.includes("npm token")));
});

test("Connect release rejects duplicate/downgrade and requires exact latest artifact", () => {
  const state = {"dist-tags": {latest: "0.1.1"}, versions: {"0.1.1": {}}};
  assert.equal(releaseArtifactProblem(state, "0.1.2", "sha512-good", false), null);
  assert.match(releaseArtifactProblem(state, "0.1.1", "sha512-good", false)!, /already published/);
  assert.match(releaseArtifactProblem(state, "0.1.0", "sha512-good", false)!, /DOWNGRADE/);
  assert.equal(releaseArtifactProblem(null, "0.1.2", "sha512-good", false), null);
  const published = {"dist-tags": {latest: "0.1.2"}, versions: {"0.1.2": {dist: {integrity: "sha512-good"}}}};
  assert.equal(releaseArtifactProblem(published, "0.1.2", "sha512-good", true), null);
  assert.match(releaseArtifactProblem(published, "0.1.2", "sha512-other", true)!, /integrity/);
  assert.match(releaseArtifactProblem(state, "0.1.2", "sha512-good", true)!, /latest/);
  assert.match(releaseArtifactProblem({"dist-tags": {latest: "0.1.2"}}, "0.1.2", "sha512-good", true)!, /integrity/);
});

test("release retains both audited candidates and gates Connect before MCP", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /github.repository == 'CodeTelemetry\/codetelemetry-mcp'.*github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: npm-production/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /sha256sum "\$TARBALL" "\$CONNECT" > SHA256SUMS/);
  assert.equal((workflow.match(/sha256sum --check SHA256SUMS/g) ?? []).length, 3);
  assert.match(workflow, /audit:package -- --connect/);
  assert.match(workflow, /CODETELEMETRY_CONNECT_TEST_TARBALL=/);
  assert.ok(workflow.indexOf("Publish standalone Connect before MCP") < workflow.indexOf("Publish the verified artifact"));
  assert.match(workflow, /releaseArtifact.ts.*--published/);
  assert.match(workflow, /npx --yes @codetelemetry\/connect --help/);
  assert.match(workflow, /npm_config_cache:.*connect-customer-npm-cache/);
});
