// Test helpers.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function tmpSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cot-connect-"));
  return path.join(dir, ".claude", "settings.json");
}
