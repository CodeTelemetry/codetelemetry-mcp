import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decisionForHead,
  prepareGitHubWorkflow,
} from "../src/client/bootstrapGitHub.ts";

test("bootstrap accepts only a real Actions decision for this repo, head and current policy", () => {
  const started = Date.parse("2026-01-01T00:00:00Z"),
    head = "a".repeat(40);
  const good = {
    via: "actions",
    prUrl: "https://github.com/synthetic/repo/pull/1",
    headSha: head,
    at: "2026-01-01T01:00:00Z",
    posted: "failure",
    reason: "score_below_threshold",
    score: 0,
    sessionIds: ["synthetic-session"],
    policyVersion: 2,
  };
  assert.equal(
    decisionForHead([good], "synthetic/repo", head, started, 2),
    good,
  );
  for (const changed of [
    { headSha: "b".repeat(40) },
    { policyVersion: 1 },
    { prUrl: "https://github.com/another/repo/pull/1" },
    { at: "2025-12-31T00:00:00Z" },
    { via: "webhook" },
    { score: null },
    { posted: "pending" },
    { sessionIds: [] },
  ])
    assert.equal(
      decisionForHead(
        [{ ...good, ...changed }],
        "synthetic/repo",
        head,
        started,
        2,
      ),
      undefined,
    );
});
test("workflow preparation resumes exact bytes and refuses conflicting files and symlink parents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-bootstrap-workflow-"));
  const workflow = {
    path: ".github/workflows/codetelemetry-pr-gate.yml",
    content: "name: Synthetic workflow\n",
  };
  try {
    const file = prepareGitHubWorkflow(root, workflow);
    assert.equal(prepareGitHubWorkflow(root, workflow), file);
    assert.throws(
      () => prepareGitHubWorkflow(root, { ...workflow, content: "changed" }),
      /differs/,
    );
    fs.rmSync(path.join(root, ".github"), { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(root, ".github"));
    assert.throws(() => prepareGitHubWorkflow(root, workflow), /symbolic/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
