// Regenerate the committed tool manifest from the source registry.
//
//   npm run manifest:write
//
// Run this after INTENTIONALLY changing the tool surface, then commit the diff —
// which is the point: a new tool, a renamed argument, or a reworded description
// shows up as a reviewable change to the inventory customers discover, instead of
// silently diverging from what is published. `verify:registry` fails until it is
// regenerated, so this is never optional.

import fs from "node:fs";
import { TOOLS } from "../src/tools.ts";
import { toolManifest } from "../src/manifest.ts";
import { MANIFEST_PATH } from "./paths.ts";

const manifest = toolManifest(TOOLS);
fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(
  `wrote ${MANIFEST_PATH}\n  version ${manifest.serverVersion} · ${manifest.toolCount} tools · registryHash ${manifest.registryHash}\n`,
);
