// The one edit Connect makes inside Cursor's own directory: one entry under each
// of six events in the user's hooks.json. The file belongs to the user, so the
// edit is made in the text, not by re-serializing: every byte Connect did not
// add stays as it was, and removing the entries restores the bytes that were
// there before. A file that cannot be edited that way is refused unchanged, with
// the entries printed for pasting by hand.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isSafeCursorPath, syncCursorDirectory, writeCursorTemporary } from "./config.ts";
import { CURSOR_HOOK_EVENTS } from "./hookProgram.ts";

/** An entry is Connect's when its command contains this. */
export const CURSOR_HOOK_MARKER = "/codetelemetry/cursor-hooks-v1/hook";
export const CURSOR_HOOK_TIMEOUT_SECONDS = 5;
export const CURSOR_HOOKS_FILE_BYTES = 1024 * 1024;

export type CursorHooksRefusalReason =
  | "symlink" | "not_a_file" | "unreadable" | "too_large" | "comments" | "invalid_json" | "shape" | "unsafe_command" | "changed" | "unwritable" | "merge";

/** hooks.json was left exactly as it was; `message` says why and what to paste. */
export class CursorHooksRefusal extends Error {
  reason: CursorHooksRefusalReason;
  constructor(reason: CursorHooksRefusalReason, message: string) {
    super(message);
    this.name = "CursorHooksRefusal";
    this.reason = reason;
  }
}

type HooksDocument = Record<string, unknown> & { version: 1; hooks: Record<string, unknown[]> };
type Current = { bytes: Buffer; text: string; mode: number; ino: number; size: number; mtimeMs: number };
type Item = { start: number; end: number };
type Member = Item & { key: string; colon: string; valueStart: number };
type Container<T extends Item> = { open: number; close: number; items: T[] };
type Edit = { start: number; end: number; text: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isOurs = (entry: unknown): boolean =>
  isRecord(entry) && typeof entry.command === "string" && entry.command.includes(CURSOR_HOOK_MARKER);

const entryFor = (command: string) => ({ command, timeout: CURSOR_HOOK_TIMEOUT_SECONDS });

/** The six entries as text to paste under "hooks" by hand. */
export function cursorHooksManualBlock(command: string): string {
  const entry = `{ "command": ${JSON.stringify(command)}, "timeout": ${CURSOR_HOOK_TIMEOUT_SECONDS} }`;
  return [
    '"hooks": {',
    CURSOR_HOOK_EVENTS.map(event => `  ${JSON.stringify(event)}: [${entry}]`).join(",\n"),
    "}",
  ].join("\n");
}

function refuse(reason: CursorHooksRefusalReason, file: string, cause: string, command?: string): CursorHooksRefusal {
  const manual = command === undefined ? "" : [
    "",
    "",
    "To add the hooks yourself, put these six entries under \"hooks\" in that file. Where an event already has entries, add the CodeTelemetry entry to its list and keep yours:",
    "",
    cursorHooksManualBlock(command),
    "",
    "Then run the command again with --hooks-manual, which installs everything except this edit.",
  ].join("\n");
  return new CursorHooksRefusal(reason, `${file} was not changed: ${cause}${manual}`);
}

/** Read without following a link, within the size bound. */
function readCurrent(file: string, command?: string): Current | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw refuse("unreadable", file, "it cannot be read.", command);
  }
  if (stat.isSymbolicLink()) {
    throw refuse("symlink", file, "it is a symbolic link (for example into a dotfiles repository), and replacing the file would break the link.", command);
  }
  if (!stat.isFile()) throw refuse("not_a_file", file, "it is not a regular file.", command);
  if (stat.size > CURSOR_HOOKS_FILE_BYTES) throw refuse("too_large", file, "it is larger than 1 MiB.", command);
  let bytes: Buffer;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > CURSOR_HOOKS_FILE_BYTES) throw new Error("changed");
      stat = opened;
      const buffer = Buffer.alloc(opened.size + 1);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (read !== opened.size) throw new Error("changed");
      bytes = buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw refuse("unreadable", file, "it cannot be read.", command);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw refuse("invalid_json", file, "it is not valid JSON.", command);
  }
  return { bytes, text, mode: stat.mode & 0o7777, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** End of the JSON string that opens at `start` (index after its closing quote). */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/** Cursor reads hooks.json as JSON with comments and trailing commas. This
 *  reduces such a file to strict JSON for reading only; Connect never writes
 *  the result back. */
function stripComments(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const kept: string[] = [];
  let from = 0, i = 0;
  const cut = (to: number, resume: number) => {
    kept.push(text.slice(from, to));
    from = resume;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') i = stringEnd(text, i);
    else if (ch === "/" && text[i + 1] === "/") {
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      cut(i, end);
      i = end;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2), end = close < 0 ? text.length : close + 2;
      cut(i, end);
      kept.push(" ");
      i = end;
    } else i++;
  }
  kept.push(text.slice(from));
  const bare = kept.join("");
  const out: string[] = [];
  from = 0;
  for (i = 0; i < bare.length;) {
    if (bare[i] === '"') {
      i = stringEnd(bare, i);
      continue;
    }
    if (bare[i] === ",") {
      let next = i + 1;
      while (next < bare.length && " \t\r\n".includes(bare[next]!)) next++;
      if (bare[next] === "}" || bare[next] === "]") {
        out.push(bare.slice(from, i));
        from = i + 1;
      }
    }
    i++;
  }
  out.push(bare.slice(from));
  return out.join("");
}

