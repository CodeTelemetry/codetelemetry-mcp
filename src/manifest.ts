// The tool MANIFEST: the exact inventory a client sees from `tools/list`, in a
// form that can be hashed, committed, and compared across three places that must
// agree — the source registry (tools.ts), the packaged artifact (`npm pack`), and
// the deployed/published package a customer actually installs.
//
// Why a hash and not just a version: two builds can both claim "0.2.0" while
// serving different inventories, leaving a source-only tool absent from a client.
// `registryHash` is derived from the
// wire-visible fields ONLY (name/title/description/inputSchema), so it answers
// "which inventory is this process serving?" independently of the build's version.
// The version is deliberately NOT part of the hash: a release that only bumps the
// version must not look like an inventory change.

import { createHash } from "node:crypto";
// Type-only, deliberately: tools.ts imports this module for the `status` tool's
// registry identity, so a VALUE import of the registry here would close a runtime
// import cycle. Callers pass TOOLS in.
import { type ToolDef } from "./tools.ts";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./version.ts";

/** One `tools/list` entry — the whole model-visible contract for a tool. */
export type ToolManifestEntry = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolManifest = {
  serverName: string;
  serverVersion: string;
  /** sha256 over the canonical form of { serverName, tools } (NOT the version). */
  registryHash: string;
  toolCount: number;
  tools: ToolManifestEntry[];
};

/** The `tools/list` payload, built from the registry. mcpServer.ts serves exactly
 *  this, so the manifest can never describe something the wire doesn't. */
export function manifestEntries(tools: readonly ToolDef[]): ToolManifestEntry[] {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Deterministic JSON: object keys sorted, array order preserved (tool order is
 * part of what a client displays, so a reorder is a real change). Built by string
 * concatenation rather than by rebuilding objects — no intermediate object means
 * no chance of a `__proto__`-style key being swallowed by an assignment.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    // Match JSON.stringify: an explicitly-undefined property is absent, not null.
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

/** Stable fingerprint of an inventory. Same tools → same hash on any machine. */
export function registryHash(
  tools: readonly ToolManifestEntry[],
  serverName: string = MCP_SERVER_NAME,
): string {
  return createHash("sha256").update(canonicalJson({ serverName, tools })).digest("hex");
}

/** The live manifest of a registry: what CI hashes and what gets committed. */
export function toolManifest(tools: readonly ToolDef[]): ToolManifest {
  const entries = manifestEntries(tools);
  return {
    serverName: MCP_SERVER_NAME,
    serverVersion: MCP_SERVER_VERSION,
    registryHash: registryHash(entries),
    toolCount: entries.length,
    tools: entries,
  };
}

/** The manifest without the tool bodies — small enough to return from a tool
 *  result, and enough to answer "which build, serving which inventory, am I
 *  actually talking to?" from a live client. */
export function registryIdentity(tools: readonly ToolDef[]): {
  name: string;
  version: string;
  registryHash: string;
  toolCount: number;
} {
  const entries = manifestEntries(tools);
  return {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    registryHash: registryHash(entries),
    toolCount: entries.length,
  };
}

/** Normalize an untrusted manifest-shaped value (a committed file, or a
 *  `tools/list` response) down to the comparable fields. Unknown/extra fields are
 *  dropped rather than rejected: the comparison is about the contract, and a
 *  future SDK adding a field to `tools/list` must not read as registry drift. */
export function normalizeEntries(value: unknown): ToolManifestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return {
      name: typeof t.name === "string" ? t.name : "",
      title: typeof t.title === "string" ? t.title : "",
      description: typeof t.description === "string" ? t.description : "",
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
          ? (t.inputSchema as Record<string, unknown>)
          : {},
    };
  });
}

/**
 * Every way two inventories differ, as human-readable lines. Empty means they
 * agree. The lines are what CI prints when it refuses a release, so they name the
 * tool and the field rather than dumping two JSON blobs.
 */
export function diffEntries(
  expected: readonly ToolManifestEntry[],
  actual: readonly ToolManifestEntry[],
  labels: { expected: string; actual: string } = { expected: "expected", actual: "actual" },
): string[] {
  const problems: string[] = [];
  const byName = (entries: readonly ToolManifestEntry[]) => new Map(entries.map((e) => [e.name, e]));
  const want = byName(expected);
  const got = byName(actual);

  for (const name of want.keys()) {
    if (!got.has(name)) problems.push(`tool "${name}" is in the ${labels.expected} registry but MISSING from the ${labels.actual} registry`);
  }
  for (const name of got.keys()) {
    if (!want.has(name)) problems.push(`tool "${name}" is in the ${labels.actual} registry but not in the ${labels.expected} registry`);
  }
  for (const [name, w] of want) {
    const g = got.get(name);
    if (!g) continue;
    for (const field of ["title", "description"] as const) {
      if (w[field] !== g[field]) problems.push(`tool "${name}": ${field} differs (${labels.expected} vs ${labels.actual})`);
    }
    if (canonicalJson(w.inputSchema) !== canonicalJson(g.inputSchema)) {
      problems.push(`tool "${name}": inputSchema differs (${labels.expected} vs ${labels.actual})`);
    }
  }
  const order = (entries: readonly ToolManifestEntry[]) => entries.map((e) => e.name).join(",");
  if (!problems.length && order(expected) !== order(actual)) {
    problems.push(`tool ORDER differs: ${labels.expected}=[${order(expected)}] ${labels.actual}=[${order(actual)}]`);
  }
  return problems;
}
