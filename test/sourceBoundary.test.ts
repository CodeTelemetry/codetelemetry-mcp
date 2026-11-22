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
  const kiro = path.join(root, "src/client/kiro/records.ts");
  const original = fs.readFileSync(kiro, "utf8");
  fs.appendFileSync(kiro, '\nconst forbiddenMapping = "provider_turn_usage";\n');
  assert.ok(auditSource(root).some(problem => problem.includes("product interpretation belongs to private ingestion")));
  fs.writeFileSync(kiro, original);
  // The Cursor collector ships source records and never names what they become.
  const cursor = path.join(root, "src/client/cursor/records.ts");
  const cursorOriginal = fs.readFileSync(cursor, "utf8");
  for (const interpreted of ["user_prompt", "api_request", "tool_result", "cache_creation_tokens", "usage_scope", "cursor.outcome"]) {
    fs.appendFileSync(cursor, `\nconst forbiddenMapping = "${interpreted}";\n`);
    assert.ok(auditSource(root).some(problem => problem === "src/client/cursor/records.ts: product interpretation belongs to private ingestion"), interpreted);
    fs.writeFileSync(cursor, cursorOriginal);
  }
  fs.appendFileSync(kiro, '\nconst allowedOutsideCursor = "tool_result";\n');
  assert.deepEqual(auditSource(root), [], "the Cursor rule applies to the Cursor collector only");
  fs.writeFileSync(kiro, original);
  fs.writeFileSync(path.join(root, "src/accidentalBackend.ts"), "export {};\n");
  assert.ok(auditSource(root).some(problem => problem.includes("accidentalBackend.ts")));
  fs.rmSync(path.join(root, "src/accidentalBackend.ts"));
  fs.appendFileSync(path.join(root, "src/index.ts"), '\nimport "../../private-backend.ts";\n');
  assert.ok(auditSource(root).some(problem => problem.includes("import outside")));
  fs.symlinkSync("index.ts", path.join(root, "src/linked.ts"));
  assert.ok(auditSource(root).some(problem => problem.includes("symlinks")));
});
