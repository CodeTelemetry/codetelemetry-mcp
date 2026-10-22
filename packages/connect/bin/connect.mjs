#!/usr/bin/env node
import { run } from "@codetelemetry/mcp/cli";
process.exitCode = await run(process.argv.slice(2));
