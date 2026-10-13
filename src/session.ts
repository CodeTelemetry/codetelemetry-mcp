// Per-process onboarding session. This is the boundary that keeps the secret out
// of the model's context: the plaintext key lives ONLY here, reachable through
// `useKey()` (which the tools call internally to write the file / send events).
// Everything the model sees comes from `view()` — masked, never the plaintext.

import { mask, keyHash, looksLikeKey } from "./client/keys.ts";
import type { ExpectedKeyScope, KeyScope } from "./client/connectivity.ts";

export type KeySource = "device-flow" | "pasted";

export class OnboardingSession {
  // The one place the plaintext exists. Intentionally #private so it can't be
  // serialized into a tool result by accident.
  #key: string | null = null;

  keyHash: string | null = null;
  source: KeySource | null = null;
  ingestEndpoint: string | null = null;
  apiBase: string | null = null;
  deviceCode: string | null = null;
  userCode: string | null = null;
  lastProbeId: string | null = null;
  /** Set by authenticate when an organization was requested: the pending device
   *  code is scope-fenced, and only a key attested to this scope is kept. */
  pendingScope: ExpectedKeyScope | null = null;
  deviceScopeFenced = false;
  /** The scope the server attested for the held device-flow key. */
  keyScope: KeyScope | null = null;
  /** The organization the held key was accepted for; onboard and
   *  verify_telemetry check it again against the connectivity endpoint. */
  keyExpectedScope: ExpectedKeyScope | null = null;
  /** True once a model's `workspaceUrl` chose `apiBase` (rather than the host). */
  serverChosenByModel = false;

  setKey(plaintext: string, source: KeySource, ingestEndpoint?: string): void {
    if (!looksLikeKey(plaintext)) throw new Error("not a valid CodeTelemetry ingest key (expected cot_…)");
    this.#key = plaintext.trim();
    this.keyHash = keyHash(this.#key);
    this.source = source;
    if (ingestEndpoint) this.ingestEndpoint = ingestEndpoint;
    // A new key carries its own scope. A pasted key replaces any pending device
    // authorization, and was not issued for the organization it asked for.
    this.keyScope = null;
    this.keyExpectedScope = null;
    if (source === "pasted") {
      this.pendingScope = null;
      this.deviceCode = null;
      this.userCode = null;
      this.deviceScopeFenced = false;
    }
  }

  /** Drop the held key and everything tied to its server, e.g. when the session
   *  moves to a different CodeTelemetry server. */
  forgetKey(): void {
    this.#key = null;
    this.keyHash = null;
    this.source = null;
    this.keyScope = null;
    this.keyExpectedScope = null;
    this.ingestEndpoint = null;
    this.lastProbeId = null;
  }

  hasKey(): boolean {
    return this.#key !== null;
  }

  /** INTERNAL ONLY. Used to write the file / fire events. NEVER return this to a model. */
  useKey(): string {
    if (this.#key === null) throw new Error("no key in session — authenticate or provide a key first");
    return this.#key;
  }

  /** Model-safe view: masked key + hash + provenance. No plaintext, ever. */
  view(): { hasKey: boolean; masked: string | null; keyHash: string | null; source: KeySource | null } {
    return {
      hasKey: this.hasKey(),
      masked: this.#key ? mask(this.#key) : null,
      keyHash: this.keyHash,
      source: this.source,
    };
  }

  clear(): void {
    this.#key = null;
    this.keyHash = null;
    this.source = null;
    this.deviceCode = null;
    this.userCode = null;
    this.lastProbeId = null;
    this.pendingScope = null;
    this.deviceScopeFenced = false;
    this.keyScope = null;
    this.keyExpectedScope = null;
    this.serverChosenByModel = false;
  }
}
