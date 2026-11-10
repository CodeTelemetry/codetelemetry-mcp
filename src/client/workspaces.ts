// Versioned local workspace contract shared with the Terraform provider.
// Repository bindings are public metadata; credentials never leave the private store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { buildOtelSection } from "./codexConfig.ts";
import { repositoryHookSource, quotedCommand, REPOSITORY_HOOK_FILE, REPOSITORY_HOOK_STATE_FILE } from "./repositoryHook.ts";
import { looksLikeKey } from "./keys.ts";
import type { KeyScope } from "./connectivity.ts";

export const WORKSPACE_MCP_PACKAGE = "@codetelemetry/mcp@0.6.0";
export const MAX_WORKSPACE_BYTES = 64 * 1024;
export const MAX_WORKSPACES = 64;
const isContextFile = (name: string): boolean =>
  /^[a-z][a-z0-9_-]{0,63}\.json$/.test(name) && name !== REPOSITORY_HOOK_STATE_FILE;
export type WorkspaceBinding = {
  version: 1;
  name: string;
  apiBase: string;
  scope: KeyScope;
};
export type WorkspaceContext = WorkspaceBinding & {
  ingestEndpoint: string;
  ingestKey: string;
  clientConfig?: {
    client: "claude" | "codex";
    path: string;
    enrich: boolean;
    repositoryObservation: boolean;
  };
};

