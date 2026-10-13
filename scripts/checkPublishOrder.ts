// Refuse a downgrade BEFORE `npm publish`, not after.
//
//   npm run verify:publish-order
//
// The published-parity check catches a version that isn't `latest`, but only once the
// version exists — and an npm version is immutable, immediately installable by anyone
// who pins it, and unremovable in practice. So the release asks this question first:
// is the version we are about to publish actually ahead of what npm already has?
//
// Exit 0 = safe to publish (including the very first release). Exit 1 = a downgrade.
// Exit 2 = the check could not run, which is never a pass.

import { MCP_SERVER_VERSION } from "../src/version.ts";
import { fetchPackument, publishOrderProblem } from "./published.ts";

const PACKAGE_NAME = "@codetelemetry/mcp";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}`;

async function main(): Promise<number> {
  const packument = await fetchPackument(REGISTRY_URL);
  const latest = packument?.["dist-tags"]?.latest ?? null;
  const problem = publishOrderProblem(latest, MCP_SERVER_VERSION);
  if (problem) {
    process.stderr.write(`\n✗ ${problem}\n`);
    return 1;
  }
  process.stdout.write(
    latest === null
      ? `✓ ${PACKAGE_NAME} has never been published — ${MCP_SERVER_VERSION} would be the first release\n`
      : `✓ ${MCP_SERVER_VERSION} is ahead of npm's latest (${latest})\n`,
  );
  return 0;
}

process.exitCode = await main().catch((err: unknown) => {
  process.stderr.write(`\n✗ publish-order check could not run: ${(err as Error)?.message ?? String(err)}\n`);
  return 2;
});
