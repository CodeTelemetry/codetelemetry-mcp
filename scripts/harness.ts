// Shared plumbing for the release checks: turn this package (or a published
// version of it) into the artifact a customer would actually run, then drive it
// over the real MCP protocol on stdio.
//
// Everything happens in the OS temp directory — never in the worktree — so a
// verification run leaves no tarball or extracted tree behind.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalJson, normalizeEntries, type ToolManifestEntry } from "../src/manifest.ts";
import { PKG_ROOT } from "./paths.ts";

export type ServerProbe = {
  /** What `initialize` reported: the BUILD identity a client sees. */
  serverInfo: { name?: string; version?: string } | undefined;
  tools: ToolManifestEntry[];
  /** The `status` tool's model-safe diagnostics, when it was called. */
  status: Record<string, unknown> | null;
};

/** Reject if `work` hasn't settled in `ms`. The timer is cleared either way, so a
 *  fast success doesn't keep the process alive waiting for it. */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A temp workspace the caller is expected to remove in a `finally`. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Environment variables that must never reach an npm subprocess. npm runs lifecycle
 * scripts — ours during `pack`, and every dependency's during `install` — so anything
 * left in the environment is readable by third-party code. The release job holds a
 * production ingest key and an npm publish token, and neither is needed to pack or
 * install: the key reaches the server through the `get_ingest_key` tool, and the
 * publish runs outside this helper.
 *
 * Matched broadly on purpose. Over-stripping is harmless for pack/install;
 * under-stripping hands a credential to a stranger's postinstall.
 */
const CREDENTIAL_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_KEY$|API_?KEY|INGEST_KEY/i;

export function sanitizeEnvForSubprocess(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!CREDENTIAL_ENV_PATTERN.test(name)) clean[name] = value;
  }
  return clean;
}

/** Run npm, cross-platform, with credentials stripped from its environment. On
 *  Windows `npm` is a .cmd shim, which Node refuses to spawn without a shell — and
 *  passing an args array WITH a shell concatenates them unescaped (DEP0190). So build
 *  one quoted command string there, and use the plain no-shell array form elsewhere. */
