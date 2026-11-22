import { scrub as scrubKey } from "../keys.ts";

// Credential removal shared by the collectors. It runs before anything
// opted-in is persisted or uploaded. The three patterns are exported without
// the global flag so a generated program can embed their `source`.

/** Credential-shaped text: key blocks, bearer values, assignments to secret-named
 * keys, common provider token formats, JWTs and URLs that embed a password. */
export const CREDENTIAL_RE = /(?:-----BEGIN [A-Z ]+(?:PRIVATE KEY|CREDENTIAL)-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:api[_-]?key|authorization|client[_-]?secret|password|passwd|secret|token|accountkey)\s*[:=]\s*\S+|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s/]*:[^\s/@]+@)/i;
/** A whole key or credential block, to its end marker or to the end of the text. */
export const CREDENTIAL_BLOCK_RE = /-----BEGIN ([A-Z ]*(?:PRIVATE KEY|CREDENTIAL))-----[\s\S]*?(?:-----END \1-----|$)/i;
/** The value assigned to a secret-named key. Group 1 is the key and separator, which are kept. */
export const SECRET_ASSIGNMENT_RE = /(["']?(?:api[_-]?key|authorization|client[_-]?secret|password|passwd|secret|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/i;
const REDACTED = "<REDACTED>";

// The stricter patterns below are the ones the Cursor collector uses. The
// three above stay exactly as Kiro released them. Scrubbing is best effort:
// these patterns know common shapes of a credential, not every one.
//
// Every quantifier that could rescan the same text is bounded or anchored at a
// word start, so the cost stays linear in the input.
const SCHEME = "(?:(?:Bearer|Basic|Digest|Negotiate|Token)\\s+)?";
const VALUE = `(?:"[^"\\n]{0,512}"|'[^'\\n]{0,512}'|${SCHEME}\\S+)`;
const SECRET_WORD = "(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|KEY)";
/** Everything `CREDENTIAL_RE` names, and also: an authorization value behind
 * its scheme word, an assignment to any name that contains a secret word
 * (`AWS_SECRET_ACCESS_KEY=`, `db_password:`), an `X-...:` request header, a
 * password given in prose, and a password in the user part of any URL. */
export const STRICT_CREDENTIAL_RE = new RegExp("(?:" + [
  "-----BEGIN [A-Z ]{1,64}(?:PRIVATE KEY|CREDENTIAL)-----",
  "\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*",
  `\\bauthorization\\s*[:=]\\s*${VALUE}`,
  `\\b(?=[A-Z0-9_]{0,64}${SECRET_WORD})[A-Z0-9_]{1,96}\\s*[:=]\\s*${VALUE}`,
  `\\b(?:accountkey|x-[a-z0-9-]{1,40})\\s*[:=]\\s*${VALUE}`,
  "\\b(?:password|passwd|passphrase|pwd)\\s+(?:is|was|of)\\s+\\S+",
  "\\bAKIA[0-9A-Z]{16}\\b", "\\bASIA[0-9A-Z]{16}\\b", "\\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\\b", "\\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\\b",
  "\\bgh[pousr]_[A-Za-z0-9]{20,}\\b", "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", "\\bglpat-[A-Za-z0-9_-]{16,}",
  "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", "\\bnpm_[A-Za-z0-9]{20,}\\b", "\\bAIza[A-Za-z0-9_-]{20,}\\b",
  "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b",
  // The first colon ends the user name, so no part of the text is tried twice.
  "\\b[a-z][a-z0-9+.-]{0,31}:\\/\\/[^\\s\\/:@]{0,256}:[^\\s\\/]{0,1024}@",
].join("|") + ")", "i");
/** The value assigned to a quoted or bare secret-named key, with its scheme
 * word. Group 1 is the key and separator, which are kept. */
export const STRICT_ASSIGNMENT_RE = new RegExp(
  `(["']?\\b(?=[A-Z0-9_-]{0,64}(?:${SECRET_WORD}|AUTHORIZATION))[A-Z0-9_-]{1,96}["']?\\s*[:=]\\s*["']?${SCHEME})[^\\s,"'}]+`, "i");
/** A command line that passes a secret as an argument: a long option named
 * for one, `-u name:password`, a request header that authenticates, a
 * program that exists to pass one, or the short password option of a program
 * known to take one. Such a command is
 * withheld whole, because the value itself has no shape to recognise. */
export const SECRET_ARGUMENT_RE = new RegExp("(?:" + [
  "(?:^|\\s)--?[a-z0-9-]{0,32}(?:pass|pwd|secret|token|credential|api-?key|auth(?!or))[a-z0-9-]{0,32}(?:[=\\s]|$)",
  "(?:^|\\s)(?:-u|--user|--proxy-user)(?:\\s+|=)?[^\\s:]{1,256}:\\S",
  "(?:^|\\s)(?:-H|--header)(?:\\s+|=)?[\"']?[a-z0-9-]{0,40}(?:auth|token|key|secret|cookie|password|session|credential)[a-z0-9-]{0,40}\\s*:",
  "\\b(?:sshpass|htpasswd|smbpasswd|chpasswd|expect)\\b",
  "\\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump|redis-cli|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport|ldapsearch|ldapmodify|smbclient|rabbitmqadmin|sqlcmd|bcp|pg_dump|psql|zip|unzip|7z|7za|openssl)\\b[^\\n|;&]{0,512}?\\s-[apw]",
  "\\b(?:docker|podman|nerdctl|helm|oras|skopeo|buildah|crane|az|oc|vault|npm|gh|glab|heroku|snowsql|sqlplus)\\b[^\\n|;&]{0,128}?\\blogin\\b[^\\n|;&]{0,512}?\\s-p",
].join("|") + ")", "i");

const every = (pattern: RegExp) => new RegExp(pattern.source, "gi");
const BLOCKS = every(CREDENTIAL_BLOCK_RE), CREDENTIALS = every(CREDENTIAL_RE), ASSIGNMENTS = every(SECRET_ASSIGNMENT_RE);
const STRICT_CREDENTIALS = every(STRICT_CREDENTIAL_RE), STRICT_ASSIGNMENTS = every(STRICT_ASSIGNMENT_RE);

/** Mask ingest keys, replace every credential-shaped span with the marker,
 * then cut to `max` characters. */
export function scrubCredentials(value: string, max: number): string {
  return scrubKey(value).replace(BLOCKS, REDACTED).replace(CREDENTIALS, REDACTED).replace(ASSIGNMENTS, `$1${REDACTED}`).slice(0, max);
}
/** True when scrubbing would change the value or it already carries a redaction
 * or key mask. A structured value that holds such a string is withheld whole. */
export function holdsCredential(value: string): boolean {
  return scrubCredentials(value, value.length) !== value || /<REDACTED>|cot_\u2026/.test(value);
}
/** `scrubCredentials` with the stricter patterns. */
export function scrubCredentialsStrict(value: string, max: number): string {
  return scrubKey(value).replace(BLOCKS, REDACTED).replace(STRICT_CREDENTIALS, REDACTED).replace(STRICT_ASSIGNMENTS, `$1${REDACTED}`).slice(0, max);
}
/** `holdsCredential` with the stricter patterns. */
export function holdsCredentialStrict(value: string): boolean {
  return scrubCredentialsStrict(value, value.length) !== value || /<REDACTED>|cot_\u2026/.test(value);
}
/** True when a command line passes a secret as an argument. */
export function passesSecretArgument(command: string): boolean {
  return SECRET_ARGUMENT_RE.test(command);
}
