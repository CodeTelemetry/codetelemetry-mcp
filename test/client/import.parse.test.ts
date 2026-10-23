// Session-history import: the two local-file parsers (Claude Code transcripts,
// Codex rollouts), streamed from the fixture tree exactly as the CLI reads them.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CONTENT, NO_CONTENT, MAX_EVENTS_PER_SESSION, trimSessionToWindow } from "../../src/client/import/model.ts";
import { parseClaudeTranscriptText, ClaudeSessionAccumulator } from "../../src/client/import/sources/claudeCodeText.ts";
import { parseCodexRolloutText } from "../../src/client/import/sources/codexText.ts";
import { parseCandidate, scanClaudeSessions, scanCodexSessions } from "../../src/client/import/sources/files.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "import");
const CLAUDE_DIR = path.join(FIX, "claude-projects");
const CODEX_DIR = path.join(FIX, "codex-sessions");
const ms = (iso: string) => Date.parse(iso);

async function claudeSession(keep = NO_CONTENT) {
  const [c] = scanClaudeSessions(CLAUDE_DIR);
  const out = await parseCandidate(c, keep);
  assert.ok(out.ok && out.session);
  return { candidate: c, session: out.session };
}

test("claude: a session folds its subagent transcripts in and skips injected prompts", async () => {
  const { candidate, session } = await claudeSession();
  assert.equal(candidate.extraFiles.length, 1, "the subagents/ transcript belongs to the session");
  assert.equal(session.sessionId, "cs-test-1");
  assert.equal(session.cwd, "/work/app");
  assert.deepEqual(session.prompts.map((p) => p.promptId), ["p-1", "p-2"]);
  assert.equal(session.prompts[0].text, null, "no text is kept without a content opt-in");
  assert.equal(session.prompts[0].length, "Fix the login bug in /work/app/src/login.ts".length);
  assert.equal(session.startMs, ms("2026-10-01T10:00:00.000Z"));
  assert.equal(session.endMs, ms("2026-10-01T11:31:00.000Z"));
});

test("claude: one model call per request id, settled usage, synthetic errors bill nothing", async () => {
  const { session } = await claudeSession();
  const byId = Object.fromEntries(session.modelCalls.map((c) => [c.responseId, c]));
  assert.deepEqual(Object.keys(byId).sort(), ["req-1", "req-2", "req-3", "req-s1"]);
  assert.deepEqual(
    { i: byId["req-1"].inputTokens, o: byId["req-1"].outputTokens, cr: byId["req-1"].cacheReadTokens, cc: byId["req-1"].cacheCreationTokens },
    { i: 100, o: 20, cr: 1000, cc: 50 },
    "the last streamed record of a request carries its settled output count",
  );
  assert.equal(byId["req-1"].tsMs, ms("2026-10-01T10:00:05.000Z"), "a call is stamped when it started streaming");
  assert.equal(byId["req-s1"].model, "claude-sonnet-4-6", "subagent calls are the session's calls too");
  assert.equal(byId["req-1"].promptId, "p-1");
  assert.equal(byId["req-s1"].promptId, "p-2", "subagent calls attribute to the prompt active at the time");
});

test("claude: tool results pair with their calls and keep the recorded verdict", async () => {
  const { session } = await claudeSession();
  const byId = Object.fromEntries(session.toolCalls.map((t) => [t.toolUseId, t]));
  assert.deepEqual(Object.keys(byId).sort(), ["toolu-1", "toolu-2", "toolu-3", "toolu-s1"]);
  assert.equal(byId["toolu-1"].success, true);
  assert.equal(byId["toolu-2"].success, false, "is_error marks a failed tool");
  assert.equal(byId["toolu-2"].toolName, "Bash");
  assert.equal(byId["toolu-1"].input, null, "no tool input is kept without a content opt-in");
  assert.ok(byId["toolu-1"].inputBytes > 0);
  assert.equal("durationMs" in byId["toolu-1"], false, "no duration: a transcript gap is not execution time");
});

test("claude: content is kept only when asked for", async () => {
  const { session } = await claudeSession(ALL_CONTENT);
  assert.equal(session.prompts[0].text, "Fix the login bug in /work/app/src/login.ts");
  const read = session.toolCalls.find((t) => t.toolUseId === "toolu-1")!;
  assert.equal(read.input, JSON.stringify({ file_path: "/work/app/src/login.ts" }));
});

test("claude: a session over the event bound is refused whole", () => {
  const acc = new ClaudeSessionAccumulator();
  const line = (i: number) => JSON.stringify({
    type: "user", sessionId: "big", timestamp: "2026-10-01T10:00:00.000Z",
    promptId: `p-${i}`, message: { role: "user", content: `prompt ${i}` },
  });
  for (let i = 0; i <= MAX_EVENTS_PER_SESSION; i++) acc.line(line(i));
  assert.equal(acc.overflowed, true);
});

