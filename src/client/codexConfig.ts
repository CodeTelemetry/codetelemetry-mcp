// Write the OTEL exporter config into Codex's ~/.codex/config.toml `[otel]`
// section. Codex is configured via TOML, not env vars, and its `[otel]` headers
// are sent VERBATIM (no ${VAR} expansion) — so the literal ingest key must land
// in this file. That makes a careful writer more valuable here than for Claude:
// a hand-edited placeholder fails as a silent 401 with no client-side error.
//
// Zero-dependency by design (like the rest of this package): we splice the
// `[otel]` section textually instead of round-tripping a TOML parser, and
// refuse any file shape we can't edit provably-safely.
//
// The generated section uses single-line inline tables — the shape verified
// against Codex's TOML parser. TOML forbids newlines inside inline tables, so
// a "prettier" multi-line inline block would fail to parse.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertKey } from "./keys.ts";
import type { WriteResult } from "./settings.ts";
import {
  installCodexRepositoryObservationHook,
  removeCodexRepositoryObservationHook,
  validateCodexRepositoryObservationHook,
} from "./repositoryHook.ts";

/** Where Codex reads its config. An explicit path wins (tests, throwaways), then
 *  `CODEX_HOME` — Codex relocates its whole local state there, so writing
 *  `~/.codex/config.toml` for such a user would configure a file Codex never
 *  reads, and our probe (which uses the key we just minted, not the file) would
 *  still report success. */
export function resolveCodexConfigPath(opts: { path?: string; home?: string; codexHome?: string } = {}): string {
  if (opts.path) return path.resolve(opts.path);
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME;
  if (codexHome) return path.resolve(codexHome, "config.toml");
  return path.join(opts.home ?? os.homedir(), ".codex", "config.toml");
}

function exporterLine(kind: "exporter" | "trace_exporter" | "metrics_exporter", signal: "logs" | "traces" | "metrics", key: string, ingestEndpoint: string): string {
  return `${kind} = { otlp-http = { endpoint = "${ingestEndpoint}/v1/${signal}", protocol = "binary", headers = { authorization = "Bearer ${key}" } } }`;
}

/** The keys this writer owns and always regenerates. Everything else inside
 *  `[otel]` belongs to the user (`environment`, their own comments, …) and is
 *  preserved verbatim — the Claude path merges into the existing `env` block, and
 *  blowing the section away here would silently drop settings like
 *  `environment = "prod"` while "just" rotating the ingest key. */
const OWNED_KEYS = ["exporter", "trace_exporter", "metrics_exporter"];

const COMMENT_RE = /^\s*#/;

/** The `key` of a TOML assignment line, or null for comments/blanks.
 *
 *  Everything before the first `=` is the key (an inline-table VALUE also
 *  contains `=`, so only the first one delimits). Whitespace is then normalised
 *  away, because TOML accepts all of these as definitions of the same `exporter`:
 *    exporter = { … }
 *    exporter.otlp-http.endpoint = "…"
 *    exporter . otlp-http . endpoint = "…"
 *  Missing one spelling means a stale definition survives the merge and collides
 *  with the one we append, leaving a config Codex can't parse. (This is why the
 *  package still hand-rolls the narrow slice of TOML it needs rather than taking
 *  a parser dependency — the surface is small, but it has to be whitespace-exact.) */
