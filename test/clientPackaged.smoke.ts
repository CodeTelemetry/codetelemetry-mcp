import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {extractTarball, packLocal, runNpm, sanitizeEnvForSubprocess} from "../scripts/harness.ts";
import {PUBLIC_MODULES} from "../scripts/publicModules.ts";

test("installed Connect and Kiro service use only the public client artifact", {timeout: 120_000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-client-package-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tarball = process.env.CODETELEMETRY_TEST_TARBALL ?? packLocal(root);
  const unpack = path.join(root, "unpack"); fs.mkdirSync(unpack);
  const pkg = extractTarball(tarball, unpack);
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
  const wrapper = fileURLToPath(new URL("../packages/connect", import.meta.url));
  const wrapperMeta = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(wrapperMeta.dependencies, undefined, "Connect must not pull in the MCP SDK");
  const suppliedConnect = process.env.CODETELEMETRY_CONNECT_TEST_TARBALL;
  const packed = suppliedConnect ? JSON.parse(runNpm(["pack", suppliedConnect, "--dry-run", "--json", "--ignore-scripts"], root))[0] : JSON.parse(runNpm(["pack", "--json", "--pack-destination", root], wrapper))[0];
  const connectTarball = suppliedConnect ?? path.join(root, packed.filename);
  const clientFiles = PUBLIC_MODULES.filter(name => name.startsWith("src/client/")).flatMap(name => {
    const relative = name.slice("src/client/".length); return [`dist/${relative}.js`, `dist/${relative}.d.ts`];
  });
  assert.deepEqual(packed.files.map((entry: {path: string}) => entry.path).sort(),
    ["LICENSE", "README.md", "package.json", ...clientFiles].sort());
  const connectUnpack = path.join(root, "connect-unpack"); fs.mkdirSync(connectUnpack);
  const connectPackage = extractTarball(connectTarball, connectUnpack);
  for (const file of clientFiles) assert.deepEqual(fs.readFileSync(path.join(connectPackage, file)),
    fs.readFileSync(path.join(pkg, file.replace("dist/", "dist/src/client/"))), `${file} is built from the same public source`);
  const customer = path.join(root, "customer"); fs.mkdirSync(customer);
  runNpm(["install", "--ignore-scripts", "--no-package-lock", connectTarball], customer);
  assert.equal(fs.existsSync(path.join(customer, "node_modules/@modelcontextprotocol")), false);
  const cli = path.join(customer, "node_modules/@codetelemetry/connect/dist/bin.js");
  const config = execFileSync(process.execPath, [cli, "print-config"], {encoding: "utf8", timeout: 10_000});
  assert.match(config, /OTEL_EXPORTER_OTLP/);
  assert.match(execFileSync(process.execPath, [cli, "--help"], {encoding: "utf8", timeout: 10_000}), /kiro status/);
  runNpm(["install", "--ignore-scripts", "--no-package-lock", tarball], customer);
  // Adding the Connect bin must not make npm unable to infer the MCP entry point.
  const env = Object.fromEntries(Object.entries(sanitizeEnvForSubprocess()).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const client = new Client({name: "installed-client-boundary", version: "1.0.0"});
  try {
    await client.connect(new StdioClientTransport({command: "npx", args: ["--offline", "--no-install", "@codetelemetry/mcp"], cwd: customer,
      env: {...env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, ".codex")}, stderr: "pipe"}));
    const result = await client.listTools();
    assert.ok(result.tools.some(tool => tool.name === "import_history"));
    assert.ok(result.tools.some(tool => tool.name === "onboard"));
    for (const name of ["seed_grader_config", "get_grader_config", "update_grader_config"]) assert.ok(result.tools.some(tool => tool.name === name), `installed MCP advertises ${name}`);
  } finally { await client.close(); }
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
