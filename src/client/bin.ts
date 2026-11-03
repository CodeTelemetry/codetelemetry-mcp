#!/usr/bin/env node
import { run } from "./cli.ts";
import { scrub } from "./keys.ts";
try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    scrub(`CodeTelemetry: ${String((error as Error).message)}\n`),
  );
  process.exitCode = 1;
}
