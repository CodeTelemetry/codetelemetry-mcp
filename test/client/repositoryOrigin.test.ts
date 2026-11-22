import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubOrigin } from "../../src/client/repositoryOrigin.ts";
import { reportRolloutRepositories, rolloutRepository } from "../../src/client/rolloutRepository.ts";

test("only clone origins for a single GitHub repository yield a link", () => {
  for (const remote of ["git@github.com:Example/Project.git", "ssh://git@github.com/Example/Project.git", "https://github.com/Example/Project"]) {
    assert.equal(githubOrigin(remote), "https://github.com/Example/Project");
  }
  for (const remote of ["example/Project", "https://github.com.evil/Example/Project", "file:///x/y",
    "https://token@github.com/Example/Project", "https://github.com/Example/Project?auth=x",
    "https://github.com/Example/Project/pull/1", "https://github.com/Example/..", "https://github.com/Example/ghp_12345678901234567890"]) assert.equal(githubOrigin(remote), undefined);
});

test("metadata replay checks file identity and never exports rollout contents", () => {
  const child = "899de65e-a132-424f-a0c6-a287080dde06", parent = "7a038482-c63a-4c3e-bdec-7049b799bfcd";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-origin-"));
  try {
    const file = path.join(tmp, "rollout-2026-01-10-" + child + ".jsonl");
    const header = { type: "session_meta", timestamp: "2026-01-10T12:00:00Z", payload: { id: child, parent_thread_id: parent, git: {repository_url:"git@github.com:Example/Project.git"}, cwd:"/private" }};
    fs.writeFileSync(file, JSON.stringify(header)+'\n{"prompt":"private"}\n');
    assert.deepEqual(rolloutRepository(file)?.attributes, { "event.name":"codetelemetry.repository_observed", "session.id":child, "codex.parent_thread_id":parent, "vcs.repository.url.full":"https://github.com/Example/Project" });
    fs.writeFileSync(file, JSON.stringify({...header,payload:{...header.payload,id:parent}})+'\n');
    assert.throws(()=>rolloutRepository(file),/same session/);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});

test("state repair selects only named IDs and withholds missing or unsafe Git origins", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"state-origin-"));
  const file = path.join(tmp,"state.sqlite");
  const a = "bbaef98d-a904-4000-8000-000000000001", b = "bbaef98d-a904-4000-8000-000000000002";
  try {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, git_origin_url TEXT, updated_at INTEGER)");
    const add = db.prepare("INSERT INTO threads VALUES(?,?,1700000000)");
    add.run(a,"git@github.com:Example/One.git"); add.run(b,"https://user:secret@example.test/One");
    db.close();
    const preview = await reportRolloutRepositories([a,b],false,file);
    assert.equal(preview.sent,0);
    assert.equal(preview.skipped,1);
    assert.equal(preview.observations[0]?.attributes["vcs.repository.url.full"],"https://github.com/Example/One");
    await assert.rejects(reportRolloutRepositories(["not-a-uuid"],false,file),/UUID/);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