test("claude: in-memory text parsing (browser path) matches the streamed parser", async () => {
  const { session } = await claudeSession();
  const raw = fs.readFileSync(path.join(CLAUDE_DIR, "-work-app", "cs-test-1.jsonl"), "utf8") + "\n" +
    fs.readFileSync(path.join(CLAUDE_DIR, "-work-app", "cs-test-1", "subagents", "agent-a1.jsonl"), "utf8");
  const viaText = parseClaudeTranscriptText(raw, { filePath: "cs-test-1.jsonl" })!;
  assert.deepEqual(viaText.modelCalls, session.modelCalls);
  assert.deepEqual(viaText.toolCalls, session.toolCalls);
  assert.deepEqual(viaText.prompts, session.prompts);
});

test("codex (legacy rollout): token_count stream, repeated emissions dropped, resets skipped", async () => {
  const c = scanCodexSessions(CODEX_DIR).find((x) => x.file.includes("0001"))!;
  const out = await parseCandidate(c, NO_CONTENT);
  assert.ok(out.ok && out.session);
  const s = out.session;
  assert.equal(s.sessionId, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
  assert.equal(s.cwd, "/work/svc");
  assert.deepEqual(s.prompts.map((p) => p.promptId), ["cx-p1"]);
  assert.deepEqual(
    s.modelCalls.map((m) => [m.inputTokens, m.cacheReadTokens, m.outputTokens, m.model]),
    [[500, 1500, 300, "gpt-5.2-codex"], [1500, 1500, 500, "gpt-5.2-codex"]],
    "fresh input is input minus cached; the duplicate total and the counter reset add nothing",
  );
  assert.ok(s.warnings.some((w) => /reset/.test(w)));
  assert.deepEqual(s.toolCalls.map((t) => [t.toolUseId, t.success]), [["call-1", true]]);
  assert.ok(s.warnings.some((w) => /without a recorded output/.test(w)));
  assert.ok(s.skippedRecords >= 2, "malformed and non-importable lines are counted, not fatal");
});

test("codex (current rollout): per-response records win, UserMessage items are prompts", async () => {
  const c = scanCodexSessions(CODEX_DIR).find((x) => x.file.includes("0002"))!;
  const out = await parseCandidate(c, ALL_CONTENT);
  assert.ok(out.ok && out.session);
  const s = out.session;
  assert.deepEqual(s.prompts.map((p) => [p.promptId, p.text]), [["um-1", "review the retry loop"]],
    "injected <environment_context> messages are not prompts");
  assert.deepEqual(
    s.modelCalls.map((m) => [m.responseId, m.inputTokens, m.cacheReadTokens, m.outputTokens, m.model]),
    [["resp_1", 8000, 20000, 140, "gpt-5.5"], ["resp_2", 1000, 28000, 60, "gpt-5.5"]],
    "token_count echoes of the same responses are ignored; a record with cached > input is refused",
  );
  assert.ok(s.warnings.some((w) => /cached than total/.test(w)));
  assert.deepEqual(s.toolCalls.map((t) => [t.toolUseId, t.toolName, t.success, t.input]), [
    ["call_a", "exec_command", false, "{\"cmd\":\"npm test\"}"],
  ], "the CommandExecution exit code supplies the verdict");
});

test("codex: in-memory text parsing matches", () => {
  const file = scanCodexSessions(CODEX_DIR).find((x) => x.file.includes("0002"))!.file;
  const s = parseCodexRolloutText(fs.readFileSync(file, "utf8"), { filePath: file })!;
  assert.equal(s.modelCalls.length, 2);
  assert.equal(s.sessionId, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002");
});

test("trimSessionToWindow keeps only in-window events and recomputes the span", async () => {
  const { session } = await claudeSession();
  const trimmed = trimSessionToWindow(session, ms("2026-10-01T11:00:00.000Z"), ms("2026-10-02T00:00:00.000Z"))!;
  assert.deepEqual(trimmed.prompts.map((p) => p.promptId), ["p-2"]);
  assert.deepEqual(trimmed.modelCalls.map((c) => c.responseId).sort(), ["req-3", "req-s1"]);
  assert.equal(trimmed.startMs, ms("2026-10-01T11:30:00.000Z"));
  assert.ok(trimmed.warnings.some((w) => /in-window/.test(w)));
  assert.equal(trimSessionToWindow(session, ms("2026-10-05T00:00:00.000Z"), ms("2026-10-06T00:00:00.000Z")), null);
  assert.equal(trimSessionToWindow(session, 0, Number.MAX_SAFE_INTEGER), session, "a session fully inside is untouched");
});