export function workspaceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    looksLikeKey(value) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value)
  )
    throw new Error(
      "Workspace name must be 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter.",
    );
  if (`${value}.json` === REPOSITORY_HOOK_STATE_FILE)
    throw new Error("Workspace name is reserved for repository-hook state.");
  return value;
}
export function workspaceOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Invalid workspace service origin.");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Workspace endpoints require an HTTPS origin (HTTP is allowed on loopback).",
    );
  return url.origin;
}
export function workspaceScope(value: unknown): KeyScope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace scope.");
  const s = value as KeyScope;
  if (
    [s.tenantId, s.billingAccountId].some(
      (v) => typeof v !== "string" || !v || v.length > 256,
    ) ||
    (s.teamId !== null &&
      (typeof s.teamId !== "string" ||
        !/^tm_[a-zA-Z0-9_-]{1,128}$/.test(s.teamId)))
  )
    throw new Error("Invalid workspace scope.");
  return {
    tenantId: s.tenantId,
    teamId: s.teamId,
    billingAccountId: s.billingAccountId,
  };
}
export function bindingOf(value: unknown): WorkspaceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace context.");
  const v = value as WorkspaceBinding;
  if (v.version !== 1)
    throw new Error(
      "Unsupported workspace context version; upgrade CodeTelemetry.",
    );
  return {
    version: 1,
    name: workspaceName(v.name),
    apiBase: workspaceOrigin(v.apiBase),
    scope: workspaceScope(v.scope),
  };
}
export function sameWorkspace(
  a: WorkspaceBinding,
  b: WorkspaceBinding,
): boolean {
  return (
    a.name === b.name &&
    a.apiBase === b.apiBase &&
    a.scope.tenantId === b.scope.tenantId &&
    a.scope.teamId === b.scope.teamId &&
    a.scope.billingAccountId === b.scope.billingAccountId
  );
}
export function workspaceHome(): string {
  const dir =
    process.env.CODETELEMETRY_CONTEXT_HOME ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "codetelemetry",
      "workspaces",
    );
  if (!path.isAbsolute(dir))
    throw new Error("CODETELEMETRY_CONTEXT_HOME must be absolute.");
  return path.resolve(dir);
}
function noLinks(file: string): void {
  let current = path.parse(file).root;
  for (const segment of path
    .resolve(file)
    .slice(current.length)
    .split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Workspace paths cannot contain symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export function readWorkspaceFile(file: string, privateFile = true): unknown {
  noLinks(file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const st = fs.fstatSync(fd);
    if (
      !st.isFile() ||
      st.size > MAX_WORKSPACE_BYTES ||
      (privateFile &&
        process.platform !== "win32" &&
        ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))
    )
      throw new Error(
        "Workspace state must be an owned private regular file of at most 64 KiB.",
      );
    const bytes = Buffer.alloc(MAX_WORKSPACE_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_WORKSPACE_BYTES)
      throw new Error("Workspace state exceeds 64 KiB.");
    try {
      return JSON.parse(bytes.subarray(0, count).toString("utf8"));
    } catch {
      throw new Error(
        "Invalid workspace JSON; inspect the private state file.",
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}
export function writeWorkspaceText(file: string, data: string): void {
  if (Buffer.byteLength(data) > MAX_WORKSPACE_BYTES)
    throw new Error("Workspace state exceeds 64 KiB.");
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  noLinks(file);
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
    throw new Error("Workspace state must be a regular file.");
  const tmp = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function writeWorkspaceFile(file: string, value: unknown): void {
  writeWorkspaceText(file, JSON.stringify(value, null, 2) + "\n");
}
export function codexWorkspaceProfilePath(name: string): string {
  return path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    `codetelemetry-${workspaceName(name)}.config.toml`,
  );
}
export function workspaceCaptureDefault(context: WorkspaceContext): boolean {
  if (context.clientConfig) return context.clientConfig.enrich;
  const file = codexWorkspaceProfilePath(context.name);
  if (!fs.existsSync(file)) return true;
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_WORKSPACE_BYTES) throw new Error("Invalid workspace profile.");
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith(`# CodeTelemetry workspace ${context.name}\n`)) {
    throw new Error("The Codex workspace profile is not managed by CodeTelemetry; choose a different context name.");
  }
  // Older saved contexts may predate clientConfig. Their managed profile still
  // records the prior capture choice; absence uses the old (disabled) default.
  const section = text.match(/^\[otel\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return /^\s*log_user_prompt\s*=\s*true\s*(?:#.*)?$/m.test(section);
}

export function writeCodexWorkspaceProfile(
  context: WorkspaceContext,
  options: { enrich?: boolean; repositoryObservation?: boolean } = {},
): { path: string } {
  const enrich = options.enrich ?? workspaceCaptureDefault(context);
  const profilePath = codexWorkspaceProfilePath(context.name),
    marker = `# CodeTelemetry workspace ${context.name}\n`;
  upgradeLegacyCodexObserver(path.dirname(profilePath));
  if (fs.existsSync(profilePath)) {
    noLinks(profilePath);
    const st = fs.lstatSync(profilePath);
    if (
      !st.isFile() ||
      st.size > MAX_WORKSPACE_BYTES ||
      !fs.readFileSync(profilePath, "utf8").startsWith(marker)
    )
      throw new Error(
        "The Codex workspace profile is not managed by CodeTelemetry; choose a different context name.",
      );
  }
  let text =
    marker +
    buildOtelSection(
      context.ingestKey,
      context.ingestEndpoint,
      enrich,
    ) +
    "\n";
  if (!enrich)
    text = text.replace("[otel]\n", "[otel]\nlog_user_prompt = false\n");
  if (options.repositoryObservation) {
    const hookPath = path.join(workspaceHome(), `${context.name}.hook.cjs`);
    writeWorkspaceText(
      hookPath,
      repositoryHookSource({ codexConfigPath: profilePath, workspaceName: context.name }),
    );
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"])
      text += `\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(quotedCommand(hookPath))}\ntimeout = 3\n`;
  }
  const basePath = path.join(path.dirname(profilePath), "config.toml");
  let base = "";
  if (fs.existsSync(basePath)) {
    if (fs.statSync(basePath).size > 1024 * 1024)
      throw new Error("Base Codex configuration exceeds 1 MiB.");
    base = fs.readFileSync(basePath, "utf8");
  }
  if (
    /^\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?codetelemetry["']?\s*\]\s*(?:#.*)?$/m.test(
      base,
    ) ||
    /^\s*mcp_servers\s*\.\s*codetelemetry\s*\.\s*(?:command|url)\s*=/m.test(
      base,
    )
  )
    text += "\n[mcp_servers.codetelemetry]\nenabled = false\n";
  text += `\n[mcp_servers.codetelemetry_workspace]\ncommand = "npx"\nargs = ["-y", "--package=${WORKSPACE_MCP_PACKAGE}", "codetelemetry-mcp"]\n\n[mcp_servers.codetelemetry_workspace.env]\nCODETELEMETRY_WORKSPACE = ${JSON.stringify(context.name)}\nCODETELEMETRY_CONTEXT_HOME = ${JSON.stringify(workspaceHome())}\n`;
  writeWorkspaceText(profilePath, text);
  return { path: profilePath };
}

function upgradeLegacyCodexObserver(codexHome: string): void {
  const file = path.join(codexHome, REPOSITORY_HOOK_FILE);
  if (!fs.existsSync(file)) return;
  noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let source: string;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_WORKSPACE_BYTES ||
        (process.platform !== "win32" && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)))
      throw new Error("Existing CodeTelemetry observer must be an owned private regular file.");
    const bytes = Buffer.alloc(MAX_WORKSPACE_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_WORKSPACE_BYTES) throw new Error("Existing CodeTelemetry observer exceeds 64 KiB.");
    source = bytes.subarray(0, count).toString("utf8");
  } finally { fs.closeSync(fd); }
  const configPath = path.join(codexHome, "config.toml");
  const updated = repositoryHookSource({ codexConfigPath: configPath });
  if (source === updated) return;
  const declaration = `const codexConfigPath = ${JSON.stringify(configPath)};`;
  const fingerprint = createHash("sha256").update(source.replace(declaration, 'const codexConfigPath = "";')).digest("hex");
  // Published 0.3.7–0.3.14 / Connect 0.1.5 and the equivalent source-mode
  // template. Only the embedded nonsecret config path varies per installation.
  const recognized = new Set([
    "69dd5ad120636379875fc411bcaaa096defe475944d24a6e899dc9796472ab2d",
    "65eaa30f6c565b0298137986bbe4e94d0435f8fedc2574fa284e7979a5fa9ef4",
  ]);
  if (!source.includes(declaration) || !recognized.has(fingerprint))
    throw new Error("Existing CodeTelemetry observer differs from a recognized client release. Review or update that helper before configuring a workspace; its global hook definitions were preserved.");
  // Keep the trusted hook command and all unrelated hooks intact. In named
  // repositories the upgraded global helper abstains; the selected profile's
  // explicit observation setting is the sole CodeTelemetry reporter.
  writeWorkspaceText(file, updated);
}
export function workspaceEntries(): string[] {
  noLinks(workspaceHome());
  if (!fs.existsSync(workspaceHome())) return [];
  const dir = fs.opendirSync(workspaceHome()),
    names: string[] = [];
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      names.push(entry.name);
      if (names.length > MAX_WORKSPACES * 3)
        throw new Error("Workspace store exceeds its entry bound.");
    }
  } finally {
    dir.closeSync();
  }
  return names;
}
export function workspaceLock(name: string): () => void {
  if (name !== ".store") workspaceName(name);
  noLinks(workspaceHome());
  fs.mkdirSync(workspaceHome(), { recursive: true, mode: 0o700 });
  workspaceEntries();
  const file = path.join(workspaceHome(), `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        fs.closeSync(fd);
      }
      return () => fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readWorkspaceFile(file) as { pid?: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0)
        throw new Error("Workspace lock needs inspection.");
      try {
        process.kill(owner.pid!, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          fs.unlinkSync(file);
          continue;
        }
      }
      throw new Error(
        "Another process is using this workspace; resume when it finishes.",
      );
    }
  }
  throw new Error("Workspace lock changed; retry.");
}
export function contextPath(name: string): string {
  return path.join(workspaceHome(), `${workspaceName(name)}.json`);
}
export function loadWorkspace(name: string): WorkspaceContext {
  const raw = readWorkspaceFile(contextPath(name)) as WorkspaceContext;
  const binding = bindingOf(raw);
  if (binding.name !== name || !looksLikeKey(raw.ingestKey))
    throw new Error("Workspace context has invalid identity or credentials.");
  if (
    raw.clientConfig &&
    (!["claude", "codex"].includes(raw.clientConfig.client) ||
      typeof raw.clientConfig.path !== "string" ||
      !path.isAbsolute(raw.clientConfig.path) ||
      typeof raw.clientConfig.enrich !== "boolean" ||
      typeof raw.clientConfig.repositoryObservation !== "boolean")
  )
    throw new Error("Invalid workspace client configuration.");
  return {
    ...binding,
    ingestEndpoint: workspaceOrigin(raw.ingestEndpoint),
    ingestKey: raw.ingestKey,
    ...(raw.clientConfig ? { clientConfig: raw.clientConfig } : {}),
  };
}
export function saveWorkspace(context: WorkspaceContext): void {
  const release = workspaceLock(".store");
  try {
    let checked = {
      ...bindingOf(context),
      ingestEndpoint: workspaceOrigin(context.ingestEndpoint),
      ingestKey: context.ingestKey,
      ...(context.clientConfig ? { clientConfig: context.clientConfig } : {}),
    };
    if (!looksLikeKey(checked.ingestKey))
      throw new Error("Invalid workspace credential.");
    const file = contextPath(checked.name);
    if (fs.existsSync(file)) {
      const existing = loadWorkspace(checked.name);
      if (!sameWorkspace(existing, checked))
        throw new Error("Workspace identity changed; use a new context name.");
      if (!checked.clientConfig && existing.clientConfig)
        checked = { ...checked, clientConfig: existing.clientConfig };
    }
    fs.mkdirSync(workspaceHome(), { recursive: true, mode: 0o700 });
    noLinks(workspaceHome());
    if (
      !fs.existsSync(file) &&
      workspaceEntries().filter(isContextFile)
        .length >= MAX_WORKSPACES
    )
      throw new Error(
        "Workspace store is full; remove unused contexts before continuing.",
      );
    writeWorkspaceFile(file, checked);
  } finally {
    release();
  }
}
export function listWorkspaces(): WorkspaceBinding[] {
  if (!fs.existsSync(workspaceHome())) return [];
  noLinks(workspaceHome());
  const names = workspaceEntries();
  if (names.length > MAX_WORKSPACES * 3)
    throw new Error("Workspace store exceeds its entry bound.");
  const files = names.filter(isContextFile);
  if (files.length > MAX_WORKSPACES)
    throw new Error("Workspace store exceeds 64 contexts.");
  return files
    .sort()
    .map((file) => bindingOf(loadWorkspace(file.slice(0, -5))));
}
export function findWorkspaceBinding(
  start = process.cwd(),
  selectedName = process.env.CODETELEMETRY_WORKSPACE,
): WorkspaceBinding | null {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth++) {
    const file = path.join(dir, ".codetelemetry", "workspace.json");
    if (fs.existsSync(file)) {
      const raw = readWorkspaceFile(file, false) as Record<string, unknown>;
      const primary = bindingOf(raw);
      if (selectedName && primary.name !== selectedName) {
        const clients = raw.clientBindings as Record<string, unknown> | undefined;
        if (clients && typeof clients === "object" && !Array.isArray(clients)) {
          for (const client of ["claude", "codex"]) {
            if (clients[client]) {
              const candidate = bindingOf(clients[client]);
              if (candidate.name === selectedName) return candidate;
            }
          }
        }
      }
      return primary;
    }
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir)
      return null;
    dir = path.dirname(dir);
  }
  throw new Error("Workspace binding search exceeded 64 parents.");
}
export function bindWorkspace(
  repositoryPath: string,
  context: WorkspaceBinding,
  client?: "claude" | "codex",
): string {
  const root = fs.realpathSync(repositoryPath);
  if (
    !fs.statSync(root).isDirectory() ||
    root === os.homedir() ||
    root === path.parse(root).root
  )
    throw new Error("Choose a repository directory.");
  const file = path.join(root, ".codetelemetry", "workspace.json");
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const releaseBinding = workspaceLock(".store");
  try {
  const existing = fs.existsSync(file) ? readWorkspaceFile(file, false) as Record<string, unknown> : null;
  const primary = existing ? bindingOf(existing) : null;
  const sameDestination = primary && primary.apiBase === context.apiBase &&
    JSON.stringify(primary.scope) === JSON.stringify(context.scope);
  const rawClients = existing?.clientBindings;
  const clientBindings: Record<string, WorkspaceBinding> = {};
  if (rawClients !== undefined) {
    if (!rawClients || typeof rawClients !== "object" || Array.isArray(rawClients) ||
      Object.keys(rawClients).some(key => key !== "claude" && key !== "codex")) throw new Error("Invalid repository client bindings.");
    for (const [key, value] of Object.entries(rawClients)) clientBindings[key] = bindingOf(value);
  }
  if (primary && !sameWorkspace(primary, context) && (!client || !sameDestination ||
    (clientBindings[client] && !sameWorkspace(clientBindings[client], context))))
    throw new Error(
      "Repository is bound to another workspace; remove its binding explicitly before switching.",
    );
  if (client) clientBindings[client] = bindingOf(context);
  writeWorkspaceFile(file, { ...(primary ?? bindingOf(context)),
    ...(Object.keys(clientBindings).length ? { clientBindings } : {}) });
  return file;
  } finally { releaseBinding(); }
}
