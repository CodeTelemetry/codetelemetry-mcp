// Where the release-verification tooling looks for the things that must agree.
// One module so a test and a script can never disagree about which file is "the
// committed manifest" or "the customer-facing tool table".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, resolved from this file rather than cwd, so
 *  the scripts behave the same whether npm or a test spawned them. */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PKG_JSON_PATH = path.join(PKG_ROOT, "package.json");

/** The committed inventory snapshot. Also shipped INSIDE the published tarball,
 *  so a deployed artifact carries its own record of what it should serve. */
export const MANIFEST_PATH = path.join(PKG_ROOT, "tool-manifest.json");

/** The customer-facing tool table. It is gated like the registry itself. */
export const README_PATH = path.join(PKG_ROOT, "README.md");

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

export function packageVersion(): string {
  const pkg = readJsonFile(PKG_JSON_PATH) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`${PKG_JSON_PATH} has no version`);
  }
  return pkg.version;
}
