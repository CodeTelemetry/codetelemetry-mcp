// Fail the build when the tool inventories that must agree don't.
//
// There are THREE registries, and a customer only ever sees the last one:
//
//   source     — TOOLS in src/tools.ts, plus the committed tool-manifest.json
//                snapshot and the two human-facing tool tables (README, docs page)
//   packaged   — what `npm pack` produces: the files, the `bin`, and the inventory
//                that artifact actually serves when spawned over stdio
//   published  — the version on npm that `npx -y @codetelemetry/mcp` downloads
//
// Tools have shipped that existed only in `source`: the package was never built
// or published, its `bin` pointed at TypeScript (which Node refuses to strip
// inside node_modules), or it declared a `file:` dependency that cannot resolve
// for anyone else. Every one of those is caught here.
//
//   node scripts/verifyRegistry.ts                    # source only (fast, hermetic)
//   node scripts/verifyRegistry.ts --packaged         # + pack, spawn, compare
//   node scripts/verifyRegistry.ts --published        # + compare against npm
//
// Exit 0 = the requested registries agree. Exit 1 = they differ, with every
// difference named. Exit 2 = the check could not be evaluated (never a pass).

import fs from "node:fs";
import path from "node:path";
import { TOOLS } from "../src/tools.ts";
import {
  canonicalJson,
  diffEntries,
  normalizeEntries,
  registryHash,
  toolManifest,
  type ToolManifest,
  type ToolManifestEntry,
} from "../src/manifest.ts";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../src/version.ts";
import { fetchPackument, readPackument, publishedProblems } from "./published.ts";
import {
  MANIFEST_PATH,
  README_PATH,
  packageVersion,
  readJsonFile,
} from "./paths.ts";
import {
  artifactDigest,
  extractTarball,
  linkNodeModules,
  makeTempDir,
  packLocal,
  packPublished,
  probeServer,
  removeDir,
  resolveBin,
} from "./harness.ts";

const PACKAGE_NAME = "@codetelemetry/mcp";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}`;

const problems: string[] = [];
const notes: string[] = [];
const fail = (msg: string) => problems.push(msg);
const note = (msg: string) => notes.push(msg);

// ── The source registry ───────────────────────────────────────────────────────
const live = toolManifest(TOOLS);

function readCommittedManifest(): ToolManifest {
  const raw = readJsonFile(MANIFEST_PATH) as Partial<ToolManifest>;
  return {
    serverName: String(raw.serverName ?? ""),
    serverVersion: String(raw.serverVersion ?? ""),
    registryHash: String(raw.registryHash ?? ""),
    toolCount: Number(raw.toolCount ?? -1),
    tools: normalizeEntries(raw.tools),
  };
}

/** Tool names named in a customer-facing table. Both surfaces are hand-written
 *  prose, so this checks NAME COVERAGE only — a tool that exists but is listed
 *  nowhere is undiscoverable for a human, and a listed tool that no longer exists
 *  sends people looking for something that will never appear. */
function documentedNames(file: string, pattern: RegExp): { names: Set<string>; ok: boolean } {
  if (!fs.existsSync(file)) return { names: new Set(), ok: false };
  const text = fs.readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const m of text.matchAll(pattern)) names.add(m[1]!);
  return { names, ok: true };
}

/** Install snippets that pin a version are the reason a client gets a known
 *  inventory — and a lie the moment the package moves on. Any pinned
 *  `@codetelemetry/mcp@x.y.z` in the docs must be THIS version; an unpinned mention
 *  is left alone. */
function checkPinnedVersions(surfaces: { label: string; file: string }[]): void {
  const pinned = /@codetelemetry\/mcp@(\d+\.\d+\.\d+[^\s"'`)\]]*)/g;
  for (const surface of surfaces) {
    if (!fs.existsSync(surface.file)) continue; // reported by checkDocs
    for (const m of fs.readFileSync(surface.file, "utf8").matchAll(pinned)) {
      if (m[1] !== MCP_SERVER_VERSION) {
        fail(`${surface.label} tells customers to install @codetelemetry/mcp@${m[1]}, but this release is ${MCP_SERVER_VERSION} — they would pin an older tool inventory`);
      }
    }
  }
}

