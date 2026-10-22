import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {auditSource} from "../scripts/auditSource.ts";

test("public runtime fails closed on new files, external imports and symlinks", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-boundary-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.cpSync(fileURLToPath(new URL("../src", import.meta.url)), path.join(root, "src"), {recursive: true});
  assert.deepEqual(auditSource(root), []);
  fs.writeFileSync(path.join(root, "src/accidentalBackend.ts"), "export {};\n");
  assert.ok(auditSource(root).some(problem => problem.includes("accidentalBackend.ts")));
  fs.rmSync(path.join(root, "src/accidentalBackend.ts"));
  fs.appendFileSync(path.join(root, "src/index.ts"), '\nimport "../../private-backend.ts";\n');
  assert.ok(auditSource(root).some(problem => problem.includes("import outside")));
  fs.symlinkSync("index.ts", path.join(root, "src/linked.ts"));
  assert.ok(auditSource(root).some(problem => problem.includes("symlinks")));
});
