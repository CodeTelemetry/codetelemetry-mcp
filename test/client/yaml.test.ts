import { test } from "node:test";
import assert from "node:assert/strict";
import { renderYaml, renderScalar } from "../../src/client/yaml.ts";

test("scalars: plain when unambiguous, quoted when not", () => {
  assert.equal(renderScalar("system.cpu.utilization"), "system.cpu.utilization");
  assert.equal(renderScalar("127.0.0.1:13133"), "'127.0.0.1:13133'");
  assert.equal(renderScalar(true), "true");
  assert.equal(renderScalar(60), "60");
  assert.equal(renderScalar(null), "null");
  assert.equal(renderScalar(""), "''");
});

test("scalars that would parse back as another type are quoted", () => {
  // Bare `yes`/`no`/`on`/`off` are booleans in YAML 1.1 — a mount type or
  // interface name spelled that way must survive as a string.
  for (const s of ["yes", "no", "on", "off", "true", "False", "null", "y", "N"]) {
    assert.equal(renderScalar(s), `'${s}'`, `${s} must be quoted`);
  }
  assert.equal(renderScalar("60"), "'60'");
  assert.equal(renderScalar("1.5"), "'1.5'");
  assert.equal(renderScalar("-3"), "'-3'");
});

test("strings with structural characters are quoted and escaped", () => {
  // Durations lead with a digit, so they take the quoted path. That's fine —
  // the collector parses `'10s'` and `10s` identically.
  assert.equal(renderScalar("10s"), "'10s'");
  assert.equal(renderScalar("a: b"), "'a: b'");
  assert.equal(renderScalar("^system\\.cpu\\."), "'^system\\.cpu\\.'");
  assert.equal(renderScalar("it's"), "'it''s'");
  // The exporter header — must stay a literal so the collector expands it.
  assert.equal(renderScalar("Bearer ${env:KEY}"), "'Bearer ${env:KEY}'");
});

test("nested maps indent by two spaces", () => {
  assert.equal(
    renderYaml({ a: { b: { c: 1 } } }),
    ["a:", "  b:", "    c: 1", ""].join("\n"),
  );
});

test("sequences of scalars sit at the parent key's indent", () => {
  assert.equal(
    renderYaml({ service: { extensions: ["health_check", "file_storage/q"] } }),
    ["service:", "  extensions:", "  - health_check", "  - file_storage/q", ""].join("\n"),
  );
});

test("sequences of maps put the first key on the dash line", () => {
  assert.equal(
    renderYaml({ attributes: [{ key: "a", action: "delete" }, { key: "b", action: "delete" }] }),
    [
      "attributes:",
      "- key: a",
      "  action: delete",
      "- key: b",
      "  action: delete",
      "",
    ].join("\n"),
  );
});

test("empty containers render inline", () => {
  assert.equal(renderYaml({ load: {}, none: [] }), ["load: {}", "none: []", ""].join("\n"));
});

test("nested sequence inside a sequence item", () => {
  assert.equal(
    renderYaml({ transforms: [{ include: "^x$", operations: [{ action: "aggregate_labels" }] }] }),
    [
      "transforms:",
      "- include: '^x$'",
      "  operations:",
      "  - action: aggregate_labels",
      "",
    ].join("\n"),
  );
});

test("unsupported nodes throw rather than emitting something wrong", () => {
  assert.throws(() => renderYaml({ bad: undefined as never }), /unsupported YAML node/);
  assert.throws(() => renderScalar(Number.NaN), /non-finite/);
});
