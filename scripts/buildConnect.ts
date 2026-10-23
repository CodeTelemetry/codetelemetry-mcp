import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {auditSource} from "./auditSource.ts";
import {PUBLIC_MODULES} from "./publicModules.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = auditSource(root);
if (problems.length) throw new Error(problems.join("\n"));
const directory = path.join(root, "packages/connect");
fs.rmSync(path.join(directory, "dist"), {recursive: true, force: true});
execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(directory, "tsconfig.build.json")],
  {cwd: root, stdio: "inherit", timeout: 60_000});
const expected = PUBLIC_MODULES.filter(name => name.startsWith("src/client/")).flatMap(name => {
  const relative = name.slice("src/client/".length); return [`${relative}.js`, `${relative}.d.ts`];
}).sort();
const output = path.join(directory, "dist");
const actual = fs.readdirSync(output, {recursive: true}).map(String)
  .filter(file => fs.statSync(path.join(output, file)).isFile()).map(file => file.split(path.sep).join("/")).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Connect build escaped its client-only file inventory");