function keyOf(line: string): string | null {
  if (COMMENT_RE.test(line)) return null;
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim().replace(/\s*\.\s*/g, ".");
  return key && /^[A-Za-z0-9_.\-"']+$/.test(key) ? key : null;
}

/** First segment of a (possibly dotted, possibly quoted) key — the table entry it
 *  actually defines. `exporter.otlp-http.endpoint` → `exporter`.
 *
 *  Quote-aware, because a dot INSIDE quotes is part of the name, not a separator:
 *  `"exporter.metadata"` is a single key of its own, not a child of `exporter`.
 *  Splitting first would classify it as ours and delete a setting we don't own. */
function rootKey(key: string): string {
  const q = key[0];
  if (q === '"' || q === "'") {
    const end = key.indexOf(q, 1);
    if (end !== -1) return key.slice(1, end);
  }
  return key.split(".")[0];
}

/** The exporter (and optional enrich) lines this writer emits. */
function ownedLines(key: string, ingestEndpoint: string, enrich: boolean): string[] {
  const lines: string[] = [];
  // Only ADD log_user_prompt under --enrich. Without it we neither add nor strip
  // the flag: an existing `log_user_prompt = true` is the user's choice to keep.
  if (enrich) lines.push("log_user_prompt = true");
  lines.push(
    exporterLine("exporter", "logs", key, ingestEndpoint),
    exporterLine("trace_exporter", "traces", key, ingestEndpoint),
    exporterLine("metrics_exporter", "metrics", key, ingestEndpoint),
  );
  return lines;
}

/**
 * The `[otel]` section for a file that doesn't have one yet. Codex sends only the
 * signals that have an exporter key, so all three are always written.
 */
export function buildOtelSection(key: string, ingestEndpoint: string, enrich: boolean): string {
  return ["[otel]", ...ownedLines(key, ingestEndpoint, enrich)].join("\n");
}

/**
 * Merge into an EXISTING `[otel]` body: drop the keys we own (so they don't end up
 * defined twice — a TOML parse error) and re-append them, leaving every other line
 * where the user put it.
 */
export function mergeOtelBody(body: string[], key: string, ingestEndpoint: string, enrich: boolean): string[] {
  const replaced = new Set(OWNED_KEYS);
  if (enrich) replaced.add("log_user_prompt");
  // Drop every form of the keys we own — including an expanded
  // `exporter.otlp-http.endpoint = …`, which would otherwise survive and then
  // collide with the inline `exporter = { … }` we append (TOML rejects the
  // duplicate definition, so a working config would stop parsing).
  const kept = body.filter((l) => {
    const k = keyOf(l);
    return k === null || !replaced.has(rootKey(k));
  });
  // Don't strand the user's trailing blank lines in the middle of the section.
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  return [...kept, ...ownedLines(key, ingestEndpoint, enrich)];
}

/** TOML keys the section sets (for model-safe/value-free reporting). */
function sectionKeys(enrich: boolean): string[] {
  return enrich ? ["log_user_prompt", ...OWNED_KEYS] : [...OWNED_KEYS];
}

/**
 * The normalised dotted name of a TOML table header, or null if the line isn't one.
 *
 * Parsed rather than regex-matched, because the name can be quoted and a quoted
 * name may contain anything — `[ otel ]`, `[ "otel" ]`, `["otel".exporter]` and
 * `["ui,settings"]` are all real headers. Every spelling missed here is a config
 * we'd mis-section: too strict and we append a second `[otel]` or attribute our
 * exporters to somebody else's table; too loose and an array row like `[1,2],`
 * ends the section early. So: quote-aware segmentation, and any UNQUOTED bracket
 * or comma means the line is array data, not a header.
 */
function headerName(line: string): string | null {
  const text = stripComment(line).trim();
  if (!text.startsWith("[")) return null;
  const arrayTable = text.startsWith("[[");
  const closer = arrayTable ? "]]" : "]";
  if (!text.endsWith(closer) || text.length <= (arrayTable ? 4 : 2)) return null;
  const inner = text.slice(arrayTable ? 2 : 1, text.length - closer.length);

  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && quote === '"') current += inner[++i] ?? "";
      else if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ".") {
      segments.push(current.trim());
      current = "";
    } else if (ch === "[" || ch === "]" || ch === ",") return null;
    else current += ch;
  }
  if (quote) return null; // unterminated quote — not a header we can trust
  segments.push(current.trim());
  return segments.some((s) => s === "") ? null : segments.join(".");
}

const isHeader = (line: string): boolean => headerName(line) !== null;
const isOtelHeader = (line: string): boolean => headerName(line) === "otel";
const isOtelSubtable = (line: string): boolean => (headerName(line) ?? "").startsWith("otel.");

/** TOML's multi-line string fences. Their contents can hold anything — including a
 *  line that reads exactly `[otel]` — and this scanner is line-at-a-time, so a file
 *  using them is outside the envelope we can edit provably-safely. We refuse such
 *  files rather than grow cross-line string state into the hand-rolled parser:
 *  guessing wrong here rewrites somebody's working config. */
