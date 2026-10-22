// The connect package's view of the assistant registry.
//
// The registry itself is packages/api/src/semantics/assistantRegistry.ts. This
// package (and packages/mcp, which builds on it) is published to npm on its own
// and cannot import across the monorepo, so it keeps these literal twins of the
// registry's derived lists. packages/api/test/assistantRegistry.test.ts reads
// this file and fails when a list disagrees with the registry: change the
// registry first, then this file.

/** Clients onboarding can configure (`--client`, MCP `client`), in display
 *  order. Twin of the registry's ONBOARDING_CLIENT_IDS. */
export const ONBOARD_CLIENTS = ["claude", "codex", "pi", "kiro"] as const;
export type OnboardClient = (typeof ONBOARD_CLIENTS)[number];

export function isOnboardClient(value: unknown): value is OnboardClient {
  return typeof value === "string" && (ONBOARD_CLIENTS as readonly string[]).includes(value);
}

/** Assistants a session search can be filtered to. Twin of the registry's
 *  SESSION_FILTER_ASSISTANT_IDS. */
export const SESSION_FILTER_ASSISTANTS = ["claude", "codex", "kiro"] as const;
