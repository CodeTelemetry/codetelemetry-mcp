// GitHub is checked with the user's existing gh authentication. No token is read,
// no repository code is executed, and remote policy changes remain explicit.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function command(
  binary: string,
  args: string[],
  cwd: string,
  deadline: number,
): string {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new Error(
      "Bootstrap time limit reached; resume to finish GitHub verification.",
    );
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: Math.min(8000, remaining),
    maxBuffer: 65536,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "GitHub verification needs an authenticated gh CLI and access to this repository's workflow and branch rules.",
    );
  return result.stdout;
}
export function decisionForHead(
  decisions: any[],
  repository: string,
  head: string,
  startedAt: number,
  policyVersion?: number,
) {
  if (!/^[a-f0-9]{40,64}$/.test(head)) return undefined;
  return decisions
    .slice(0, 100)
    .find(
      (d) =>
        d &&
        d.via === "actions" &&
        d.headSha === head &&
        new RegExp(
          `^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[0-9]+$`,
          "i",
        ).test(d.prUrl) &&
        Number.isFinite(Date.parse(d.at)) &&
        Date.parse(d.at) >= startedAt &&
        ["success", "failure"].includes(d.posted) &&
        Number.isFinite(d.score) &&
        d.score >= 0 &&
        d.score <= 100 &&
        Array.isArray(d.sessionIds) &&
        d.sessionIds.length > 0 &&
        (policyVersion === undefined || d.policyVersion === policyVersion),
    );
}
export function prepareGitHubWorkflow(
  root: string,
  workflow: { path: string; content: string },
): string {
  if (
    workflow.path !== ".github/workflows/codetelemetry-pr-gate.yml" ||
    typeof workflow.content !== "string" ||
    Buffer.byteLength(workflow.content) > 48 * 1024 ||
    /cot_[A-Za-z0-9_-]{16,}/.test(workflow.content)
  )
    throw new Error("Invalid generated GitHub workflow.");
  for (const suffix of [".github", ".github/workflows", workflow.path]) {
    const file = path.join(root, suffix);
    try {
      if (fs.lstatSync(file).isSymbolicLink())
        throw new Error("Workflow paths cannot contain symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const file = path.join(root, workflow.path);
  if (fs.existsSync(file)) {
    if (
      !fs.lstatSync(file).isFile() ||
      fs.statSync(file).size > 48 * 1024 ||
      fs.readFileSync(file, "utf8") !== workflow.content
    )
      throw new Error(
        "An existing gate workflow differs. Review and update it explicitly before resuming.",
      );
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o644,
    );
    try {
      fs.writeFileSync(fd, workflow.content);
    } finally {
      fs.closeSync(fd);
    }
  }
  return file;
}
export function verifyGitHubSetup(
  gate: any,
  repository: string,
  root: string,
  startedAt: number,
  deadline: number,
  policyVersion?: number,
) {
  const api = (suffix: string) =>
    JSON.parse(
      command("gh", ["api", `repos/${repository}${suffix}`], root, deadline),
    );
  const metadata = api("");
  if (
    typeof metadata.default_branch !== "string" ||
    metadata.default_branch.length > 256
  )
    throw new Error("GitHub default branch is unavailable.");
  const workflow = gate.actions?.workflow;
  const remote = api(
    `/contents/${workflow.path}?ref=${encodeURIComponent(metadata.default_branch)}`,
  );
  if (
    remote.encoding !== "base64" ||
    typeof remote.content !== "string" ||
    Buffer.from(remote.content, "base64").toString("utf8") !== workflow.content
  )
    return {
      verified: false,
      reason:
        "Commit the generated workflow to the repository's default branch.",
    };
  const required = gate.actions.requiredCheck;
  let enforced = false;
  try {
    const protection = api(
      `/branches/${encodeURIComponent(metadata.default_branch)}/protection/required_status_checks`,
    );
    enforced =
      Array.isArray(protection.checks) &&
      protection.checks.some(
        (c: any) =>
          c.context === required.name &&
          (c.app_id === required.appId || c.app_id === null),
      );
  } catch {
    /* Rulesets are the other supported branch policy. */
  }
  if (!enforced) {
    const summaries = api("/rulesets?includes_parents=true&per_page=21");
    if (!Array.isArray(summaries) || summaries.length > 20)
      return {
        verified: false,
        reason:
          "Inspect branch rules explicitly; automatic verification supports at most 20 rulesets.",
      };
    for (const summary of summaries) {
      if (!Number.isSafeInteger(summary.id) || summary.enforcement !== "active")
        continue;
      const ruleset = api(`/rulesets/${summary.id}`),
        names = ruleset.conditions?.ref_name;
      const applies =
        names &&
        Array.isArray(names.include) &&
        Array.isArray(names.exclude) &&
        names.exclude.length === 0 &&
        names.include.some((n: string) =>
          [
            "~DEFAULT_BRANCH",
            "~ALL",
            `refs/heads/${metadata.default_branch}`,
          ].includes(n),
        );
      if (
        applies &&
        Array.isArray(ruleset.rules) &&
        ruleset.rules.some(
          (r: any) =>
            r.type === "required_status_checks" &&
            r.parameters?.required_status_checks?.some(
              (c: any) =>
                c.context === required.name &&
                (c.integration_id === required.appId ||
                  c.integration_id === null),
            ),
        )
      ) {
        enforced = true;
        break;
      }
    }
  }
  if (!enforced)
    return {
      verified: false,
      reason: `Require ${required.name} on the default branch, then resume.`,
    };
  const head = command("git", ["rev-parse", "HEAD"], root, deadline).trim();
  const decision = decisionForHead(
    gate.recentDecisions ?? [],
    repository,
    head,
    startedAt,
    policyVersion,
  );
  if (!decision)
    return {
      verified: false,
      reason:
        "Run a real organization-scoped PR for this checkout's current HEAD and policy, then resume.",
    };
  return {
    verified: true,
    decision: {
      prUrl: decision.prUrl,
      headSha: decision.headSha,
      verdict: decision.posted,
      score: decision.score,
      threshold: decision.threshold,
      policyVersion: decision.policyVersion,
    },
  };
}
