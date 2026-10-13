// What npm currently offers, judged against this build — the pure half of the
// `--published` check, so it can be tested without touching the network.
//
// The subtlety this exists for: `npx -y @codetelemetry/mcp` (the documented,
// unpinned install, and therefore what most customers run) resolves the **`latest`
// dist-tag** — not "the version in this checkout". Verifying an explicit version's
// tarball proves that tarball is right and says nothing about which one a customer
// gets. npm also does NOT advance `latest` when you publish a version lower than
// the current one, so a downgrade or a regressed `main` can leave the two pointing
// at different inventories with every other check green.

import { MCP_SERVER_VERSION } from "../src/version.ts";

/** The subset of an npm packument this needs. */
export type Packument = {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, unknown>;
};

export type PackumentReading =
  | { kind: "not_published" }
  /** The caller asked for a version npm has never seen. */
  | { kind: "missing_version"; requested: string }
  | { kind: "ok"; version: string; latest: string | null };

/** Which published version to inspect, and what the default tag points at. */
export function readPackument(packument: Packument, requested: string): PackumentReading {
  const latest = packument["dist-tags"]?.latest ?? null;
  const versions = packument.versions ?? {};
  if (requested === "latest") {
    if (!latest) return { kind: "not_published" };
    return { kind: "ok", version: latest, latest };
  }
  if (!Object.prototype.hasOwnProperty.call(versions, requested)) {
    return { kind: "missing_version", requested };
  }
  return { kind: "ok", version: requested, latest };
}

/**
 * Semver precedence (spec §11), including prereleases. -1, 0 or 1.
 *
 * The prerelease rules are not decoration here: an earlier version of this compared
 * only `major.minor.patch`, which made `1.0.0-beta.1` look EQUAL to `1.0.0` — so the
 * publish-order gate would have waved through a prerelease below an existing release,
 * and the downgrade would only surface once the version was immutable.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata (`+…`) is explicitly excluded from precedence.
    const [core, ...preParts] = v.split("+")[0]!.split("-");
    const pre = preParts.join("-");
    return {
      nums: core!.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: pre ? pre.split(".") : [],
    };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  }
  // Same core: a version WITH a prerelease is lower than one without.
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const xi = x.pre[i];
    const yi = y.pre[i];
    // All preceding identifiers equal: the longer prerelease is higher.
    if (xi === undefined) return -1;
    if (yi === undefined) return 1;
    const xNum = /^\d+$/.test(xi);
    const yNum = /^\d+$/.test(yi);
    if (xNum && yNum) {
      // Compared by length then lexicographically, NOT via Number(): semver puts no
      // ceiling on a numeric identifier, and `Number()` rounds anything past
      // 2^53 — making e.g. beta.9007199254740992 and beta.9007199254740993 look
      // equal, which would let the publish-order gate wave a downgrade through.
      // Leading zeros are forbidden in numeric identifiers, so this is exact.
      if (xi.length !== yi.length) return xi.length < yi.length ? -1 : 1;
      if (xi !== yi) return xi < yi ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (xi !== yi) {
      return xi < yi ? -1 : 1; // ASCII order
    }
  }
  return 0;
}

/** Fetch a package's packument, or null when the package has never been published. */
export async function fetchPackument(
  registryUrl: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Packument | null> {
  // This is the representation npm install/npx consume. After a first publish it
  // can become available before the full application/json packument, so asking for
  // exactly the customer-facing representation avoids a false post-publish 404.
  const res = await fetchImpl(registryUrl, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`npm registry lookup failed: HTTP ${res.status}`);
  return (await res.json()) as Packument;
}

/**
 * Why this version must not be published, checked BEFORE publishing. Null means the
 * order is fine.
 *
 * npm keeps `latest` on the highest version, so publishing a lower one does not
 * change what an unpinned install resolves — but the version itself is immutable and
 * immediately installable by anyone who pins it. Detecting that after the fact (in
 * the published-parity step) is too late: the only remedy is a forward bump, and the
 * stray version stays on npm forever.
 */
export function publishOrderProblem(latest: string | null, sourceVersion: string = MCP_SERVER_VERSION): string | null {
  if (latest === null) return null; // First release: nothing to be behind.
  const cmp = compareVersions(latest, sourceVersion);
  if (cmp > 0) {
    return `refusing to publish ${sourceVersion}: npm's \`latest\` is already ${latest}, so this would publish a DOWNGRADE — immutable, installable by anyone who pins it, and it would not become \`latest\`. Bump past ${latest} instead.`;
  }
  return null;
}

/**
 * Every way npm's current state disagrees with this build, as human-readable lines.
 * Empty means the version a customer resolves IS this build's version.
 */
export function publishedProblems(
  state: { version: string; latest: string | null },
  sourceVersion: string = MCP_SERVER_VERSION,
): string[] {
  const problems: string[] = [];
  const cmp = compareVersions(state.version, sourceVersion);
  if (cmp < 0) {
    problems.push(`the published registry is BEHIND source: npm has ${state.version}, this checkout is ${sourceVersion} — the release did not ship, so customers keep discovering the old inventory`);
  } else if (cmp > 0) {
    problems.push(`npm has ${state.version}, AHEAD of this checkout (${sourceVersion}) — this branch would publish a downgrade`);
  }
  // The tag check is about the DEPLOYMENT, not about whichever version was
  // requested for inspection: whatever `latest` points at is what an unpinned
  // install serves.
  if (state.latest === null) {
    problems.push("npm has no `latest` dist-tag, so the documented unpinned install (`npx -y @codetelemetry/mcp`) cannot resolve");
  } else if (state.latest !== sourceVersion) {
    problems.push(`npm's \`latest\` tag is ${state.latest}, not ${sourceVersion} — the documented unpinned install (\`npx -y @codetelemetry/mcp\`) would serve that inventory instead of this build's. npm does not advance \`latest\` for a lower version, so publishing a downgrade leaves it behind.`);
  }
  return problems;
}
