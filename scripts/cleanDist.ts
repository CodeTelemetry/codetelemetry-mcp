// TypeScript does not remove outputs for source files that were deleted between
// builds. A stale module would therefore remain eligible for npm packing unless
// every publish build starts from an empty generated-output directory.

import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./paths.ts";

const dist = path.join(PKG_ROOT, "dist");
if (path.dirname(dist) !== PKG_ROOT || path.basename(dist) !== "dist") {
  throw new Error(`refusing to clean unexpected output path: ${dist}`);
}

fs.rmSync(dist, { recursive: true, force: true });
