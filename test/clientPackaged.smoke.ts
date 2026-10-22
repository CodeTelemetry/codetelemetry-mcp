import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {extractTarball, packLocal, runNpm} from "../scripts/harness.ts";

test("installed Connect and Kiro service use only the public client artifact", {timeout: 120_000}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-client-package-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tarball = process.env.CODETELEMETRY_TEST_TARBALL ?? packLocal(root);
  const unpack = path.join(root, "unpack"); fs.mkdirSync(unpack);
  const pkg = extractTarball(tarball, unpack);
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
  const wrapper = fileURLToPath(new URL("../packages/connect", import.meta.url));
  const wrapperMeta = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(wrapperMeta.dependencies["@codetelemetry/mcp"], metadata.version);
  const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], wrapper))[0];
  assert.deepEqual(packed.files.map((entry: {path: string}) => entry.path).sort(),
    ["LICENSE", "README.md", "bin/connect.mjs", "index.d.ts", "index.mjs", "package.json"]);
  const customer = path.join(root, "customer"); fs.mkdirSync(customer);
  runNpm(["install", "--ignore-scripts", "--no-package-lock", tarball, path.join(root, packed.filename)], customer);
  const cli = path.join(customer, "node_modules/@codetelemetry/connect/bin/connect.mjs");
  const config = execFileSync(process.execPath, [cli, "print-config"], {encoding: "utf8", timeout: 10_000});
  assert.match(config, /OTEL_EXPORTER_OTLP/);
  assert.match(execFileSync(process.execPath, [cli, "--help"], {encoding: "utf8", timeout: 10_000}), /kiro status/);
  // The stable runtime must survive npm cache eviction and must not copy MCP or backend modules.
  const smoke = path.join(customer, "service.mjs");
  fs.writeFileSync(smoke, `
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeKiroConfig} from '@codetelemetry/mcp/client/kiro/config';
import {enableKiroService, uninstallKiroService} from '@codetelemetry/mcp/client/kiro/service';
const home = process.argv[2], config = path.join(home, 'kiro.json');
writeKiroConfig({configPath:config, key:'cot_'+ 'synthetic'.repeat(4), ingestEndpoint:'https://example.invalid'});
const options={home, platform:'linux', execute:()=>''};
assert.equal((await enableKiroService(config,options)).ok,true);
const unit=fs.readFileSync(path.join(home,'.config/systemd/user/codetelemetry-kiro-v3.service'),'utf8');
const entry=/^ExecStart="[^"]+" "([^"]+)"/m.exec(unit)[1];
assert.ok(entry.endsWith('/bin.js'));
const files=fs.readdirSync(path.dirname(entry),{recursive:true});
assert.equal(files.some(file=>/mcpServer|dispatchAdmission|onboardingServer|deviceProtocol/.test(file)),false);
assert.match(execFileSync(process.execPath,[entry,'kiro','status','--settings',config],{encoding:'utf8',timeout:10000}),/running/);
assert.equal(uninstallKiroService(config,options).ok,true);
assert.equal(fs.existsSync(config),true);
`);
  const home = path.join(root, "owned-home"); fs.mkdirSync(home);
  execFileSync(process.execPath, [smoke, home], {cwd: customer, encoding: "utf8", timeout: 30_000});
});