function hasShape(value: unknown): value is HooksDocument {
  return isRecord(value) && value.version === 1 && isRecord(value.hooks) && Object.values(value.hooks).every(Array.isArray);
}

function parseStrict(file: string, text: string, command?: string): HooksDocument {
  if (text.charCodeAt(0) === 0xfeff) throw refuse("invalid_json", file, "it starts with a byte order mark, which strict JSON does not allow.", command);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    let lenient = false;
    try {
      JSON.parse(stripComments(text));
      lenient = true;
    } catch {
      /* not JSON in either reading */
    }
    throw lenient
      ? refuse("comments", file, "it contains comments or trailing commas. Cursor accepts those, but Connect only rewrites a file it can reproduce exactly.", command)
      : refuse("invalid_json", file, "it is not valid JSON.", command);
  }
  if (!hasShape(value)) {
    throw refuse("shape", file, 'it does not have the expected shape ({"version": 1, "hooks": {"<event>": [...]}}).', command);
  }
  return value;
}

const skipSpace = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  return i;
};

/** End of the JSON value that starts at `start`. The text has already parsed,
 *  so this only needs to find the boundary, and it does so without recursion. */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let i = start; i < text.length;) {
      const ch = text[i];
      if (ch === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
      i++;
    }
    throw new Error("unterminated value");
  }
  let end = start;
  while (end < text.length && !",]} \t\r\n".includes(text[end]!)) end++;
  if (end === start) throw new Error("missing value");
  return end;
}

function scanObject(text: string, open: number): Container<Member> {
  if (text[open] !== "{") throw new Error("expected an object");
  const items: Member[] = [];
  let i = skipSpace(text, open + 1);
  while (text[i] !== "}") {
    if (text[i] !== '"') throw new Error("expected a key");
    const keyEnd = stringEnd(text, i), afterKey = skipSpace(text, keyEnd);
    if (text[afterKey] !== ":") throw new Error("expected a colon");
    const valueStart = skipSpace(text, afterKey + 1), end = valueEnd(text, valueStart);
    items.push({ key: JSON.parse(text.slice(i, keyEnd)), start: i, end, colon: text.slice(keyEnd, valueStart), valueStart });
    const next = skipSpace(text, end);
    if (text[next] === ",") i = skipSpace(text, next + 1);
    else if (text[next] === "}") i = next;
    else throw new Error("expected a separator");
  }
  return { open, close: i, items };
}

function scanArray(text: string, open: number): Container<Item> {
  if (text[open] !== "[") throw new Error("expected an array");
  const items: Item[] = [];
  let i = skipSpace(text, open + 1);
  while (text[i] !== "]") {
    const end = valueEnd(text, i);
    items.push({ start: i, end });
    const next = skipSpace(text, end);
    if (text[next] === ",") i = skipSpace(text, next + 1);
    else if (text[next] === "]") i = next;
    else throw new Error("expected a separator");
  }
  return { open, close: i, items };
}

/** Root and "hooks" members with their positions. A repeated key has no single
 *  position to edit, so it is an error here and a refusal to the caller. */
