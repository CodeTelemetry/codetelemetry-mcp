// Audit the exact npm tarball before it can reach the registry. This is an
// allowlist rather than a blocklist: a newly emitted module fails closed until a
// reviewer deliberately adds it to the public boundary below.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  extractTarball,
  makeTempDir,
  packLocal,
  removeDir,
} from "./harness.ts";

import { PUBLIC_MODULES } from "./publicModules.ts";

const ALLOWED = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "tool-manifest.json",
  ...PUBLIC_MODULES.flatMap((module) => [`dist/${module}.js`, `dist/${module}.d.ts`]),
]);

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "CodeTelemetry ingest key", pattern: /\bcot_[A-Za-z0-9_-]{20,}\b/ },
];

// Names that must never appear in the artifact. They are private, so they come
// from the environment (comma- or newline-separated) rather than this file.
const FORBIDDEN_REFERENCES = (process.env.PACKAGE_FORBIDDEN_REFERENCES ?? "")
  .split(/[,\n]/)
  .map((value) => value.trim())
  .filter(Boolean);

function filesBelow(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

export function audit(pkgDir: string, connect = false): string[] {
  const allowed = connect ? new Set([
    "LICENSE", "README.md", "package.json",
    ...PUBLIC_MODULES.filter(name => name.startsWith("src/client/")).flatMap(name => {
      const relative = name.slice("src/client/".length);
      return [`dist/${relative}.js`, `dist/${relative}.d.ts`];
    }),
  ]) : ALLOWED;
  const problems: string[] = [];
  const files = filesBelow(pkgDir);
  for (const file of files) {
    if (!allowed.has(file)) problems.push(`unexpected file: ${file}`);
  }
  for (const expected of allowed) {
    if (!files.includes(expected)) problems.push(`missing required file: ${expected}`);
  }
  for (const file of files) {
    const absolute = path.join(pkgDir, file);
    const body = fs.readFileSync(absolute, "utf8");
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(body)) problems.push(`${file} contains a value shaped like a ${label}`);
    }
    for (const value of FORBIDDEN_REFERENCES) {
      if (body.includes(value)) problems.push(`${file} contains a forbidden reference from PACKAGE_FORBIDDEN_REFERENCES`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = makeTempDir("ct-mcp-audit-");
  try {
    const connect = process.argv.includes("--connect");
    const requested = process.argv.slice(2).find(arg => arg !== "--connect");
    if (connect && !requested) throw new Error("Connect audit requires an exact tarball");
    const tarball = requested ? path.resolve(requested) : packLocal(work);
    const pkgDir = extractTarball(tarball, work);
    const problems = audit(pkgDir, connect);
    if (problems.length) {
      process.stderr.write(`\nPackage audit failed (${problems.length}):\n`);
      for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Package audit passed: explicit allowlisted files; no credential-shaped values or private-module references.\n`);
    }
  } finally {
    removeDir(work);
  }

}
