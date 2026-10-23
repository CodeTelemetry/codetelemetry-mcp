import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {fetchPackument, publishOrderProblem, type Packument} from "./published.ts";
import {extractTarball, makeTempDir, removeDir} from "./harness.ts";

export function releaseArtifactProblem(packument: Packument | null, version: string, integrity: string, published: boolean): string | null {
  const versions = packument?.versions ?? {};
  if (!published) {
    if (Object.hasOwn(versions, version)) return `Package ${version} is already published`;
    return publishOrderProblem(packument?.["dist-tags"]?.latest ?? null, version);
  }
  if (packument?.["dist-tags"]?.latest !== version) return "Package latest does not match the candidate version";
  const metadata = versions[version] as {dist?: {integrity?: string}} | undefined;
  if (metadata?.dist?.integrity !== integrity) return "Package registry integrity does not match the exact verified tarball";
  return null;
}

async function main() {
  const args = process.argv.slice(2), published = args.includes("--published");
  const tarball = args.find(arg => !arg.startsWith("--"));
  if (!tarball || args.some(arg => arg.startsWith("--") && arg !== "--published")) throw new Error("Usage: node scripts/releaseArtifact.ts <tarball> [--published]");
  const work = makeTempDir("ct-connect-release-");
  try {
    const pkg = extractTarball(path.resolve(tarball), work);
    const metadata = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
    if (!["@codetelemetry/connect", "@codetelemetry/mcp"].includes(metadata.name) || typeof metadata.version !== "string") throw new Error("Expected a public CodeTelemetry candidate");
    const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
    const packument = await fetchPackument(`https://registry.npmjs.org/${metadata.name.replace("/", "%2f")}`, (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(30000)}));
    const problem = releaseArtifactProblem(packument, metadata.version, integrity, published);
    if (problem) throw new Error(problem);
    console.log(`${metadata.name} ${metadata.version}: ${published ? "latest and exact artifact integrity verified" : "publish order verified"}`);
  } finally {removeDir(work);}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {console.error((error as Error).message); process.exitCode = 1;});
}