function checkDocs(expected: Set<string>): void {
  const surfaces: { label: string; file: string; pattern: RegExp }[] = [
    // README tool table rows: | `tool_name` | what it does |
    { label: "README.md", file: README_PATH, pattern: /^\|\s*`([a-z_]+)`\s*\|/gm },
  ];
  for (const surface of surfaces) {
    const { names, ok } = documentedNames(surface.file, surface.pattern);
    if (!ok) {
      // A missing surface must not silently pass: the whole point is that the
      // customer-visible list can't drift from the registry.
      fail(`${surface.label} is missing (${surface.file}) — cannot verify the documented tool list`);
      continue;
    }
    for (const name of expected) {
      if (!names.has(name)) fail(`tool "${name}" is in the registry but NOT listed in ${surface.label}`);
    }
    for (const name of names) {
      if (!expected.has(name)) fail(`${surface.label} lists "${name}", which is not a registry tool`);
    }
  }
  checkPinnedVersions(surfaces);
}

function checkSource(): void {
  const committed = readCommittedManifest();
  const pkgVersion = packageVersion();

  if (pkgVersion !== MCP_SERVER_VERSION) {
    fail(`package.json version ${pkgVersion} != src/version.ts MCP_SERVER_VERSION ${MCP_SERVER_VERSION} — a client's \`initialize\` would report a version that was never released`);
  }
  if (committed.serverVersion !== MCP_SERVER_VERSION) {
    fail(`tool-manifest.json serverVersion ${committed.serverVersion || "(none)"} != ${MCP_SERVER_VERSION} — run \`npm run manifest:write\``);
  }
  if (committed.serverName !== MCP_SERVER_NAME) {
    fail(`tool-manifest.json serverName ${committed.serverName || "(none)"} != ${MCP_SERVER_NAME}`);
  }

  // The snapshot must be internally consistent, or its hash proves nothing.
  const recomputed = registryHash(committed.tools, committed.serverName || MCP_SERVER_NAME);
  if (recomputed !== committed.registryHash) {
    fail(`tool-manifest.json registryHash ${committed.registryHash || "(none)"} does not match its own tools (${recomputed}) — the file was hand-edited; run \`npm run manifest:write\``);
  }
  if (committed.toolCount !== committed.tools.length) {
    fail(`tool-manifest.json toolCount ${committed.toolCount} != ${committed.tools.length} tools listed`);
  }

  for (const p of diffEntries(live.tools, committed.tools, { expected: "source", actual: "committed manifest" })) {
    fail(p);
  }
  if (live.registryHash !== committed.registryHash) {
    fail(`source registryHash ${live.registryHash} != committed ${committed.registryHash || "(none)"} — run \`npm run manifest:write\` and commit the diff`);
  }

  checkDocs(new Set(live.tools.map((t) => t.name)));

  note(`source: ${live.toolCount} tools · version ${MCP_SERVER_VERSION} · registryHash ${live.registryHash}`);
}

// ── The packaged registry ─────────────────────────────────────────────────────

/** Relative module specifiers in the built output. Regex rather than a parser: the
 *  output is our own emitted ESM, where every import source is a plain string
 *  either after `from` or inside `import(…)`. Bare specifiers are NOT checked here
 *  — the spawn does that, against a node_modules that withholds the local-only
 *  @codetelemetry scope (see linkNodeModules). */