function scanHooks(text: string): { root: Container<Member>; hooksMember: Member; hooks: Container<Member> } {
  const root = scanObject(text, skipSpace(text, 0));
  const found = root.items.filter(member => member.key === "hooks");
  if (found.length !== 1) throw new Error("repeated key");
  const hooks = scanObject(text, found[0]!.valueStart);
  if (new Set(hooks.items.map(member => member.key)).size !== hooks.items.length) throw new Error("repeated key");
  return { root, hooksMember: found[0]!, hooks };
}

function applyEdits(text: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text, limit = text.length + 1;
  for (const edit of ordered) {
    if (edit.end > limit || edit.start > edit.end || (edit.end === limit && edit.start === edit.end)) throw new Error("overlapping edits");
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    limit = edit.start;
  }
  return out;
}

/** Deletions that drop the marked items from a list together with one
 *  separator each: the one before the item, or the one after it while no kept
 *  item precedes it. Removing an item appended after a kept one therefore
 *  deletes exactly what appending inserted. */
function removals(container: Container<Item>, drop: boolean[]): Edit[] {
  const { items } = container, firstKept = drop.indexOf(false);
  if (firstKept < 0) return items.length ? [{ start: container.open + 1, end: container.close, text: "" }] : [];
  const edits: Edit[] = [];
  items.forEach((item, index) => {
    if (!drop[index]) return;
    edits.push(index < firstKept
      ? { start: item.start, end: items[index + 1]!.start, text: "" }
      : { start: items[index - 1]!.end, end: item.end, text: "" });
  });
  return edits;
}

/** Which event keys Connect added to the file. `null` when that was never
 *  recorded: every key whose list holds only Connect's entries then counts. */
type CreatedKeys = readonly string[] | null;
const createdKey = (created: CreatedKeys, event: string): boolean => created === null || created.includes(event);

/** The text without Connect's entries under `events` (every event when null).
 *  An event whose list held nothing else is removed with its key when Connect
 *  added the key, and left as the empty list the user had there otherwise. */
function withoutOurs(text: string, document: HooksDocument, events: readonly string[] | null, created: CreatedKeys): string {
  const { hooks } = scanHooks(text), edits: Edit[] = [];
  const dropMember = hooks.items.map(member => {
    if (events && !events.includes(member.key)) return false;
    const entries = document.hooks[member.key]!, list = scanArray(text, member.valueStart);
    if (list.items.length !== entries.length) throw new Error("positions disagree with the parsed file");
    const drop = entries.map(isOurs);
    if (!drop.includes(true)) return false;
    if (!drop.includes(false) && createdKey(created, member.key)) return true;
    edits.push(...removals(list, drop));
    return false;
  });
  edits.push(...removals(hooks, dropMember));
  return applyEdits(text, edits);
}

function expectedWithoutOurs(text: string, events: readonly string[] | null, created: CreatedKeys): HooksDocument {
  const document = JSON.parse(text) as HooksDocument;
  for (const [event, entries] of Object.entries(document.hooks)) {
    if ((events && !events.includes(event)) || !entries.some(isOurs)) continue;
    const kept = entries.filter(entry => !isOurs(entry));
    if (kept.length || !createdKey(created, event)) document.hooks[event] = kept;
    else delete document.hooks[event];
  }
  return document;
}

const lineStart = (text: string, position: number): number => text.lastIndexOf("\n", position - 1) + 1;
const lineIndent = (text: string, position: number): string => /^[ \t]*/.exec(text.slice(lineStart(text, position), position))![0];
const opensLine = (text: string, position: number): boolean => /^[ \t]*$/.test(text.slice(lineStart(text, position), position));

/** The text with Connect's entry appended under each of the six events, written
 *  the way the file is already written: its indentation and line ends where it
 *  spans lines, one line where it does not. `text` holds no entry of ours. */
