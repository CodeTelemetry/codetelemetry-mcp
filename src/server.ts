#!/usr/bin/env node
// stdio MCP server entrypoint. A coding agent launches this; it exposes the
// CodeTelemetry onboarding tools (see tools.ts). stdout is the MCP transport, so
// all human/log output goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcpServer.ts";
import { type ToolContext } from "./tools.ts";
import { OnboardingSession } from "./session.ts";

// One onboarding session per server process. The plaintext key never leaves it.
const ctx: ToolContext = {
  session: new OnboardingSession(),
  endpointsOverride: {
    apiBase: process.env.CODETELEMETRY_API_BASE,
    ingestEndpoint: process.env.CODETELEMETRY_INGEST_ENDPOINT,
  },
};

const server = buildServer(ctx);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("codetelemetry MCP server ready (stdio)\n");