function relativeSpecifiers(distDir: string): { file: string; spec: string }[] {
  const found: { file: string; spec: string }[] = [];
  const patterns = [
    /(?:^|[\s}])from\s*["'](\.[^"']*)["']/g, // import … from "./x"  /  } from "../x"
    /^\s*import\s*["'](\.[^"']*)["']/gm, //      import "./x" (side effect)
    /\bimport\(\s*["'](\.[^"']*)["']\s*\)/g, //  await import("./x")
  ];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        for (const pattern of patterns) {
          for (const m of text.matchAll(pattern)) found.push({ file: full, spec: m[1]! });
        }
      }
    }
  };
  walk(distDir);
  return found;
}

function checkPackagedFiles(pkgDir: string): void {
  const committedRaw = fs.readFileSync(MANIFEST_PATH, "utf8");
  const shipped = path.join(pkgDir, "tool-manifest.json");
  if (!fs.existsSync(shipped)) {
    fail("tool-manifest.json is not in the tarball — the artifact carries no record of the inventory it serves");
  } else if (canonicalJson(JSON.parse(fs.readFileSync(shipped, "utf8"))) !== canonicalJson(JSON.parse(committedRaw))) {
    fail("the tarball's tool-manifest.json differs from the committed one");
  }

  const distDir = path.join(pkgDir, "dist");
  if (!fs.existsSync(distDir)) {
    fail("the tarball has no dist/ — `files` excludes the build output");
    return;
  }
  // A relative import that leaves the package root resolves on a developer's
  // machine and for nobody who installs the package, so it is a release blocker.
  for (const { file, spec } of relativeSpecifiers(distDir)) {
    const where = path.relative(pkgDir, file);
    const resolved = path.resolve(path.dirname(file), spec);
    if (path.relative(pkgDir, resolved).startsWith("..")) {
      fail(`${where} imports "${spec}", which escapes the package root — that path does not exist in an installed copy`);
    } else if (!fs.existsSync(resolved)) {
      fail(`${where} imports "${spec}", which is missing from the tarball`);
    }
  }
}

type ArtifactCheck = {
  /** The problems THIS artifact had (also recorded globally), so a caller can react
   *  to "this specific artifact disagreed" without re-reading the shared list. */
  problems: string[];
  /** Fingerprint of its functional payload — see harness.artifactDigest. */
  digest: string;
};

/**
 * Inspect a packed artifact WITHOUT running it: extract, check the shipped files and
 * their imports, and fingerprint the payload.
 *
 * Kept separate from launching it because one caller downloads its tarball from npm.
 * Executing that before its digest has been matched against the artifact we built
 * ourselves would mean running whatever the registry served — on a persistent
 * self-hosted runner — which is the very thing a supply-chain check exists to avoid.
 */
function inspectArtifact(pkgDir: string): string {
  checkPackagedFiles(pkgDir);
  return artifactDigest(pkgDir);
}

/**
 * Launch an artifact as a real stdio MCP server and assert the surface a client
 * discovers. ONLY for an artifact built from this checkout, or one already proven
 * byte-identical to it by digest.
 */
