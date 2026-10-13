// Ingest-key helpers. The plaintext `cot_…` key is a secret: it belongs in
// ~/.claude/settings.json, never in a model's context or a log line. Everything
// here is about validating and *hiding* the key — `mask()` for display and
// `scrub()` as a last-line defence so an accidental interpolation into an error
// or tool result can't leak the secret.

import { createHash } from "node:crypto";

// Keys are minted server-side as "cot_" + base64url(24 bytes),
// i.e. ~32 url-safe chars after the prefix. Be lenient on the lower bound so a
// future key length still validates.
const KEY_RE = /^cot_[A-Za-z0-9_-]{16,}$/;

// Greedy global form for redaction — matches a key anywhere inside a larger
// string (e.g. inside an OTEL_EXPORTER_OTLP_HEADERS value or an error message).
const SECRET_RE = /cot_[A-Za-z0-9_-]{12,}/g;

export function looksLikeKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value.trim());
}

export function assertKey(value: unknown): string {
  if (!looksLikeKey(value)) {
    throw new Error("not a valid CodeTelemetry ingest key (expected cot_…)");
  }
  return (value as string).trim();
}

/** `cot_…b3F9` — safe to show a human or a model. Never reveals the body. */
export function mask(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("cot_") || value.length < 8) {
    return "cot_…";
  }
  return `cot_…${value.slice(-4)}`;
}

/** SHA-256 hex of the plaintext — what the backend stores and matches on. */
export function keyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Last-line defence: replace any embedded `cot_…` token with its mask. Run over
 * anything that could conceivably reach a model or a log (tool results, error
 * messages). It is NOT a substitute for never putting the key there in the first
 * place — it's a backstop.
 */
export function scrub(text: string): string {
  return text.replace(SECRET_RE, (m) => mask(m));
}