function withOurs(text: string, command: string): string {
  const { root, hooksMember, hooks } = scanHooks(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const tight = root.items[0]?.colon === ":";
  const first = hooks.items[0] ?? root.items[0]!, outer = hooks.items[0] ? hooksMember : null;
  const outerIndent = outer ? lineIndent(text, outer.start) : "";
  const firstIndent = lineIndent(text, first.start);
  const unit = opensLine(text, first.start) && firstIndent.length > outerIndent.length && firstIndent.startsWith(outerIndent)
    ? firstIndent.slice(outerIndent.length) : "  ";
  const inline = tight
    ? JSON.stringify(entryFor(command))
    : `{ "command": ${JSON.stringify(command)}, "timeout": ${CURSOR_HOOK_TIMEOUT_SECONDS} }`;
  const block = (indent: string) => [
    "{", `${indent}${unit}"command": ${JSON.stringify(command)},`, `${indent}${unit}"timeout": ${CURSOR_HOOK_TIMEOUT_SECONDS}`, `${indent}}`,
  ].join(newline);
  const blockMember = (event: string, indent: string) =>
    `${JSON.stringify(event)}: [${newline}${indent}${unit}${block(indent + unit)}${newline}${indent}]`;
  const inlineMember = (event: string) => `${JSON.stringify(event)}:${tight ? "" : " "}[${inline}]`;

  const edits: Edit[] = [], added: string[] = [];
  for (const event of CURSOR_HOOK_EVENTS) {
    const member = hooks.items.find(candidate => candidate.key === event);
    if (!member) {
      added.push(event);
      continue;
    }
    const list = scanArray(text, member.valueStart), last = list.items.at(-1);
    if (last) {
      // Insert after the last entry; the text between it and the bracket stays.
      if (text.slice(last.end, list.close).includes("\n")) {
        const indent = opensLine(text, last.start) ? lineIndent(text, last.start) : lineIndent(text, member.start) + unit;
        edits.push({ start: last.end, end: last.end, text: `,${newline}${indent}${block(indent)}` });
      } else edits.push({ start: last.end, end: last.end, text: `,${tight ? "" : " "}${inline}` });
    } else if (text.includes("\n") && opensLine(text, member.start)) {
      const indent = lineIndent(text, member.start);
      edits.push({ start: list.open + 1, end: list.close, text: `${newline}${indent}${unit}${block(indent + unit)}${newline}${indent}` });
    } else edits.push({ start: list.open + 1, end: list.close, text: inline });
  }
  const lastMember = hooks.items.at(-1);
  if (added.length && lastMember) {
    if (text.slice(lastMember.end, hooks.close).includes("\n")) {
      const indent = opensLine(text, lastMember.start) ? lineIndent(text, lastMember.start) : lineIndent(text, hooksMember.start) + unit;
      edits.push({ start: lastMember.end, end: lastMember.end, text: added.map(event => `,${newline}${indent}${blockMember(event, indent)}`).join("") });
    } else {
      edits.push({ start: lastMember.end, end: lastMember.end, text: added.map(event => `,${tight ? "" : " "}${inlineMember(event)}`).join("") });
    }
  } else if (added.length && text.includes("\n") && opensLine(text, hooksMember.start)) {
    const indent = lineIndent(text, hooksMember.start);
    edits.push({ start: hooks.open + 1, end: hooks.close,
      text: `${newline}${added.map(event => `${indent}${unit}${blockMember(event, indent + unit)}`).join(`,${newline}`)}${newline}${indent}` });
  } else if (added.length) {
    edits.push({ start: hooks.open + 1, end: hooks.close, text: added.map(inlineMember).join(tight ? "," : ", ") });
  }
  return applyEdits(text, edits);
}

function expectedWithOurs(text: string, command: string, created: CreatedKeys): HooksDocument {
  const document = expectedWithoutOurs(text, CURSOR_HOOK_EVENTS, created);
  for (const event of CURSOR_HOOK_EVENTS) document.hooks[event] = [...(document.hooks[event] ?? []), entryFor(command)];
  return document;
}

const EMPTY_FILE = '{\n  "version": 1,\n  "hooks": {}\n}\n';

/** What the file should become, or a refusal. Both edits are checked against
 *  the same change made to the parsed value: text that does not parse back to
 *  exactly that is never written. */
function planInstall(file: string, command: string, created: CreatedKeys): { current: Current | null; next: string; createdKeys: string[] } {
  if (!isSafeCursorPath(command)) {
    throw refuse("unsafe_command", file, `Cursor runs hook commands through a shell without quoting, and the hook path ${JSON.stringify(command)} contains characters a shell would split or expand (for example a space in the home directory).`);
  }
  if (!command.includes(CURSOR_HOOK_MARKER)) {
    throw refuse("unsafe_command", file, `the hook path ${JSON.stringify(command)} is not Connect's own launcher, so its entries could not be recognized or removed later.`);
  }
  const current = readCurrent(file, command), base = current?.text ?? EMPTY_FILE;
  const document = parseStrict(file, base, command);
  let next: string, createdKeys: string[];
  try {
    const without = expectedWithoutOurs(base, CURSOR_HOOK_EVENTS, created);
    const cleared = withoutOurs(base, document, CURSOR_HOOK_EVENTS, created);
    if (!isDeepStrictEqual(JSON.parse(cleared), without)) throw new Error("removal changed other content");
    // A key that is there once Connect's entries are out is the user's.
    createdKeys = CURSOR_HOOK_EVENTS.filter(event => !Object.hasOwn(without.hooks, event));
    next = withOurs(cleared, command);
    if (!isDeepStrictEqual(JSON.parse(next), expectedWithOurs(base, command, created))) throw new Error("insertion changed other content");
  } catch {
    throw refuse("merge", file, "Connect could not add its entries without rewriting other parts of the file.", command);
  }
  return { current, next, createdKeys };
}

/** The preflight's check: would the merge be refused? Reads only. */
export function checkCursorHooksFile(opts: { hooksFile: string; command: string }): { exists: boolean } {
  return { exists: planInstall(opts.hooksFile, opts.command, null).current !== null };
}

/** A name in the user's directory that is recognizably ours. */
const TEMPORARY_SUFFIX = ".codetelemetry-tmp";

/** Create `file` complete, and only if nothing is there. Returns false when something is. */
function createExclusive(file: string, body: string | Uint8Array): boolean {
  const temporary = writeCursorTemporary(file, body, 0o600, TEMPORARY_SUFFIX);
  try {
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      // A file system without hard links: an exclusive copy is the next best.
      try {
        fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw copyError;
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  syncCursorDirectory(path.dirname(file));
  return true;
}

/** Replace the file we read in one rename, keeping its mode. If the user or
 *  Cursor saved it since the read, leave their version and refuse. */
function replaceRead(file: string, body: string, current: Current, command?: string): void {
  const temporary = writeCursorTemporary(file, body, current.mode, TEMPORARY_SUFFIX);
  try {
    assertUnchanged(file, current, command);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  syncCursorDirectory(path.dirname(file));
}

function assertUnchanged(file: string, current: Current, command?: string): void {
  const now = fs.lstatSync(file);
  if (!now.isFile() || now.ino !== current.ino || now.size !== current.size || now.mtimeMs !== current.mtimeMs) {
    throw refuse("changed", file, "it changed while Connect was updating it. Run the command again.", command);
  }
}

/** A file-system failure while writing is a refusal like any other: the caller
 *  gets the reason and the entries to paste, not a stack trace. */
function writing<T>(file: string, command: string | undefined, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof CursorHooksRefusal) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw refuse("unwritable", file, `it could not be written${code ? ` (${code})` : ""}.`, command);
  }
}

export type CursorHooksInstallResult = {
  path: string;
  status: "created" | "updated" | "unchanged";
  /** True only when this call created the file. */
  createdByConnect: boolean;
  /** The one-time copy of the user's file, when this call made it. */
  backupPath: string | null;
  /** The event keys Connect added. Every other key under which its entries
   *  stand was the user's, an empty list included, and removal keeps it. */
  createdKeys: string[];
};

/** Merge the six entries. Idempotent: a file that already holds them is not
 *  written. `createdKeys` is what the previous install returned; without it a
 *  key whose list holds only Connect's entries is taken for one Connect added. */
export function installCursorHooks(opts: { hooksFile: string; command: string; createdKeys?: readonly string[] }): CursorHooksInstallResult {
  const file = opts.hooksFile, { current, next, createdKeys } = planInstall(file, opts.command, opts.createdKeys ?? null);
  if (!current) {
    const created = writing(file, opts.command, () => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      return createExclusive(file, next);
    });
    if (!created) throw refuse("changed", file, "it appeared while Connect was creating it. Run the command again.", opts.command);
    return { path: file, status: "created", createdByConnect: true, backupPath: null, createdKeys };
  }
  if (next === current.text) return { path: file, status: "unchanged", createdByConnect: false, backupPath: null, createdKeys };
  const backup = `${file}.codetelemetry-backup`;
  const backedUp = writing(file, opts.command, () => {
    const copied = createExclusive(backup, current.bytes);
    replaceRead(file, next, current, opts.command);
    return copied;
  });
  return { path: file, status: "updated", createdByConnect: false, backupPath: backedUp ? backup : null, createdKeys };
}

/** The "hooks" object as Cursor would read it: through a link, with comments
 *  and trailing commas allowed. For reading only; null when there is none. */
function readLenient(file: string): Record<string, unknown> | null {
  let document: unknown;
  try {
    const fd = fs.openSync(file, "r");
    let text: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > CURSOR_HOOKS_FILE_BYTES) return null;
      const buffer = Buffer.alloc(stat.size);
      text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    try {
      document = JSON.parse(text);
    } catch {
      document = JSON.parse(stripComments(text));
    }
  } catch {
    return null;
  }
  return isRecord(document) && isRecord(document.hooks) ? document.hooks : null;
}

