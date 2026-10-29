// Local, bounded source discovery for Grader setup. Files are data: never import
// a task file, evaluate a build system, or run a discovered command.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type GraderMatcherNode =
  | { field: string; operator: string; value?: string | string[] }
  | { all: GraderMatcherNode[] }
  | { any: GraderMatcherNode[] }
  | { not: GraderMatcherNode };
export type GraderCheck = {
  id: string;
  name: string;
  category: string;
  description?: string;
  weight: number;
  satisfactionMode: "observed" | "successful";
  minimumOccurrences: number;
  aggregationMode: "once";
  enabled: boolean;
  repositoryId?: string;
  matcherRule: { include: GraderMatcherNode; exclude?: GraderMatcherNode };
};
export type GraderSeed = {
  features: string;
  sources: Array<{ path: string; kind: "instructions" | "skill"; text: string; truncated: boolean }>;
  candidates: Array<{ source: string; command: string; inferred: boolean; check: GraderCheck }>;
  warnings: string[];
  truncated: boolean;
};

const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "coverage", "__pycache__", "venv", "env"]);
const TASK_FILES = new Set([
  "package.json", "Makefile", "makefile", "GNUmakefile", "justfile", "Justfile",
  "pyproject.toml", "tox.ini", "noxfile.py", "go.mod", "Cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "composer.json", "Rakefile", "mix.exs", "Package.swift", "CMakeLists.txt",
]);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 4000;
const MAX_CANDIDATES = 30;
const MAX_SOURCE_CHARS = 6000;
const MAX_DEPTH = 6;

