// ELL-43: the pure plan normalizer — plain text, structured steps, mixed input,
// optional context, the step shape, and every input bound. This is the shared
// definition of a valid plan; the MCP tool leans on it, so the rules are asserted
// here once rather than duplicated at the protocol layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlan, MAX_PLAN_TEXT, MAX_PLAN_STEPS } from "../../src/client/plan.ts";

function ok(raw: Record<string, unknown>) {
  const r = normalizePlan(raw);
  assert.equal(r.ok, true, `expected ok for ${JSON.stringify(raw)}: ${r.ok ? "" : r.message}`);
  if (!r.ok) throw new Error("unreachable");
  return r.plan;
}

test("plain-text plan normalizes to one sized unit", () => {
  const plan = ok({ planText: "Migrate the ClickHouse schema and backfill rows." });
  assert.equal(plan.taskText, "Migrate the ClickHouse schema and backfill rows.");
  assert.equal(plan.repo, undefined);
  assert.equal(plan.source.format, "text");
  assert.equal(plan.source.stepCount, 0);
  assert.deepEqual(plan.source.steps, []);
  assert.equal(plan.source.contentChars, plan.taskText.length);
  assert.equal(plan.source.kind, "plan");
});

test("structured steps preserve their submitted order and boundaries", () => {
  const plan = ok({
    title: "Add estimate_plan",
    steps: [
      { title: "Normalize", detail: "text + steps → task contract" },
      "Validate the input bounds",
      { detail: "Return the shared result schema" },
    ],
  });
  assert.equal(plan.source.format, "steps");
  assert.equal(plan.source.stepCount, 3);
  assert.deepEqual(
    plan.source.steps.map((s) => ({ index: s.index, title: s.title })),
    [
      { index: 1, title: "Normalize" },
      { index: 2, title: null },
      { index: 3, title: null },
    ],
  );
  // Title leads; steps are numbered in submitted order.
  assert.match(plan.taskText, /^Add estimate_plan\n\nPlan steps:\n1\. Normalize: text \+ steps/);
  assert.match(plan.taskText, /2\. Validate the input bounds/);
  assert.match(plan.taskText, /3\. Return the shared result schema/);
  assert.equal(plan.source.title, "Add estimate_plan");
});

test("text and steps combine as text+steps", () => {
  const plan = ok({ planText: "Overview line.", steps: ["do a", "do b"] });
  assert.equal(plan.source.format, "text+steps");
  assert.equal(plan.source.stepCount, 2);
  assert.match(plan.taskText, /^Overview line\.\n\nPlan steps:\n1\. do a\n2\. do b$/);
});

test("optional context is echoed; only repo steers sizing", () => {
  const plan = ok({
    planText: "Ship it",
    repo: "elo",
    project: "CodeTelemetry",
    provider: "codex",
    model: "gpt-5-codex",
  });
  assert.equal(plan.repo, "elo");
  assert.equal(plan.source.repo, "elo");
  assert.equal(plan.source.project, "CodeTelemetry");
  assert.equal(plan.source.provider, "codex");
  assert.equal(plan.source.model, "gpt-5-codex");
  // Context is provenance only — it must not leak into the sized text.
  assert.equal(plan.taskText, "Ship it");
});

test("requires some content", () => {
  for (const raw of [{}, { title: "just a title" }, { steps: [] }, { planText: "   " }] as Record<string, unknown>[]) {
    const r = normalizePlan(raw);
    assert.equal(r.ok, false, `rejects ${JSON.stringify(raw)}`);
  }
});

test("rejects malformed steps and out-of-range fields", () => {
  const cases: Record<string, unknown>[] = [
    { steps: "not an array" },
    { steps: [123] },
    { steps: [{}] },
    { steps: [{ title: "", detail: "" }] },
    { steps: [{ note: "unknown key still needs content" }] },
    { steps: [null] },
    { steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_v, i) => `s${i}`) },
    { planText: "x".repeat(MAX_PLAN_TEXT + 1) },
    { planText: "ok", title: "t".repeat(301) },
    { planText: "ok", repo: 7 },
    { planText: "ok", provider: "cursor" },
    { planText: "ok", model: "m".repeat(200) },
  ];
  for (const raw of cases) {
    const r = normalizePlan(raw);
    assert.equal(r.ok, false, `rejects ${JSON.stringify(raw).slice(0, 60)}`);
  }
});

test("rejects an assembled plan that exceeds the sizing bound", () => {
  // Each field is under its own cap, but together they exceed MAX_PLAN_TEXT.
  const half = "a".repeat(2_500);
  const r = normalizePlan({ planText: half, steps: [half] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /Assembled plan is \d+ characters/);
});

test("an unknown-key object step is accepted when it carries a detail", () => {
  // A bare string step is the detail; an object with only stray keys has no
  // content and is rejected (covered above). Here the object carries a detail.
  const plan = ok({ steps: [{ detail: "real content", title: "T" }] });
  assert.equal(plan.source.steps[0].chars, "real content".length + "T".length);
});