async function launchAndCheck(pkgDir: string, label: string): Promise<void> {
  linkNodeModules(pkgDir);
  const bin = resolveBin(pkgDir);
  const probe = await probeServer({
    command: process.execPath,
    args: [bin],
    withStatus: true,
    // Nothing here talks to a backend, but pin the endpoint anyway so a stray
    // ambient env var can't point the check at something unexpected.
    env: { CODETELEMETRY_API_BASE: "http://127.0.0.1:1", CODETELEMETRY_INGEST_ENDPOINT: "http://127.0.0.1:1" },
  });

  const committed = readCommittedManifest();
  for (const p of diffEntries(committed.tools, probe.tools, { expected: "committed manifest", actual: label })) {
    fail(p);
  }
  if (probe.serverInfo?.name !== MCP_SERVER_NAME) {
    fail(`${label} reports serverInfo.name ${probe.serverInfo?.name ?? "(none)"} != ${MCP_SERVER_NAME}`);
  }
  const server = (probe.status?.server ?? null) as { version?: unknown; registryHash?: unknown; toolCount?: unknown } | null;
  if (!server) {
    fail(`${label}: the status tool returned no \`server\` identity — a client cannot tell which build it is talking to`);
  } else {
    if (server.registryHash !== committed.registryHash) {
      fail(`${label} serves registryHash ${String(server.registryHash)} but the committed manifest is ${committed.registryHash}`);
    }
    if (server.version !== probe.serverInfo?.version) {
      fail(`${label}: status reports version ${String(server.version)} but initialize reported ${String(probe.serverInfo?.version)}`);
    }
    if (server.toolCount !== probe.tools.length) {
      fail(`${label}: status reports ${String(server.toolCount)} tools but tools/list returned ${probe.tools.length}`);
    }
  }
  note(`${label}: ${probe.tools.length} tools · initialize version ${probe.serverInfo?.version ?? "(none)"} · registryHash ${String(server?.registryHash ?? "(none)")} (launched)`);
}

/**
 * Prove the local artifact runs and serves the manifest. Given a tarball path, checks
 * THOSE bytes rather than packing its own — so a release can point every check at one
 * file and publish that same file, instead of verifying one build and shipping another.
 */
async function checkLocalArtifact(tarballPath: string | null = null): Promise<ArtifactCheck> {
  const before = problems.length;
  const work = makeTempDir("ct-mcp-verify-");
  try {
    const pkgDir = extractTarball(tarballPath ? path.resolve(tarballPath) : packLocal(work), work);
    const digest = inspectArtifact(pkgDir);
    const label = tarballPath ? `packaged artifact (${path.basename(tarballPath)})` : "packaged artifact";
    note(`${label}: artifact ${digest.slice(0, 12)}…`);
    await launchAndCheck(pkgDir, label);
    return { problems: problems.slice(before), digest };
  } finally {
    removeDir(work);
  }
}

/**
 * Inspect a PUBLISHED version's tarball — the bytes a customer's `npx` downloads —
 * without executing any of it. What proves it is right is that its payload digest
 * equals the artifact we just built from source, plus the shipped tool-manifest.json
 * and the file/import checks. Byte-identical bytes need no separate launch; bytes
 * that differ must not be launched at all.
 */
function checkPublishedArtifact(version: string, expectedDigest: string): ArtifactCheck {
  const before = problems.length;
  const label = `published ${version}`;
  const work = makeTempDir("ct-mcp-verify-");
  try {
    const pkgDir = extractTarball(packPublished(`${PACKAGE_NAME}@${version}`, work), work);
    const digest = inspectArtifact(pkgDir);
    note(
      digest === expectedDigest
        ? `${label}: artifact ${digest.slice(0, 12)}… — byte-identical to the local build (verified by digest; deliberately NOT executed)`
        : `${label}: artifact ${digest.slice(0, 12)}… — DIFFERS from the local build (${expectedDigest.slice(0, 12)}…); not executed`,
    );
    return { problems: problems.slice(before), digest };
  } finally {
    removeDir(work);
  }
}

// ── The published registry ────────────────────────────────────────────────────

