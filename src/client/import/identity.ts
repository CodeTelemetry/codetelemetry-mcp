// Who an imported session belongs to (ELL-655, C5). Live exporters stamp
// identity on every record; imported history must carry the SAME attributes,
// or the dashboards' member / team attribution would treat a user's past
// sessions as someone else's. Node only (the CLI and the MCP tool); a browser
// upload passes just an email.
//
//   Claude Code (as it builds them from ~/.claude.json, or
//   $CLAUDE_CONFIG_DIR/.claude.json):
//     organization.id     ← oauthAccount.organizationUuid
//     user.email          ← oauthAccount.emailAddress
//     user.account_uuid   ← oauthAccount.accountUuid   (unless OTEL_METRICS_INCLUDE_ACCOUNT_UUID is off)
//     user.account_id     ← $CLAUDE_CODE_ACCOUNT_TAGGED_ID, else the tagged form
//                           of accountUuid: "user_01" + 22-char base58 of the
//                           128-bit uuid (Claude Code's own encoding)
//     user.id             ← userID (the installation id)
//   Codex (~/.codex/auth.json or $CODEX_HOME/auth.json, ChatGPT sign-in):
//     user.email          ← tokens.id_token payload `email`
//     user.account_id     ← id_token `https://api.openai.com/auth`.chatgpt_account_id
//                           (else tokens.account_id)
//
// The id token is decoded, never verified, and never logged or returned;
// only the claims above leave this module. API-key sign-ins carry no identity.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IdentityBySource, ImportIdentity, ImportSource } from "./model.ts";
import { defaultClaudeSettingsPath } from "./sources/files.ts";

/** ~/.claude.json holds project history too, so it can be several MB. */
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const MAX_AUTH_BYTES = 1024 * 1024;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Anthropic's tagged id (`user_01…`) for a uuid, as Claude Code derives
 *  user.account_id; undefined for anything that is not a 128-bit uuid. */
export function taggedId(tag: string, uuid: string): string | undefined {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined;
  const out = Array<string>(22).fill("1");
  let n = BigInt("0x" + hex);
  for (let i = 21; n > 0n && i >= 0; i--) {
    out[i] = BASE58[Number(n % 58n)];
    n /= 58n;
  }
  return `${tag}_01${out.join("")}`;
}

/** Where Claude Code keeps its global config (account + installation id). */
export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR || undefined;
  // Older installs kept it as .config.json inside the config directory; Claude
  // Code still prefers that file when it exists.
  const legacy = path.join(dir ?? path.join(home, ".claude"), ".config.json");
  if (fs.existsSync(legacy)) return legacy;
  return path.join(dir ?? home, ".claude.json");
}

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.CODEX_HOME ? path.join(env.CODEX_HOME, "auth.json") : path.join(home, ".codex", "auth.json");
}

function readJson(file: string, maxBytes: number): Record<string, unknown> | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]{1,128}@[^\s@]{1,190}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const email = (v: unknown): string | undefined => (typeof v === "string" && EMAIL_RE.test(v.trim()) ? v.trim() : undefined);
const id = (v: unknown): string | undefined => (typeof v === "string" && ID_RE.test(v) ? v : undefined);
const off = (v: unknown): boolean => typeof v === "string" && /^(false|0|no|off)$/i.test(v.trim());

const compact = (attrs: Record<string, string | undefined>): ImportIdentity => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v) out[k] = v;
  return out;
};

/** Claude Code's live identity attributes for this machine's signed-in account. */
export function readClaudeIdentity(opts: { configPath?: string; settingsPath?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): ImportIdentity {
  const env = opts.env ?? process.env;
  const config = readJson(opts.configPath ?? claudeGlobalConfigPath(env, opts.home), MAX_CLAUDE_CONFIG_BYTES);
  if (!config) return {};
  const account = config.oauthAccount && typeof config.oauthAccount === "object" ? (config.oauthAccount as Record<string, unknown>) : {};
  const settings = readJson(opts.settingsPath ?? defaultClaudeSettingsPath(env, opts.home), MAX_AUTH_BYTES);
  const settingsEnv = settings?.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const includeUuid = !off(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID) && !off(settingsEnv.OTEL_METRICS_INCLUDE_ACCOUNT_UUID);
  const accountUuid = id(account.accountUuid);
  const tagged = id(env.CLAUDE_CODE_ACCOUNT_TAGGED_ID ?? settingsEnv.CLAUDE_CODE_ACCOUNT_TAGGED_ID) ??
    (accountUuid ? taggedId("user", accountUuid) : undefined);
  return compact({
    "organization.id": id(account.organizationUuid),
    "user.account_id": includeUuid ? tagged : undefined,
    "user.account_uuid": includeUuid ? accountUuid : undefined,
    "user.email": email(account.emailAddress),
    "user.id": id(config.userID),
  });
}

/** The JWT payload, decoded without verification (identity claims only). */
function jwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length > 64 * 1024) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Codex's live identity attributes for a ChatGPT sign-in. */
export function readCodexIdentity(opts: { authPath?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): ImportIdentity {
  const auth = readJson(opts.authPath ?? codexAuthPath(opts.env ?? process.env, opts.home), MAX_AUTH_BYTES);
  const tokens = auth?.tokens && typeof auth.tokens === "object" ? (auth.tokens as Record<string, unknown>) : null;
  if (!tokens) return {};
  const claims = jwtPayload(tokens.id_token) ?? {};
  const openai = claims["https://api.openai.com/auth"];
  const authClaims = openai && typeof openai === "object" ? (openai as Record<string, unknown>) : {};
  const profile = claims["https://api.openai.com/profile"];
  const profileClaims = profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {};
  return compact({
    "user.account_id": id(authClaims.chatgpt_account_id) ?? id(tokens.account_id),
    "user.email": email(claims.email) ?? email(profileClaims.email),
  });
}

export type IdentityResolveOptions = {
  source: ImportSource | "all";
  /** --no-identity: stamp nothing (an explicit --email still applies). */
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  claudeConfigPath?: string;
  claudeSettingsPath?: string;
  codexAuthPath?: string;
};

/** The identity the CLI and MCP import stamp, per source in scope. */
export function resolveImportIdentity(opts: IdentityResolveOptions): IdentityBySource {
  if (opts.disabled) return {};
  const out: IdentityBySource = {};
  if (opts.source !== "codex") {
    const claude = readClaudeIdentity({ configPath: opts.claudeConfigPath, settingsPath: opts.claudeSettingsPath, env: opts.env, home: opts.home });
    if (Object.keys(claude).length) out["claude-code"] = claude;
  }
  if (opts.source !== "claude-code") {
    const codex = readCodexIdentity({ authPath: opts.codexAuthPath, env: opts.env, home: opts.home });
    if (Object.keys(codex).length) out.codex = codex;
  }
  return out;
}