const MULTILINE_STRING_RE = /"""|'''/;

/** A line's structure with comments and single-line quoted strings removed, so
 *  bracket counting can't be thrown off by a `#` or a bracket inside a string.
 *  (Multi-line strings are refused before this runs — see MULTILINE_STRING_RE.) */
function structuralOnly(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++; // escape only applies in basic strings
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") break; // rest of the line is a comment
    else out += ch;
  }
  return out;
}

/** Net bracket/brace nesting a line opens (+) or closes (−). */
function depthDelta(line: string): number {
  let d = 0;
  for (const ch of structuralOnly(line)) {
    if (ch === "[" || ch === "{") d++;
    else if (ch === "]" || ch === "}") d--;
  }
  return d;
}

/**
 * Locate the `[otel]` section as a line range, or null when there is none.
 *
 * Depth-aware on purpose: a *value* can span lines and contain header-shaped
 * rows (`arr = [` / `[1]` / `]` is valid TOML). Treating that `[1]` as a section
 * boundary would splice our exporters into the middle of the array and leave the
 * rest of the body outside the section — a corrupt file. Only a line at nesting
 * depth 0 can be a table header.
 */
function findOtelSection(lines: string[]): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (depth === 0) {
      if (start === -1) {
        if (isOtelHeader(lines[i])) start = i;
      } else if (i > start && isHeader(lines[i])) {
        return { start, end: i };
      }
    }
    depth = Math.max(0, depth + depthDelta(lines[i]));
  }
  return start === -1 ? null : { start, end: lines.length };
}

/** Whether the file declares an `[otel.*]` sub-table at top level (see the refusal
 *  in writeCodexConfig). Depth-aware for the same reason as findOtelSection. */
function hasOtelSubtable(lines: string[]): boolean {
  let depth = 0;
  for (const line of lines) {
    if (depth === 0 && isOtelSubtable(line)) return true;
    depth = Math.max(0, depth + depthDelta(line));
  }
  return false;
}

/** Split on either line ending, and report which one the file predominantly uses
 *  so a rewritten CRLF file doesn't come back with mixed endings. */
function splitLines(raw: string): { lines: string[]; eol: string } {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  return { lines: raw.split(/\r?\n/), eol: crlf > lf ? "\r\n" : "\n" };
}

export type CodexWriteOptions = {
  key: string;
  ingestEndpoint: string;
  configPath: string;
  enrich?: boolean;
  /** Install lifecycle/tool hooks that send repository/workspace metadata (default false). */
  repositoryObservation?: boolean;
  /** Back up an existing file to config.toml.bak before overwriting (default true). */
  backup?: boolean;
};

export function writeCodexConfig(opts: CodexWriteOptions): WriteResult {
  const key = assertKey(opts.key);
  const filePath = path.resolve(opts.configPath);
  const existed = fs.existsSync(filePath);
  const raw = existed ? fs.readFileSync(filePath, "utf8") : "";

  const { lines, eol } = splitLines(raw);

  // `[otel.x]` standard sub-tables would collide with the inline exporter keys we
  // write (duplicate definition → Codex-side parse error). We can't merge those
  // textually with confidence, so refuse loudly rather than corrupt the config.
  if (lines.some((l) => MULTILINE_STRING_RE.test(l))) {
    throw new Error(
      `refusing to edit ${filePath}: it uses a multi-line TOML string (""" or '''), whose contents ` +
        `this writer can't tell apart from real section headers. Configure the [otel] section by hand ` +
        `(https://codetelemetry.com/docs/data-sources/openai-codex), or remove the multi-line string and retry.`,
    );
  }

  if (hasOtelSubtable(lines)) {
    throw new Error(
      `refusing to edit ${filePath}: it defines [otel.*] sub-tables this writer can't safely merge. ` +
        `Remove or inline them, then retry.`,
    );
  }

  // Only inspect/mutate the separate hooks file after an explicit repository-
  // observation opt-in. Plain telemetry setup must not be blocked by an
  // unrelated malformed hooks.json, nor silently install path-reporting hooks.
  if (opts.repositoryObservation) validateCodexRepositoryObservationHook(filePath);
  else removeCodexRepositoryObservationHook(filePath);

  const section = findOtelSection(lines);

  let out: string[];
  if (section === null) {
    // No [otel] yet → append as a new top-level section. A trailing key-value in
    // the file belongs to whatever section precedes it; a fresh header is safe.
    // Drop the trailing empty element from a file ending in a newline so we don't
    // accumulate blank lines on repeat writes.
    const fresh = buildOtelSection(key, opts.ingestEndpoint, !!opts.enrich).split("\n");
    const body = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    out = body.length ? [...body, "", ...fresh] : [...fresh];
  } else {
    // Merge into the existing [otel] section, leaving everything we don't own put.
    const { start, end } = section;
    const merged = mergeOtelBody(lines.slice(start + 1, end), key, opts.ingestEndpoint, !!opts.enrich);
    out = [...lines.slice(0, start), lines[start], ...merged, ...lines.slice(end)];
  }
  // Always terminate with exactly one newline, in the file's own ending.
  const next = out.join(eol).replace(/(\r?\n)+$/, "") + eol;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let backupPath: string | null = null;
  if (existed && opts.backup !== false) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }

  // 0600 — the file now holds a live ingest key (also what the docs tell users
  // to chmod it to by hand).
  fs.writeFileSync(filePath, next, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort (e.g. non-POSIX fs) */
  }

  if (opts.repositoryObservation) installCodexRepositoryObservationHook(filePath);

  return { path: filePath, wrote: sectionKeys(!!opts.enrich), backupPath, created: !existed };
}

/** The body lines of the `[otel]` section (empty when there is none). Both readers
 *  scope to this rather than the whole file: an unrelated section (e.g. an
 *  `[mcp_servers.*.env]` holding another service's token) must not be mistaken for
 *  the telemetry config `doctor` is about to re-test. */
function otelSectionLines(raw: string): string[] {
  const { lines } = splitLines(raw);
  // Same envelope as the writer: with a multi-line string in play we can't locate
  // the section reliably, and reporting a key we aren't sure is live would let
  // `doctor` claim a working setup off the wrong config. Report nothing instead —
  // the caller's "no active key, run connect first" is the safe failure.
  if (lines.some((l) => MULTILINE_STRING_RE.test(l))) return [];
  const section = findOtelSection(lines);
  return section === null ? [] : lines.slice(section.start + 1, section.end);
}

/** The ACTIVE assignment lines of `[otel]` — commented-out lines excluded. A key
 *  sitting in a `# exporter = …` line configures nothing, so treating it as live
 *  would let `doctor` probe successfully and report a working setup for a config
 *  Codex isn't exporting from at all. */
function activeOtelLines(raw: string): string[] {
  return otelSectionLines(raw).filter((l) => keyOf(l) !== null);
}

/** Drop a line's trailing comment, respecting quotes so a `#` inside a string
 *  stays put. Unlike structuralOnly this KEEPS string contents — the bearer token
 *  we're looking for lives inside one. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** The exporter assignments only, comments stripped — the sole place a LIVE ingest
 *  key can sit. Scanning anything wider (a stale token in a trailing comment, or an
 *  unrelated value that happens to contain one) would let `doctor` probe that token
 *  successfully and report a working setup for a config with no active exporter. */
function exporterKeyText(raw: string): string {
  return activeOtelLines(raw)
    .filter((l) => {
      const k = keyOf(l);
      return k !== null && OWNED_KEYS.includes(rootKey(k));
    })
    .map(stripComment)
    .join("\n");
}

/** Read back the configured ingest key (for `doctor`). Null when absent. */
export function readCodexKey(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  const m = exporterKeyText(fs.readFileSync(configPath, "utf8")).match(/Bearer\s+(cot_[A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Value-free summary of the [otel] section (for `status`). No secrets. */
export function readCodexSummary(configPath: string): { exists: boolean; otelKeys: string[]; hasKey: boolean } {
  if (!fs.existsSync(configPath)) return { exists: false, otelKeys: [], hasKey: false };
  const raw = fs.readFileSync(configPath, "utf8");
  const otelKeys = activeOtelLines(raw)
    .map((l) => keyOf(l))
    .filter((k): k is string => k !== null);
  return { exists: true, otelKeys, hasKey: /Bearer\s+cot_/.test(exporterKeyText(raw)) };
}

/** Whether the ACTIVE [otel] section opts in to prompt text
 *  (`log_user_prompt = true`) — the Codex twin of OTEL_LOG_USER_PROMPTS, read by
 *  `import --content live` so a history import never exports more than live does. */
export function readCodexLogUserPrompt(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  return activeOtelLines(fs.readFileSync(configPath, "utf8")).some(
    (l) => keyOf(l) === "log_user_prompt" && /=\s*true$/.test(stripComment(l).trimEnd()),
  );
}
