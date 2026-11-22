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

test("installed Connect and its Kiro and Cursor collectors use only the public client artifact", {timeout: 120_000}, async t => {
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
  // Every Connect command looks for the Cursor collector's settings under the
  // home directory, so the installed CLI runs with a throwaway one.
  const cliEnv = {...process.env, HOME: root, USERPROFILE: root};
  const config = execFileSync(process.execPath, [cli, "print-config"], {encoding: "utf8", timeout: 10_000, env: cliEnv});
  assert.match(config, /OTEL_EXPORTER_OTLP/);
  const help = execFileSync(process.execPath, [cli, "--help"], {encoding: "utf8", timeout: 10_000, env: cliEnv});
  assert.match(help, /kiro status/);
  assert.match(help, /cursor status/);
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
assert.match(execFileSync(process.execPath,[entry,'kiro','status','--settings',config],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home,USERPROFILE:home}}),/running/);
assert.equal(uninstallKiroService(config,options).ok,true);
assert.equal(fs.existsSync(config),true);
`);
  const home = path.join(root, "owned-home"); fs.mkdirSync(home);
  execFileSync(process.execPath, [smoke, home], {cwd: customer, encoding: "utf8", timeout: 30_000});
  // The Cursor collector installs, runs its hook and status from the packaged
  // runtime, and is removed again, all inside a throwaway home with a service
  // manager that only records. No request leaves the process.
  const cursorSmoke = path.join(customer, "cursor.mjs");
  fs.writeFileSync(cursorSmoke, `
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cursorPreflight} from '@codetelemetry/mcp/client/cursor/preflight';
import {installCursor, uninstallCursor} from '@codetelemetry/mcp/client/cursor/command';
const home = process.argv[2], calls = [];
process.env.HOME = process.env.USERPROFILE = home;
const host = {home, platform:'linux', env:{}, execute:(command,args)=>{calls.push([command,...args].join(' '));return '';}};
const accepted = async () => new Response('{}', {status:200, headers:{'x-codetelemetry-source-format':'cursor-hooks-source-v1'}});
const installed = await installCursor(cursorPreflight({host}), {key:'cot_'+'synthetic'.repeat(4), ingestEndpoint:'https://example.invalid', fetchImpl:accepted});
assert.equal(installed.hooks,'installed'); assert.equal(installed.service,'started');
const share = path.join(home,'.local/share/codetelemetry/cursor-hooks-v1'), state = path.join(home,'.local/state/codetelemetry/cursor-hooks-v1');
const unit = fs.readFileSync(path.join(home,'.config/systemd/user/codetelemetry-cursor-hooks.service'),'utf8');
assert.ok(unit.includes('ExecStart="/bin/sh" "'+path.join(share,'collector.sh')+'"'));
const entry = /^ *"\\$N" '([^']+)' cursor collect/m.exec(fs.readFileSync(path.join(share,'collector.sh'),'utf8'))[1];
assert.ok(entry.startsWith(share+'/runtime-') && entry.endsWith('/bin.js'));
const files = fs.readdirSync(path.dirname(entry),{recursive:true});
assert.equal(files.some(file=>/mcpServer|dispatchAdmission|onboardingServer|deviceProtocol/.test(file)),false);
const env = {PATH:process.env.PATH, HOME:home, USERPROFILE:home, XDG_CONFIG_HOME:path.join(home,'.config'), XDG_DATA_HOME:path.join(home,'.local/share'), XDG_STATE_HOME:path.join(home,'.local/state')};
const event = JSON.stringify({hook_event_name:'stop', conversation_id:'6f0d7c1a-3b2e-4a5d-8c9f-1e2d3c4b5a69', generation_id:'turn-1', status:'completed', input_tokens:12, output_tokens:3, transcript_path:'/never/sent'});
assert.equal(execFileSync('/bin/sh',[path.join(share,'hook.sh')],{input:event, env, encoding:'utf8', timeout:10000}),'');
const spooled = fs.readdirSync(path.join(state,'spool')).flatMap(name=>fs.readFileSync(path.join(state,'spool',name),'utf8').split('\\n').filter(Boolean)).map(line=>JSON.parse(line));
assert.equal(spooled.length,1); assert.equal(spooled[0].hook,'stop'); assert.equal(spooled[0].payload.transcript_path,undefined);
const status = JSON.parse(execFileSync(process.execPath,[entry,'cursor','status','--json'],{env, encoding:'utf8', timeout:10000}));
assert.equal(status.hooks,'installed'); assert.equal(status.enabled,true); assert.equal(status.running,false);
const removed = await uninstallCursor(path.join(home,'.config/codetelemetry/cursor-hooks-v1.json'),{purge:true, host});
assert.equal(removed.ok,true); assert.deepEqual(removed.left,[]);
assert.deepEqual(fs.readdirSync(home,{recursive:true,withFileTypes:true}).filter(entry=>!entry.isDirectory()).map(entry=>entry.name),[]);
assert.deepEqual(calls.filter(call=>!call.startsWith('systemctl --user ')),[]);
`);
  const cursorHome = path.join(root, "cursor-home"); fs.mkdirSync(cursorHome);
  execFileSync(process.execPath, [cursorSmoke, cursorHome], {cwd: customer, encoding: "utf8", timeout: 30_000});
});
