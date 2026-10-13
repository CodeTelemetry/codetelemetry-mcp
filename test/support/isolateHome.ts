// Loaded with `node --import` by every test script that can reach a config
// writer. The onboarding tools default to the developer's real client configs
// (~/.claude/settings.json and Codex's config.toml). A test that forgets its
// path override would point that machine's Claude Code or Codex at a throwaway
// loopback harness with a test key, silently stopping its telemetry. Every
// home-derived path resolves inside a fresh temporary directory instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cot-test-home-"));
process.env.HOME = home; // os.homedir() on POSIX
process.env.USERPROFILE = home; // os.homedir() on Windows
process.env.CODEX_HOME = path.join(home, ".codex"); // an inherited CODEX_HOME would win over the home default

if (os.homedir() !== home) {
  throw new Error(`test home isolation failed: os.homedir() is ${os.homedir()}, expected ${home}`);
}

process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
