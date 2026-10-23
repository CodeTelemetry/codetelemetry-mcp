import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PUBLIC_MODULES } from "./publicModules.ts";

export function auditSource(root: string): string[] {
  const allowed = new Set(PUBLIC_MODULES.map(name => `${name}.ts`));
  const problems: string[] = [], found: string[] = [];
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) problems.push(`${file}: source symlinks are forbidden`);
      else if (entry.isDirectory()) visit(file);
      else found.push(file);
    }
  };
  visit("src");
  for (const file of found) {
    if (!allowed.has(file)) { problems.push(`${file}: outside the reviewed public runtime inventory`); continue; }
    const content = fs.readFileSync(path.join(root, file), "utf8");
    if (file.startsWith("src/client/kiro/") && /provider_turn_usage|turn_completion|usage[.]amount|turn[.]status|turn[.]stop_reason/.test(content)) {
      problems.push(`${file}: product interpretation belongs to private ingestion`);
    }
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const check = (specifier: string) => {
      if (specifier.startsWith("node:") || specifier.startsWith("@modelcontextprotocol/sdk/")) return;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!specifier.startsWith(".") || !allowed.has(resolved)) problems.push(`${file}: import outside the public boundary: ${specifier}`);
    };
    const walk = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) check(argument.text);
        else problems.push(`${file}: computed module loading requires an explicit public boundary`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  for (const file of allowed) if (!found.includes(file)) problems.push(`${file}: missing public runtime module`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = auditSource(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else console.log("Public source boundary passed: all runtime files and imports are allowlisted.");
}