export type CursorHooksRemoveResult = {
  path: string;
  /** `skipped`: the file holds entries Connect could not remove safely; `detail` says why. */
  status: "absent" | "unchanged" | "updated" | "deleted" | "skipped";
  detail?: string;
};

/** Remove Connect's entries from every event and nothing else. A file with none
 *  is not rewritten; a file Connect created is deleted once it is empty again.
 *  With `createdKeys` (what the install returned), a key the user had with an
 *  empty list gets that empty list back instead of being removed.
 *  Never throws for the file's own condition: the caller still removes hook.sh,
 *  which makes any entry left behind inert. */
export function removeCursorHooks(opts: { hooksFile: string; createdByConnect?: boolean; createdKeys?: readonly string[] }): CursorHooksRemoveResult {
  const file = opts.hooksFile, created = opts.createdKeys ?? null;
  try {
    const current = readCurrent(file);
    if (!current) return { path: file, status: "absent" };
    const document = parseStrict(file, current.text);
    if (!Object.values(document.hooks).some(entries => entries.some(isOurs))) return { path: file, status: "unchanged" };
    const expected = expectedWithoutOurs(current.text, null, created);
    let next: string;
    try {
      next = withoutOurs(current.text, document, null, created);
      if (!isDeepStrictEqual(JSON.parse(next), expected)) throw new Error("removal changed other content");
    } catch {
      throw refuse("merge", file, "Connect could not remove its entries without rewriting other parts of the file.");
    }
    if (opts.createdByConnect && isDeepStrictEqual(expected, { version: 1, hooks: {} })) {
      writing(file, undefined, () => {
        assertUnchanged(file, current);
        fs.unlinkSync(file);
      });
      return { path: file, status: "deleted" };
    }
    writing(file, undefined, () => replaceRead(file, next, current));
    return { path: file, status: "updated" };
  } catch (error) {
    if (!(error instanceof CursorHooksRefusal)) throw error;
    // Nothing of ours in a file we cannot edit is not a problem to report.
    const hooks = readLenient(file);
    if (!hooks || !Object.values(hooks).some(entries => Array.isArray(entries) && entries.some(isOurs))) return { path: file, status: "unchanged" };
    const byHand = error.reason === "changed" ? "" : ` Remove the entries whose command contains ${CURSOR_HOOK_MARKER} by hand.`;
    return { path: file, status: "skipped", detail: `${error.message}${byHand}` };
  }
}

/** Whether Cursor will run the hook: an entry under all six events, some, or
 *  none. Read-only, so it follows a link and accepts comments, and a block the
 *  user pasted by hand counts. With `command`, only that exact command counts. */
export function cursorHooksState(opts: { hooksFile: string; command?: string }): "installed" | "missing" | "partial" {
  const hooks = readLenient(opts.hooksFile) ?? {};
  const matches = (entry: unknown) =>
    opts.command === undefined ? isOurs(entry) : isRecord(entry) && entry.command === opts.command;
  const present = CURSOR_HOOK_EVENTS.filter(event => {
    const entries = hooks[event];
    return Array.isArray(entries) && entries.some(matches);
  }).length;
  return present === CURSOR_HOOK_EVENTS.length ? "installed" : present === 0 ? "missing" : "partial";
}
