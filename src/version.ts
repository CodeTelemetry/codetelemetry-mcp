// The server identity a client sees on `initialize` — and the ONE place it is
// written. It used to be a literal inside buildServer(), decoupled from
// package.json, so a client had no way to tell which BUILD of the registry it
// was talking to: two different tool inventories both reported "0.1.0".
//
// Keep this in lockstep with package.json's `version` — test/manifest.test.ts
// fails the build if they drift, because the version is what a customer pins in
// `.mcp.json` and what the release automation compares against npm.
export const MCP_SERVER_NAME = "codetelemetry";
export const MCP_SERVER_VERSION = "0.3.9";
