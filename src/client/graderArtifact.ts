// Local IaC authoring only. Never load a project, run a build, or persist keys.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Format = "auto" | "terraform" | "pulumi";
const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".terraform", ".pulumi", ".venv", "venv"]);

export function writeGraderArtifact(options: { repositoryPath: string; format?: Format; features: string; checks: unknown[] }) {
  const root = fs.realpathSync(options.repositoryPath);
  if (!fs.statSync(root).isDirectory() || root === os.homedir() || root === path.parse(root).root) throw new Error("Choose a project directory for the artifact.");
  let entries = 0;
  let truncated = false;
  const detected = new Set<string>();
  const evidence: string[] = [];
  const walk = (directory: string, depth: number) => {
    const handle = fs.opendirSync(directory);
    const children: fs.Dirent[] = [];
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        if (++entries > 4000) { truncated = true; break; }
        children.push(entry);
      }
    } finally { handle.closeSync(); }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isFile()) {
        const format = /\.tf(?:\.json)?$/.test(entry.name) ? "terraform" : /^Pulumi\.ya?ml$/.test(entry.name) ? "pulumi" : undefined;
        if (format) { detected.add(format); if (evidence.length < 20) evidence.push(path.relative(root, file)); }
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        if (depth >= 5) truncated = true;
        else if (entries <= 4000) walk(file, depth + 1);
      }
      if (entries > 4000) break;
    }
  };
  const requested = options.format ?? "auto";
  if (requested === "auto") walk(root, 0);
  // An incomplete or mixed scan cannot justify silently choosing one tool.
  if (requested === "auto" && (detected.size !== 1 || truncated)) throw new Error("IaC context is absent, mixed, or incomplete. Set format to terraform or pulumi, or choose a narrower repositoryPath.");
  const format = requested === "auto" ? [...detected][0]! : requested;
  const relative = format === "terraform" ? "codetelemetry-grader.tf.json" : "codetelemetry-grader.pulumi.yaml";
  const terraformLiteral = (value: string) => value.replaceAll("${", () => "$${").replaceAll("%{", "%%{");
  const pulumiLiteral = (value: string) => value.replaceAll("${", () => "$${");
  const contents = format === "terraform" ? {
    locals: { codetelemetry_grader_requested_features: terraformLiteral(options.features) },
    resource: { codetelemetry_grader_config: { instructions: { checks_json: terraformLiteral(JSON.stringify(options.checks)) } } },
  } : {
    // JSON is a YAML subset. This is a complete independent Pulumi YAML program,
    // usable regardless of the surrounding project's implementation language.
    name: "codetelemetry-grader", runtime: "yaml", description: options.features,
    packages: { codetelemetry: { source: "terraform-provider", version: "1.5.0", parameters: ["./bin/terraform-provider-codetelemetry"] } },
    resources: { grader: { type: "codetelemetry:index/graderConfig:GraderConfig", properties: { checksJson: { "fn::secret": pulumiLiteral(JSON.stringify(options.checks)) } } } },
  };
  const text = JSON.stringify(contents, null, 2) + "\n";
  if (/\b(?:cot_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error("Remove credential-shaped values from features and checks before writing an artifact.");
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Artifact exceeds 128 KiB; select fewer checks.");
  // Hold an opened directory while creating a single fixed leaf. On Linux the
  // fd-relative path also prevents parent rename/symlink races. Other hosts
  // verify the canonical parent and never follow or overwrite a target link.
  const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const destination = process.platform === "linux" ? `/proc/self/fd/${directory}/${relative}` : path.join(root, relative);
    if (fs.realpathSync(root) !== root) throw new Error("Repository path changed; retry.");
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  } finally { fs.closeSync(directory); }
  return { path: path.join(root, relative), format, evidence,
    nextSteps: format === "terraform"
      ? "Configure the local codetelemetry provider from codetelemetry-providers, then review terraform plan. The resource owns only the listed check ids. The locals retain requested focus; the dashboard API preserves its existing requestedFeatures."
      : "Move this file to a separate directory as Pulumi.yaml (JSON is valid YAML), build the codetelemetry-providers binary at ./bin/terraform-provider-codetelemetry in that directory, then run pulumi install and pulumi preview. The resource owns only the listed check ids. The program description retains requested focus; the dashboard API preserves its existing requestedFeatures.",
    note: "No commands ran and nothing was published. Supply CODETELEMETRY_ENDPOINT and a Cognito ID token as CODETELEMETRY_TOKEN through your secret manager when applying. This artifact contains no credentials. Use MCP publish_grader_config to publish draft changes separately when requested." };
}
