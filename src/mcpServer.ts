// Builds the low-level MCP Server from the tool registry. Kept separate from the
// stdio entrypoint (server.ts) so it can be connected to any transport — stdio in
// production, an in-memory transport in tests.
//
// `tools/list` serves the MANIFEST verbatim (manifest.ts), so the inventory a
// client discovers, the inventory CI hashes, and the inventory the committed
// tool-manifest.json records are the same object by construction (ELL-47).
//
// Capabilities declare `tools` WITHOUT `listChanged`: the registry is fixed for a
// process's lifetime, so there is no notification to send. A client learns about
// new tools by starting a new server process — see README "Releases & discovery".

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool, type ToolContext } from "./tools.ts";
import { manifestEntries } from "./manifest.ts";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./version.ts";

const MCP_TOOL_RESPONSE_BYTES = 64 * 1024;
// Reserve the JSON-RPC envelope (jsonrpc/id/result) around the result object.
// IDs are client-controlled, so keep a finite margin instead of treating the
// inner result as the whole stdio message.
const MCP_JSONRPC_FRAMING_BYTES = 512;

/** `structuredContent` is convenient for clients, but it duplicates the text
 * result on the wire. Count the complete response here, after pretty-printing,
 * so a future tool cannot accidentally turn a 48 KiB projection into >64 KiB. */
function boundedToolResponse(result: Record<string, unknown>) {
  const make = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: value.ok === false,
  });
  const response = make(result);
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= MCP_TOOL_RESPONSE_BYTES - MCP_JSONRPC_FRAMING_BYTES) return response;
  const fallback = {
    ok: false,
    error: "response_budget_exceeded",
    state: typeof result.state === "string" ? result.state : "provider_failure",
    message: "The tool response exceeded the complete MCP response budget; retry with a narrower evidence selection.",
  };
  const bounded = make(fallback);
  // This is constant-shaped and should remain safely below the ceiling. Keeping
  // the assertion makes an accidental envelope expansion fail closed in tests.
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MCP_TOOL_RESPONSE_BYTES - MCP_JSONRPC_FRAMING_BYTES) throw new Error("MCP response budget invariant failed");
  return bounded;
}

export function buildServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: manifestEntries(TOOLS) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx);
    // ELL-198/200/272 responses are projection-derived but duplicated as text
    // and structured content by MCP, so keep their complete envelopes bounded.
    if (["interpret_session", "read_session_events", "compare_sessions", "plan_next_session", "seed_grader_config", "get_grader_config", "update_grader_config"].includes(req.params.name)) return boundedToolResponse(result);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: result.ok === false,
    };
  });

  return server;
}
