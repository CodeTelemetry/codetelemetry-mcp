"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const codexConfigPath = "/SYNTHETIC_CONFIG";
const observationStatePath = path.join(__dirname, "codetelemetry-repository-hook-state.json");
const observationLockPath = observationStatePath + ".lock";
const maxObservationStateEntries = 64;
const lockWaitCell = new Int32Array(new SharedArrayBuffer(4));
// Codex kills this command after three seconds. Keep one absolute budget for
// all synchronous discovery, state locks, transport, and rollback work, with a
// generous host-scheduler margin rather than stacking independent timeouts.
const hookDeadlineAt = Date.now() + 2200;
const postClaimRollbackReserveMs = 250;
const minimumPostClaimBudgetMs = 850;
const maximumGitBudgetMs = 275;
const maximumTransportBudgetMs = 650;
function remainingHookBudget() { return Math.max(0, hookDeadlineAt - Date.now()); }

function git(cwd, args) {
  // Never let repository discovery consume the time reserved for a delivery
  // failure to restore its claim before the host's hard timeout.
  const timeout = Math.min(maximumGitBudgetMs, remainingHookBudget() - minimumPostClaimBudgetMs);
  if (timeout < 25) return "";
  try { return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: Math.floor(timeout),
  }).trim(); }
  catch { return ""; }
}
const repositoryRemoteIdentity = function normalizeRepositoryRemote(value) {
    const raw = String(value || "").trim();
    if (!raw)
        return "";
    const scp = raw.includes("://") ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(raw);
    const candidate = scp ? `ssh://${scp[1]}/${scp[2]}` : raw;
    try {
        const parsed = new URL(candidate);
        if (parsed.protocol === "file:") {
            return parsed.pathname.replace(/\.git\/?$/i, "").replace(/\/$/, "");
        }
        const host = parsed.hostname.toLowerCase() + (parsed.port ? `:${parsed.port}` : "");
        const pathname = parsed.pathname
            .replace(/\/{2,}/g, "/")
            .replace(/\.git\/?$/i, "")
            .replace(/^\/+|\/+$/g, "");
        return host && pathname ? `${host}/${pathname}` : "";
    }
    catch {
        return raw.replace(/\.git\/?$/i, "").replace(/\/$/, "");
    }
};
const selectCodexOtelExporterLine = function selectCodexOtelExporterLine(raw) {
    if (raw.includes('"""') || raw.includes("'''"))
        return "";
    const stripComment = (line) => {
        let quote = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quote) {
                if (ch === "\\" && quote === '"')
                    i++;
                else if (ch === quote)
                    quote = null;
            }
            else if (ch === '"' || ch === "'")
                quote = ch;
            else if (ch === "#")
                return line.slice(0, i);
        }
        return line;
    };
    const structuralOnly = (line) => {
        let out = "";
        let quote = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quote) {
                if (ch === "\\" && quote === '"')
                    i++;
                else if (ch === quote)
                    quote = null;
            }
            else if (ch === '"' || ch === "'")
                quote = ch;
            else if (ch === "#")
                break;
            else
                out += ch;
        }
        return out;
    };
    const headerName = (line) => {
        const text = stripComment(line).trim();
        if (!text.startsWith("[") || !text.endsWith("]"))
            return null;
        const arrayTable = text.startsWith("[[");
        const closer = arrayTable ? "]]" : "]";
        if (!text.endsWith(closer))
            return null;
        const inner = text.slice(arrayTable ? 2 : 1, text.length - closer.length).trim();
        if (!inner)
            return null;
        const unquoted = inner.replace(/^(["'])(.*)\1$/, "$2");
        return arrayTable ? `[]${unquoted}` : unquoted;
    };
    const depthDelta = (line) => {
        let depth = 0;
        for (const ch of structuralOnly(line)) {
            if (ch === "[" || ch === "{")
                depth++;
            else if (ch === "]" || ch === "}")
                depth--;
        }
        return depth;
    };
    let depth = 0;
    let inOtel = false;
    for (const line of raw.split(/\r?\n/)) {
        if (depth === 0) {
            const header = headerName(line);
            if (header !== null) {
                inOtel = header === "otel";
            }
            else if (inOtel && /^\s*exporter\s*=/.test(structuralOnly(line))) {
                return line;
            }
        }
        depth = Math.max(0, depth + depthDelta(line));
    }
    return "";
};
function remoteName(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return value.split(/[\\/]/).filter(Boolean).pop() || "";
  }
}
function attr(key, value) { return { key, value: { stringValue: String(value) } }; }
function digest(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function acquireObservationLock(deadlineAt) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (Date.now() + 5 > deadlineAt) return null;
    try { return fs.openSync(observationLockPath, "wx", 0o600); }
    catch (error) {
      if (!error || error.code !== "EEXIST") return null;
      try {
        if (Date.now() - fs.statSync(observationLockPath).mtimeMs > 5000) {
          fs.unlinkSync(observationLockPath);
          continue;
        }
      } catch {}
      try { Atomics.wait(lockWaitCell, 0, 0, 5); } catch {}
    }
  }
  return null;
}
function readObservationState() {
  try {
    const stat = fs.statSync(observationStatePath);
    if (!stat.isFile() || stat.size > 32768) return [];
    const parsed = JSON.parse(fs.readFileSync(observationStatePath, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => entry &&
      /^[a-f0-9]{64}$/.test(entry.sessionHash) &&
      /^[a-f0-9]{64}$/.test(entry.observationHash)
    ).slice(-maxObservationStateEntries);
  } catch { return []; }
}
function writeObservationState(entries) {
  // An exclusive, unguessable sibling keeps atomic publication from following
  // a pre-planted temp-file symlink in this user-writable config directory.
  const tempPath = observationStatePath + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, entries: entries.slice(-maxObservationStateEntries) }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tempPath, observationStatePath);
    try { fs.chmodSync(observationStatePath, 0o600); } catch {}
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}
function claimObservation(sessionId, observationHash, preserveStart, deadlineAt) {
  const sessionHash = digest(sessionId || "anonymous-session");
  // A persisted pre-delivery claim must never look like a delivered
  // observation. If the host kills this process, the next invocation compares
  // its real observation hash to this opaque marker and retries immediately.
  const claimHash = digest("pending\0" + sessionHash + "\0" + observationHash + "\0" + crypto.randomUUID());
  const lock = acquireObservationLock(deadlineAt);
  // A start observation remains useful even when local state is unavailable.
  // Other events fail closed to a no-op so a broken cache cannot amplify every
  // tool call into a network request.
  if (lock === null) return preserveStart
    ? { persisted: false, sessionHash, observationHash, claimHash, previousObservationHash: null }
    : null;
  try {
    const entries = readObservationState();
    const current = entries.find((entry) => entry.sessionHash === sessionHash);
    if (!preserveStart && current && current.observationHash === observationHash) return null;
    writeObservationState([
      ...entries.filter((entry) => entry.sessionHash !== sessionHash),
      { sessionHash, observationHash: claimHash },
    ]);
    return {
      persisted: true,
      sessionHash,
      observationHash,
      claimHash,
      previousObservationHash: current ? current.observationHash : null,
    };
  } catch {
    return preserveStart
      ? { persisted: false, sessionHash, observationHash, claimHash, previousObservationHash: null }
      : null;
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(observationLockPath); } catch {}
  }
}
function rollbackObservation(claim, deadlineAt) {
  if (!claim || !claim.persisted) return;
  const lock = acquireObservationLock(deadlineAt);
  if (lock === null) return;
  try {
    const entries = readObservationState();
    const current = entries.find((entry) => entry.sessionHash === claim.sessionHash);
    // Delivery can overlap a later PostToolUse. Restore only our own claim;
    // never overwrite newer repository/workspace evidence for this session.
    if (!current || current.observationHash !== claim.claimHash) return;
    const restored = entries.filter((entry) => entry.sessionHash !== claim.sessionHash);
    if (claim.previousObservationHash) {
      restored.push({
        sessionHash: claim.sessionHash,
        observationHash: claim.previousObservationHash,
      });
    }
    writeObservationState(restored);
  } catch {
    // Cache repair is best-effort and must never block the host client.
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(observationLockPath); } catch {}
  }
}
function commitObservation(claim, deadlineAt) {
  if (!claim || !claim.persisted) return;
  const lock = acquireObservationLock(deadlineAt);
  if (lock === null) return;
  try {
    const entries = readObservationState();
    const current = entries.find((entry) => entry.sessionHash === claim.sessionHash);
    // A later transition may have claimed or committed while this request was
    // in flight. Only this exact pending marker may publish its delivered hash.
    if (!current || current.observationHash !== claim.claimHash) return;
    writeObservationState([
      ...entries.filter((entry) => entry.sessionHash !== claim.sessionHash),
      { sessionHash: claim.sessionHash, observationHash: claim.observationHash },
    ]);
  } catch {
    // Leaving an opaque pending marker is safe: it cannot suppress a retry.
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(observationLockPath); } catch {}
  }
}
function codexTelemetryConfig() {
  if (!codexConfigPath) return {};
  try {
    const raw = fs.readFileSync(codexConfigPath, "utf8");
    // The connect writer owns this single-line exporter shape. Read the live
    // config at hook time so the bearer key is never copied into this script
    // and key rotation does not change the trusted hook definition.
    const line = selectCodexOtelExporterLine(raw);
    const endpointMatch = /\bendpoint\s*=\s*"([^"]+)"/.exec(line);
    const authorizationMatch = /\bauthorization\s*=\s*"([^"]+)"/i.exec(line);
    return {
      endpoint: endpointMatch ? endpointMatch[1] : "",
      authorization: authorizationMatch ? authorizationMatch[1] : "",
    };
  } catch { return {}; }
}
function environmentAuthHeaders() {
  const raw = String(process.env.OTEL_EXPORTER_OTLP_HEADERS || "");
  for (const part of raw.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim().toLowerCase() !== "authorization") continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return {};
    // OTEL exporter headers permit percent-encoded values. Decode only after
    // splitting fields so an encoded comma cannot become a second credential.
    try { return { Authorization: decodeURIComponent(value) }; }
    catch { return { Authorization: value }; }
  }
  return {};
}
function deliveryDestination() {
  const base = String(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").replace(/\/$/, "");
  // Endpoint and credentials are one provenance-bearing choice. In particular,
  // never attach the key from config.toml to an environment-provided endpoint.
  if (base) return {
    endpoint: base.endsWith("/v1/logs") ? base : base + "/v1/logs",
    headers: environmentAuthHeaders(),
    source: "environment",
  };
  const config = codexTelemetryConfig();
  const authorization = String(config.authorization || "");
  return {
    endpoint: String(config.endpoint || ""),
    headers: authorization ? { Authorization: authorization } : {},
    source: "config",
  };
}
function isLoopbackHostname(value) {
  const hostname = String(value || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname === "::1" || hostname === "localhost" || hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
function permitsAuthorization(url, headers) {
  const authorization = String(headers.Authorization || "");
  if (!/^\s*Bearer\s+/i.test(authorization)) return true;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
}
async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
  const destination = deliveryDestination();
  let url;
  try { url = new URL(destination.endpoint); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  if (!permitsAuthorization(url, destination.headers)) return;
  const cwd = path.resolve(String(input.new_cwd || input.cwd || process.cwd()));
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const remote = repositoryRemoteIdentity(git(root, ["config", "--get", "remote.origin.url"]));
  const initialCommit = git(root, ["rev-list", "--max-parents=0", "HEAD"]).split(/\s+/).filter(Boolean).sort()[0] || "";
  const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonRoot = commonDir.endsWith(path.sep + ".git") ? path.dirname(commonDir) : root;
  const repositoryId = crypto.createHash("sha256").update(remote || initialCommit || root).digest("hex");
  const repositoryName = remoteName(remote) || path.basename(commonRoot);
  const sessionId = String(input.session_id || "").slice(0, 256);
  const hookEvent = String(input.hook_event_name || "repository_observed").slice(0, 64);
  // State contains only fixed-size hashes: session ids and raw paths never
  // persist locally. SessionStart is intentionally never suppressed, while
  // prompt/tool hooks emit only when repository or workspace evidence changes.
  const observationHash = digest(repositoryId + "\0" + digest(root) + "\0" + digest(cwd));
  const now = String(BigInt(Date.now()) * 1000000n);
  const attributes = [
    attr("event.name", "codetelemetry.repository_observed"),
    attr("project.path", root),
    attr("code.repository.id", repositoryId),
    attr("code.repository.name", repositoryName),
    attr("code.repository.root", root),
    attr("code.workspace.path", cwd),
    attr("hook.event", hookEvent),
  ];
  if (sessionId) attributes.push(attr("session.id", sessionId));
  const body = JSON.stringify({ resourceLogs: [{
    resource: { attributes: [attr("service.name", "codetelemetry-connect")] },
    scopeLogs: [{ scope: { name: "codetelemetry.repository-hook", version: "1" }, logRecords: [{
      timeUnixNano: now,
      observedTimeUnixNano: now,
      body: { stringValue: "repository_observed" },
      attributes,
    }] }],
  }] });
  // This hook performs one non-retrying delivery, so a fresh UUID is both the
  // logical-delivery identity and the durable retry receipt key. It must never
  // be installed as a static OTLP exporter header.
  const idempotencyKey = crypto.randomUUID();
  // Claim only after every local delivery input is valid. If transport then
  // fails, rollback below compare-and-restores this exact hash. Do not begin a
  // claim unless the absolute hook budget still covers transport and rollback.
  if (remainingHookBudget() < minimumPostClaimBudgetMs) return;
  const claimDeadlineAt = Math.min(hookDeadlineAt - minimumPostClaimBudgetMs + 100, Date.now() + 100);
  const claim = claimObservation(sessionId, observationHash, hookEvent === "SessionStart", claimDeadlineAt);
  if (!claim) return;
  let delivered = false;
  try {
    const transportBudget = Math.min(
      maximumTransportBudgetMs,
      remainingHookBudget() - postClaimRollbackReserveMs,
    );
    if (transportBudget < 25) throw new Error("repository hook delivery budget exhausted");
    delivered = await new Promise((resolve) => {
      let finished = false;
      let absoluteTimer;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        if (absoluteTimer) clearTimeout(absoluteTimer);
        resolve(ok);
      };
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-code-telemetry-idempotency-key": idempotencyKey,
          ...destination.headers,
        },
        timeout: Math.floor(transportBudget),
      }, (res) => {
        const accepted = Number(res.statusCode) >= 200 && Number(res.statusCode) < 300;
        res.resume();
        res.on("end", () => finish(accepted));
        res.on("error", () => finish(false));
      });
      // ClientRequest's timeout is an inactivity timeout, not an end-to-end
      // bound. This timer also covers a peer that trickles or never responds.
      if (!finished) {
        absoluteTimer = setTimeout(() => { req.destroy(); finish(false); }, Math.floor(transportBudget));
      }
      req.on("timeout", () => { req.destroy(); finish(false); });
      req.on("error", () => finish(false));
      req.end(body);
    });
  } catch {}
  if (delivered) commitObservation(claim, hookDeadlineAt);
  else rollbackObservation(claim, hookDeadlineAt);
}
main().catch(() => {}).finally(() => { process.exitCode = 0; });
