// A deliberately tiny YAML emitter. `connect` is a zero-dependency package (it
// gets curl-piped onto machines we don't control), so we can't pull in `yaml`
// just to write one collector config. This covers exactly the subset the
// host-metrics config uses: nested maps, arrays of scalars, arrays of maps, and
// the four scalar types. Anything else throws rather than emitting something
// that parses differently than it reads.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

// Plain (unquoted) YAML scalars are safe only if they can't be read as another
// type or as structure. Anything else gets single-quoted.
const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_.\-/]*$/;
const RESERVED = new Set([
  "true", "false", "yes", "no", "on", "off", "null", "y", "n",
]);

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function renderScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot emit non-finite number: ${value}`);
    return String(value);
  }
  if (value === "") return "''";
  if (RESERVED.has(value.toLowerCase())) return quote(value);
  // A bare `12` or `1.5` would parse back as a number, not a string.
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(value)) return quote(value);
  if (!PLAIN_SAFE.test(value)) return quote(value);
  return value;
}

function isScalar(v: YamlValue): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isEmptyContainer(v: YamlValue): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && v !== null) return Object.keys(v).length === 0;
  return false;
}

function renderInlineEmpty(v: YamlValue): string {
  return Array.isArray(v) ? "[]" : "{}";
}

function renderNode(value: YamlValue, indent: number): string[] {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isScalar(item)) return [`${pad}- ${renderScalar(item)}`];
      if (isEmptyContainer(item)) return [`${pad}- ${renderInlineEmpty(item)}`];
      // `- ` then the child's first line, so the dash sits on the same row.
      const lines = renderNode(item, indent + 1);
      return [`${pad}- ${lines[0].trimStart()}`, ...lines.slice(1)];
    });
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => {
      const k = renderScalar(key);
      if (isScalar(child)) return [`${pad}${k}: ${renderScalar(child)}`];
      if (isEmptyContainer(child)) return [`${pad}${k}: ${renderInlineEmpty(child)}`];
      // Sequences sit at the parent's indent level (valid YAML, and what the
      // hand-written collector configs in this repo look like).
      const childIndent = Array.isArray(child) ? indent : indent + 1;
      return [`${pad}${k}:`, ...renderNode(child, childIndent)];
    });
  }

  throw new Error(`unsupported YAML node: ${String(value)}`);
}

/** Render a JS value as YAML text (trailing newline included). */
export function renderYaml(value: YamlValue): string {
  if (isScalar(value)) return renderScalar(value) + "\n";
  if (isEmptyContainer(value)) return renderInlineEmpty(value) + "\n";
  return renderNode(value, 0).join("\n") + "\n";
}