async function checkPublished(requested: string, local: ArtifactCheck): Promise<void> {
  const packument = await fetchPackument(REGISTRY_URL);
  const reading = packument ? readPackument(packument, requested) : ({ kind: "not_published" } as const);
  if (reading.kind === "not_published") {
    fail(`${PACKAGE_NAME} is NOT PUBLISHED to npm — the documented install (\`npx -y ${PACKAGE_NAME}\`) cannot resolve, so a customer's client discovers no tools at all. Publish ${MCP_SERVER_VERSION}.`);
    return;
  }
  if (reading.kind === "missing_version") {
    throw new Error(`${PACKAGE_NAME}@${reading.requested} is not published`);
  }

  // Version + dist-tag judgement, including the one an explicit --published=<x>
  // would otherwise hide: `latest` is what an unpinned `npx` resolves, so it must
  // be THIS build even when a specific version was requested for inspection.
  for (const p of publishedProblems(reading, MCP_SERVER_VERSION)) fail(p);

  const published = checkPublishedArtifact(reading.version, local.digest);
  note(`npm: \`latest\` → ${reading.latest ?? "(none)"} · inspected ${reading.version}`);
  // Only an identical version makes a payload comparison meaningful.
  if (reading.version !== MCP_SERVER_VERSION) return;

  // Same version, different inventory is the silent failure this whole check
  // exists to prevent: a customer pinned to that version gets neither registry.
  if (published.problems.length) {
    fail(`published ${reading.version} serves a DIFFERENT inventory than source at the SAME version — bump the version instead of mutating a release`);
  }
  // Same version, different PAYLOAD: the inventory can be identical while the code
  // behind it is not (a normalizer fix, a dependency bump, a compiler change). npm
  // would keep serving the old build with everything else green. This compares the
  // artifacts as they are NOW, so it stays failed until the version is bumped —
  // unlike a git-range diff, which a later unrelated push would walk past.
  if (published.digest !== local.digest) {
    fail(
      `the packaged artifact differs from published ${reading.version} at the SAME version (local ${local.digest.slice(0, 12)}… vs published ${published.digest.slice(0, 12)}…) — shipped code, a dependency, or the build config changed. Bump the version in package.json and src/version.ts (then \`npm run manifest:write\`) so the change reaches clients.`,
    );
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const wantPackaged = argv.includes("--packaged");
  const publishedArg = argv.find((a) => a === "--published" || a.startsWith("--published="));
  const tarballArg = argv.find((a) => a.startsWith("--tarball="));
  const unknown = argv.filter(
    (a) =>
      a !== "--source" &&
      a !== "--packaged" &&
      a !== "--published" &&
      !a.startsWith("--published=") &&
      !a.startsWith("--tarball="),
  );
  if (unknown.length) {
    process.stderr.write(`unknown argument(s): ${unknown.join(" ")}\nusage: verifyRegistry.ts [--source] [--packaged [--tarball=<path>]] [--published[=<version>]]\n`);
    return 2;
  }
  // Given a tarball, the packaged check inspects THOSE bytes instead of packing its
  // own — so a release can verify and publish one identical file.
  const tarballPath = tarballArg ? tarballArg.slice("--tarball=".length) : null;
  if (tarballPath !== null && !tarballPath) {
    process.stderr.write("--tarball= needs a path\n");
    return 2;
  }

  // The source check underpins the others (they compare against the committed
  // manifest), so it always runs.
  checkSource();
  // --published needs the local artifact to compare against, so it implies
  // --packaged; pack once either way.
  const local = wantPackaged || publishedArg ? await checkLocalArtifact(tarballPath) : null;
  if (publishedArg) await checkPublished(publishedArg.split("=")[1] || "latest", local!);

  for (const n of notes) process.stdout.write(`  ${n}\n`);
  if (problems.length) {
    process.stderr.write(`\n✗ MCP tool registry drift (${problems.length}):\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(
      `\nThe inventory a customer discovers is the published one. Fix the drift, run \`npm run manifest:write\` if the change was intentional, and release.\n`,
    );
    return 1;
  }
  const scope = ["source", local ? "packaged" : null, publishedArg ? "published" : null]
    .filter(Boolean)
    .join(" = ");
  process.stdout.write(`✓ MCP tool registry consistent (${scope})\n`);
  return 0;
}

// A thrown error means the check could not be evaluated. Exit 2, never 0 — a
// verification that cannot run must not read as a pass.
process.exitCode = await main().catch((err: unknown) => {
  process.stderr.write(`\n✗ registry verification could not run: ${(err as Error)?.message ?? String(err)}\n`);
  return 2;
});
