// Programmatic surface of @codetelemetry/mcp — the tool registry + session, so
// the tools can be embedded or tested without the stdio transport.

export {
  TOOLS,
  TOOLS_BY_NAME,
  callTool,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./tools.ts";
export { OnboardingSession, type KeySource } from "./session.ts";