/** No-follow open, bounded read, and fstat avoid links, FIFOs, and growth races. */
function readSource(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("not a regular file of at most 64 KiB");
    const data = Buffer.alloc(MAX_FILE_BYTES + 1);
    const bytes = fs.readSync(fd, data, 0, data.length, 0);
    if (bytes > MAX_FILE_BYTES) throw new Error("file exceeds 64 KiB");
    return data.subarray(0, bytes).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function category(name: string): string | undefined {
  if (/(?:^|[:_\-])(deploy|publish|release|install|watch|dev|serve|clean|fix)(?:$|[:_\-])/.test(name)) return undefined;
  if (/(?:e2e|end.to.end)/.test(name)) return "end_to_end_test";
  if (/integration/.test(name)) return "integration_test";
  if (/coverage|cov$/.test(name)) return "coverage";
  if (/(?:^|[:_\-])(test|tests|spec|unit)(?:$|[:_\-])/.test(name)) return "unit_test";
  if (/audit|security/.test(name)) return "security_validation";
  if (/lint|check|typecheck|type-check|format|verify/.test(name)) return "static_analysis";
  if (/^build$|^compile$/.test(name)) return "environment_validation";
  return undefined;
}
const condition = (field: string, value: string | string[]): GraderMatcherNode => ({
  field, operator: Array.isArray(value) ? "contains" : "equals", value,
});
const shell = (executable: string, args: string[] = [], operation?: string): GraderMatcherNode => ({ all: [
  condition("source", "shell"), condition("executable", executable),
  ...(operation ? [condition("operation", operation)] : []),
  ...args.map((arg) => condition("normalizedArguments", [arg])),
] });
const targetMatcher = (executable: string, target: string): GraderMatcherNode => ({ all: [
  condition("source", "shell"), condition("executable", executable),
  { any: [condition("operation", target), condition("normalizedArguments", [target])] },
] });

export function seedGraderConfig(options: { root: string; features: string; skillPaths?: string[]; repositoryId?: string }): GraderSeed {
  const root = fs.realpathSync(options.root);
  if (!fs.statSync(root).isDirectory()) throw new Error("repositoryPath must be a directory");
  const result: GraderSeed = { features: options.features, sources: [], candidates: [], warnings: [], truncated: false };
  let entries = 0;
  let sourceChars = 0;
  const visited = new Set<string>();
  const seenCandidates = new Set<string>();
  const warn = (message: string) => { if (result.warnings.length < 12) result.warnings.push(message); result.truncated = true; };
  const add = (file: string, command: string, label: string, matcher: GraderMatcherNode, inferred = false) => {
    const kind = category(label.toLowerCase());
    if (!kind || command.length > 256 || /[\r\n\x00]/.test(command)) return;
    const source = path.relative(root, file).split(path.sep).join("/");
    const identity = `${options.repositoryId ?? root}\0${source}\0${command}`;
    if (seenCandidates.has(identity)) return;
    seenCandidates.add(identity);
    if (result.candidates.length >= MAX_CANDIDATES) { warn("Command candidate limit reached; narrow repositoryPath to inspect another package."); return; }
    // A cwd restriction keeps identically named monorepo scripts distinct. The
    // repositoryId, when supplied, is the server's repository identity.
    const directory = path.dirname(file);
    if (directory.length > 200) warn("Working-directory scope exceeds matcher limits; set repositoryId before saving.");
    result.candidates.push({ source, command, inferred, check: {
      id: `seed-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      name: `${source}: ${label}`.slice(0, 120), category: kind,
      description: `Seeded from ${source}. ${inferred ? "Conventional command; confirm project support." : "Declared project task."}`.slice(0, 500),
      weight: 1, satisfactionMode: "successful", minimumOccurrences: 1, aggregationMode: "once", enabled: true,
      ...(options.repositoryId ? { repositoryId: options.repositoryId } : {}),
      matcherRule: { include: { all: [matcher, ...(directory.length <= 200 ? [condition("workingDirectory", directory)] : [])] },
        exclude: { field: "normalizedArguments", operator: "contains", value: ["--watch", "--watchAll", "--collect-only", "--listTests", "--dry-run", "--no-run", "--help", "--version"] } },
    } });
  };
  const inspect = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const name = path.basename(file);
    let text: string;
    try { text = readSource(file); } catch { warn(`Skipped unreadable, linked, or oversized source: ${path.relative(root, file)}`); return; }
    if (/^agents\.md$/i.test(name) || name === "SKILL.md") {
      const remaining = MAX_SOURCE_CHARS - sourceChars;
      if (remaining <= 0 || result.sources.length >= 12) { warn("Instruction budget reached; use a narrower repositoryPath or fewer skillPaths."); return; }
      const clipped = text.slice(0, Math.min(3000, remaining));
      sourceChars += clipped.length;
      const truncated = clipped.length !== text.length;
      if (truncated) result.truncated = true;
      result.sources.push({ path: path.relative(root, file).split(path.sep).join("/"), kind: name === "SKILL.md" ? "skill" : "instructions", text: clipped, truncated });
      return;
    }
    if (name === "package.json" || name === "composer.json") {
      try {
        const data = JSON.parse(text) as { scripts?: Record<string, unknown>; packageManager?: string };
        let runner = "npm";
        if (typeof data.packageManager === "string") runner = /^(pnpm|yarn|bun)@/.exec(data.packageManager)?.[1] ?? "npm";
        else for (const [lock, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]]) {
          if (fs.existsSync(path.join(path.dirname(file), lock!))) { runner = manager!; break; }
        }
        if (data.scripts && typeof data.scripts === "object" && !Array.isArray(data.scripts)) for (const [task, body] of Object.entries(data.scripts)) {
          if (!/^[A-Za-z0-9][A-Za-z0-9:_\-.]{0,79}$/.test(task) || typeof body !== "string") continue;
          // Discovery never runs scripts. Obvious watch/list/fix placeholders do
          // not seed a requirement that claims successful validation.
          if (/--(?:watch|fix|collect-only|listTests|dry-run)\b|no test specified|echo\s+["']?no tests/i.test(body)) continue;
          if (/format/i.test(task) && !/--check|--list-different|--check-formatted/.test(body)) continue;
          add(file, `${name === "composer.json" ? "composer" : runner} run ${task}`, task,
            name === "composer.json" ? shell("composer", [task], "run") : { all: [
              condition("source", "shell"), { field: "executable", operator: "in", value: ["npm", "pnpm", "yarn", "bun"] }, condition("packageScript", task),
            ] });
        }
      } catch { warn(`Invalid JSON in ${path.relative(root, file)}`); }
      return;
    }
    if (/^(?:GNUmakefile|[Mm]akefile|[Jj]ustfile|Rakefile)$/.test(name)) {
      const just = /justfile/i.test(name);
      const rake = name === "Rakefile";
      const targetPattern = rake ? /^\s*task\s+[:"']([\w:-]+)/gm : /^([A-Za-z][\w.\-]*(?:[ \t]+[A-Za-z][\w.\-]*)*)[ \t]*:(?!=)/gm;
      for (const match of text.matchAll(targetPattern)) for (const task of match[1]!.split(/\s+/)) {
        const runner = rake ? "rake" : just ? "just" : "make";
        add(file, `${runner} ${task}`, task, targetMatcher(runner, task));
      }
      return;
    }
    const conventional = (command: string, label: string, exe: string, args: string[] = [], operation?: string) => add(file, command, label, shell(exe, args, operation), true);
    if (name === "pyproject.toml") {
      if (/^\[tool\.pytest(?:\.|\])/m.test(text) || /["']pytest(?:["'\s><=~!\[])/m.test(text)) conventional("python -m pytest", "test", "pytest");
      if (/^\[tool\.ruff(?:\.|\])/m.test(text)) conventional("ruff check .", "lint", "ruff", ["check", "<path>"]);
      if (/^\[tool\.mypy\]/m.test(text)) conventional("mypy .", "typecheck", "mypy");
    } else if (name === "tox.ini") conventional("tox", "test", "tox");
    else if (name === "noxfile.py") {
      for (const match of text.matchAll(/^@nox\.session(?:\([^\n]*\))?\s*\n(?:@[^\n]*\n)*def\s+(\w+)\s*\(/gm)) conventional(`nox -s ${match[1]}`, match[1]!, "nox", ["-s", match[1]!]);
    } else if (name === "go.mod") {
      conventional("go test ./...", "test", "go", ["<path>"], "test");
      conventional("go vet ./...", "lint", "go", ["<path>"], "vet");
    } else if (name === "Cargo.toml") {
      conventional("cargo test", "test", "cargo", [], "test");
      conventional("cargo check", "check", "cargo", [], "check");
    } else if (name === "pom.xml") conventional("mvn test", "test", "mvn", [], "test");
    else if (/^build\.gradle/.test(name)) {
      const wrapper = fs.existsSync(path.join(path.dirname(file), "gradlew"));
      conventional(`${wrapper ? "./gradlew" : "gradle"} test`, "test", wrapper ? "gradlew" : "gradle", wrapper ? ["test"] : [], wrapper ? undefined : "test");
    } else if (name === "mix.exs") conventional("mix test", "test", "mix", [], "test");
    else if (name === "Package.swift") conventional("swift test", "test", "swift", [], "test");
    else if (name.endsWith(".csproj") || name.endsWith(".fsproj")) conventional(`dotnet test ${name}`, "test", "dotnet", ["<path>"], "test");
    else if (name === "CMakeLists.txt" && /enable_testing\s*\(|include\s*\(\s*CTest\s*\)/i.test(text)) conventional("ctest --test-dir build", "test", "ctest", ["--test-dir", "build"]);
  };
  const walk = (directory: string, depth: number, skillsOnly = false) => {
    if (depth > MAX_DEPTH) { warn("Directory depth limit reached."); return; }
    const children: fs.Dirent[] = [];
    try {
      const handle = fs.opendirSync(directory);
      try {
        let entry: fs.Dirent | null;
        while ((entry = handle.readSync()) !== null) {
          if (++entries > MAX_ENTRIES) { warn("File discovery limit reached."); break; }
          children.push(entry);
        }
      } finally { handle.closeSync(); }
      children.sort((a, b) => a.name.localeCompare(b.name));
    } catch { warn(`Skipped unreadable directory: ${path.relative(root, directory)}`); return; }
    // Root instructions and task files precede nested packages.
    for (const entry of children) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && (skillsOnly ? entry.name === "SKILL.md" : /^agents\.md$/i.test(entry.name) || entry.name === "SKILL.md" || TASK_FILES.has(entry.name) || /\.(?:csproj|fsproj)$/.test(entry.name))) inspect(file);
    }
    for (const entry of children) {
      if (entries >= MAX_ENTRIES) return;
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.name.startsWith(".")) {
        if ([".claude", ".codex", ".agents"].includes(entry.name)) {
          const skills = path.join(child, "skills");
          try { if (fs.lstatSync(skills).isDirectory()) walk(skills, depth + 1, true); } catch { /* absent */ }
        }
        continue;
      }
      walk(child, depth + 1, skillsOnly);
    }
  };
  walk(root, 0);
  // User-selected external skills are explicit inputs; nothing in the home
  // directory is discovered implicitly. Reject symlinked path components.
  for (const selected of options.skillPaths ?? []) {
    const absolute = path.resolve(root, selected);
    if (fs.realpathSync(absolute) !== absolute) throw new Error("skillPaths must not contain symbolic links");
    if (path.basename(absolute) !== "SKILL.md") throw new Error("skillPaths must name SKILL.md files");
    inspect(absolute);
  }
  // MCP carries both a pretty text projection and structured content. Bound
  // both, including escaped/non-ASCII source text, before returning a useful
  // partial seed instead of losing the whole response to the transport cap.
  const wireBytes = () => Buffer.byteLength(JSON.stringify(result)) + Buffer.byteLength(JSON.stringify(JSON.stringify(result, null, 2)));
  while (wireBytes() > 52 * 1024) {
    warn("Response budget reached; narrow repositoryPath or select fewer sources.");
    if (result.candidates.length > 1) result.candidates.pop();
    else if (result.sources.length) {
      const source = result.sources[result.sources.length - 1]!;
      if (source.text.length > 256) { source.text = source.text.slice(0, Math.floor(source.text.length / 2)); source.truncated = true; }
      else result.sources.pop();
    } else break;
  }
  return result;
}