export function runNpm(args: string[], cwd: string): string {
  const win = process.platform === "win32";
  const env = sanitizeEnvForSubprocess();
  const quoted = ["npm.cmd", ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))].join(" ");
  const result = win
    ? spawnSync(quoted, { cwd, env, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    : spawnSync("npm", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (exit ${result.status})\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** `npm pack` this package into `destDir`, returning the tarball path. Runs the
 *  package's own `prepack` (build + source verification), so this is exactly the
 *  artifact `npm publish` would upload. */
export function packLocal(destDir: string): string {
  const out = runNpm(["pack", "--silent", "--pack-destination", destDir], PKG_ROOT);
  return resolvePackedTarball(out, destDir);
}

/** Fetch a PUBLISHED version's tarball — the bytes a customer's `npx` downloads. */
export function packPublished(spec: string, destDir: string): string {
  const out = runNpm(["pack", spec, "--silent", "--pack-destination", destDir], destDir);
  return resolvePackedTarball(out, destDir);
}

function resolvePackedTarball(npmStdout: string, destDir: string): string {
  // `npm pack --silent` prints the filename, but the exact stdout shape has moved
  // between npm majors — so fall back to whatever .tgz landed in our own temp dir.
  const named = npmStdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (named) {
    const candidate = path.isAbsolute(named) ? named : path.join(destDir, path.basename(named));
    if (fs.existsSync(candidate)) return candidate;
  }
  const found = fs.readdirSync(destDir).filter((f) => f.endsWith(".tgz"));
  if (found.length !== 1) {
    throw new Error(`expected exactly one .tgz in ${destDir}, found ${found.length ? found.join(", ") : "none"}`);
  }
  return path.join(destDir, found[0]!);
}

/**
 * Extract an npm tarball and make it runnable: npm tarballs always root at
 * `package/`. Dependencies are supplied by linking this checkout's node_modules
 * (the MCP SDK), which keeps the check hermetic — the point here is whether the
 * PACKAGED FILES can serve the registry, not whether npm can resolve a semver
 * range. The `--npx` smoke covers real dependency resolution.
 */
export function extractTarball(tarball: string, destDir: string): string {
  // Pass a RELATIVE path with cwd=destDir: GNU tar reads an absolute Windows path
  // ("C:\…") as a remote host spec and tries to connect to host "C".
  const rel = path.relative(destDir, tarball);
  if (rel.includes(":")) throw new Error(`cannot extract ${tarball} relative to ${destDir}`);
  const result = spawnSync("tar", ["-xzf", rel], { cwd: destDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar -xzf failed (exit ${result.status})\n${result.stderr}`);
  const pkgDir = path.join(destDir, "package");
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
    throw new Error(`tarball ${path.basename(tarball)} has no package/package.json`);
  }
  return pkgDir;
}

/**
 * Install a candidate tarball the way a CUSTOMER would: `npm install <tgz>` into a
 * clean prefix, resolving the declared ranges fresh from the registry.
 *
 * This is the one check that exercises the dependency graph a customer actually gets.
 * The packaged check links dependencies from this checkout's lockfile, so it proves
 * the artifact is complete but pins `@modelcontextprotocol/sdk` to the version we
 * happen to have installed — while `^1.0.0` resolves to whatever is newest when a
 * customer installs. Without this, an incompatible transitive graph or an install
 * failure would first show up in the post-publish `npx` smoke, when the version is
 * already immutable.
 *
 * Install scripts are deliberately NOT disabled: a customer's install runs them, so a
 * dependency whose postinstall breaks should fail here. That is also exactly why
 * runNpm strips credentials from the environment first — those scripts are third-party
 * code, and the release job holds a production ingest key.
 *
 * Returns the installed package directory.
 */
export function installTarball(tarball: string, destDir: string): string {
  // npm wants a package.json in the prefix before it will populate node_modules.
  fs.writeFileSync(
    path.join(destDir, "package.json"),
    JSON.stringify({ name: "codetelemetry-mcp-install-check", version: "0.0.0", private: true }),
  );
  runNpm(["install", "--prefix", destDir, "--no-audit", "--no-fund", "--omit=dev", tarball], destDir);
  const installed = path.join(destDir, "node_modules", "@codetelemetry", "mcp");
  if (!fs.existsSync(path.join(installed, "package.json"))) {
    throw new Error(`npm install did not produce ${installed} — the tarball does not install`);
  }
  return installed;
}

/**
 * Give the extracted package a node_modules containing ONLY the transitive closure of
 * its own DECLARED production dependencies, linked from this checkout's install.
 *
 * The restriction is the point. Linking the whole dev tree would satisfy any bare
 * import the artifact happens to make — including one that is not declared, and so
 * resolves here and nowhere else. The historical bug of that shape was
 * `@codetelemetry/connect`, satisfiable only through a `file:../connect` link, but the
 * general case is the same: an undeclared import must fail the pre-publish check, not
 * the customer's install.
 *
 * Returns the package names it linked, so a caller/test can see the closure.
 */
export function linkNodeModules(pkgDir: string): string[] {
  const source = path.join(PKG_ROOT, "node_modules");
  if (!fs.existsSync(source)) {
    throw new Error(`no node_modules in ${PKG_ROOT} — run \`npm ci\` before verifying the packaged registry`);
  }
  const dirType = process.platform === "win32" ? "junction" : "dir"; // junction: no elevation on Windows
  const dest = path.join(pkgDir, "node_modules");
  fs.mkdirSync(dest, { recursive: true });

  const readDeps = (packageJsonPath: string): string[] => {
    if (!fs.existsSync(packageJsonPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
  };

  const linked: string[] = [];
  const seen = new Set<string>();
  const queue = readDeps(path.join(pkgDir, "package.json"));
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const from = path.join(source, ...name.split("/"));
    // A missing package is not this check's business to diagnose: an optional
    // dependency may legitimately be absent, and a missing REQUIRED one shows up as
    // the spawn failing to resolve it.
    if (!fs.existsSync(from)) continue;
    const to = path.join(dest, ...name.split("/"));
    if (!fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.symlinkSync(from, to, dirType);
    }
    linked.push(name);
    queue.push(...readDeps(path.join(from, "package.json")));
  }
  return linked;
}

/** package.json fields that change what an installed copy DOES — what npm resolves,
 *  what it will run, and where it will agree to run. Everything else (description,
 *  homepage, README) is presentation: a typo fix in it must not demand a version
 *  bump, and any of these must. */
const RUNTIME_PKG_FIELDS = [
  "name",
  "type",
  "bin",
  "exports",
  "main",
  "types",
  "imports",
  "files",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "engines",
  "os",
  "cpu",
  "libc",
  "sideEffects",
] as const;

/** The lifecycle hooks that execute on a CONSUMER's machine when the tarball is
 *  installed. `scripts` as a whole is deliberately not hashed — editing `test` must
 *  not demand a version bump — but gaining a postinstall must. */
const INSTALL_SCRIPT_HOOKS = ["preinstall", "install", "postinstall", "prepare"] as const;

/**
 * A fingerprint of the FUNCTIONAL payload of a packed package: every shipped
 * dist/ file plus tool-manifest.json, by content, and the package.json fields that
 * affect installation or execution — deliberately NOT `version`, the description
 * or the README.
 *
 * This is what makes "did the artifact change?" a question about state rather than
 * about a git range. A push-range diff cannot answer it: once one no-bump push has
 * failed, the next unrelated push sees no source change and would pass while npm
 * still serves the old build.
 */
export function artifactDigest(pkgDir: string): string {
  const parts: string[] = [];
  const add = (rel: string, absolute: string): void => {
    parts.push(`${rel.split(path.sep).join("/")} ${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
  };
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else add(path.relative(pkgDir, full), full);
    }
  };
  const dist = path.join(pkgDir, "dist");
  if (fs.existsSync(dist)) walk(dist);
  const manifest = path.join(pkgDir, "tool-manifest.json");
  if (fs.existsSync(manifest)) add("tool-manifest.json", manifest);

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
  const runtime: Record<string, unknown> = Object.fromEntries(RUNTIME_PKG_FIELDS.map((f) => [f, pkg[f]]));
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  runtime.installScripts = Object.fromEntries(
    INSTALL_SCRIPT_HOOKS.filter((hook) => scripts[hook] !== undefined).map((hook) => [hook, scripts[hook]]),
  );
  parts.sort();
  return createHash("sha256").update(canonicalJson({ files: parts, pkg: runtime })).digest("hex");
}

/**
 * Refusals from `estimate_linear_issue` that PROVE the route is deployed and
 * working, and differ only in how this workspace is configured. The release gate
 * accepts these as evidence when there is no issue to size.
 *
 * Deliberately much narrower than the tool's full typed vocabulary. These are
 * excluded because they do NOT show a healthy sizing path:
 *
 *   linear_not_configured  a deployment fault, by its own definition
 *   linear_unavailable     upstream Linear is down — the path cannot do its job
 *   read_limit_exceeded    a quota/limit fault, not an answer about the issue
 *   invalid_reference      the smoke sends a well-formed reference, so the server
 *   invalid_workspace      rejecting it (or a workspace/hint it was never given)
 *   conflicting_selection  means the server's contract differs from the tool's
 *
 * Everything outside the typed vocabulary — `unauthenticated`, `rate_limited`,
 * `read_timeout`, `sizing_failed`, an HTTP 404 from an undeployed route — is not
 * accepted either.
 */
export const ROUTE_PROVEN_REFUSALS: ReadonlySet<string> = new Set([
  "no_connected_workspace",
  "ambiguous_connection",
  "connection_not_found",
  "workspace_not_connected",
  "connection_needs_reconnect",
  "issue_not_found",
  "issue_inaccessible",
  // The route resolved the issue and found nothing sizable in it: that is this
  // issue's content, not a deployment problem.
  "empty_issue",
]);

/** How a client launches the server. Kept here, pure and exported, because the
 *  `npx` form is only exercised for real during a release — a unit test can at
 *  least prove the command it builds. */
export type Launch = { command: string; args: string[]; label: string; cwd?: string };

/** The documented customer install, `npx -y --package=@codetelemetry/mcp[@version]
 *  codetelemetry-mcp`, names the executable explicitly, so the launch stays
 *  deterministic even if the package ever carries more than one bin.
 *  On Windows `npx` is a .cmd shim, which Node will not spawn directly, so it goes
 *  through cmd.exe rather than leaving the transport to guess. */
export function npxLaunch(spec: string, platform: string = process.platform, cwd?: string): Launch {
  const win = platform === "win32";
  const packageArg = `--package=${spec}`;
  return {
    command: win ? "cmd.exe" : "npx",
    args: win ? ["/c", "npx", "-y", packageArg, "codetelemetry-mcp"] : ["-y", packageArg, "codetelemetry-mcp"],
    label: `npx -y ${packageArg} codetelemetry-mcp`,
    ...(cwd ? { cwd } : {}),
  };
}

/** This checkout's TypeScript entry point — for iterating locally, never a release. */
export function sourceLaunch(): Launch {
  return {
    command: process.execPath,
    args: [path.join(PKG_ROOT, "src", "server.ts")],
    label: "source checkout (src/server.ts)",
  };
}

/** The `bin` entry a client's launcher would execute, resolved inside pkgDir. */
export function resolveBin(pkgDir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    bin?: Record<string, string> | string;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["codetelemetry-mcp"];
  if (!rel) throw new Error("packaged package.json declares no codetelemetry-mcp bin");
  const abs = path.join(pkgDir, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`bin "${rel}" is declared but MISSING from the package — a client would fail to launch the server`);
  }
  return abs;
}

/**
 * Connect a real MCP client to a server process over stdio and read the surface a
 * client discovers: `initialize`'s serverInfo, `tools/list`, and optionally the
 * `status` tool (model-safe, needs no credential) for the running build's
 * registry hash. `calls` runs further tool calls while the session is open.
 */
const STDERR_TAIL_CHARS = 4_000;

export async function probeServer(opts: {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  withStatus?: boolean;
  calls?: (call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<void>;
  timeoutMs?: number;
  /** Bound on `initialize`. Generous by default because the `npx` path may download
   *  the package first — but never unbounded: see below. */
  handshakeMs?: number;
}): Promise<ServerProbe> {
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    // Inherit the parent env plus overrides; drop unset keys so the child does not
    // receive literal "undefined" strings.
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...(opts.env ?? {}) }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    stderr: "pipe",
  });
  // Keep a bounded tail of the child's stderr. When an `npx` launch dies before the
  // handshake (a registry error, a missing bin), its own message is the diagnosis.
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  const client = new Client({ name: "codetelemetry-release-check", version: "1.0.0" });
  // The handshake MUST be bounded. A packaged server that starts but never answers
  // `initialize`, or an `npx` that stalls reaching the registry, would otherwise
  // hang until the CI job's multi-hour limit — while holding the release workflow's
  // non-cancellable concurrency group. The SDK's own request timeout covers a
  // silent child; the outer deadline covers a transport that never settles at all,
  // and closing the transport kills the child rather than leaking it.
  const handshakeMs = opts.handshakeMs ?? 90_000;
  try {
    await withDeadline(
      client.connect(transport, { timeout: handshakeMs }),
      // The SDK's request timeout normally fires first; this outer deadline covers a
      // transport that never settles at all.
      handshakeMs + 5_000,
      `no response to \`initialize\` within ${handshakeMs}ms`,
    );
  } catch (err) {
    // Kill the child rather than leaking it, and report both failure modes the same
    // way — the launch command is the part an operator needs.
    await transport.close().catch(() => {});
    const stderr = stderrTail.replace(/cot_[A-Za-z0-9_-]{8,}/g, "cot_[redacted]").trim();
    throw new Error(
      `the server did not complete the MCP handshake within ${handshakeMs}ms ` +
        `(command: ${opts.command} ${opts.args.join(" ")}): ${(err as Error)?.message ?? String(err)}` +
        (stderr ? `\n--- server stderr (last ${STDERR_TAIL_CHARS} characters) ---\n${stderr}` : ""),
    );
  }
  try {
    const listed = await client.listTools(undefined, { timeout: opts.timeoutMs ?? 30_000 });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args }, undefined, {
        timeout: opts.timeoutMs ?? 90_000,
      })) as { structuredContent?: Record<string, unknown>; content?: { text?: string }[] };
      if (res.structuredContent) return res.structuredContent;
      return JSON.parse(res.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    };
    const status = opts.withStatus ? await call("status") : null;
    if (opts.calls) await opts.calls(call);
    return {
      serverInfo: client.getServerVersion(),
      tools: normalizeEntries(listed.tools),
      status,
    };
  } finally {
    await client.close();
  }
}
