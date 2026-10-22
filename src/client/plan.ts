// ELL-43: normalize a coding-assistant PLAN (from Claude Code or Codex) into the
// task/context contract the shared sizing engine already consumes.
//
// A plan is either plain text or an ordered list of steps, plus optional title
// and repo/project/provider/model context. This module is the reuse seam: it is
// pure and does ALL semantic validation, so both the unit tests and the MCP tool
// share one definition of a valid plan and one normalization. The result is a
// single `taskText` sized as ONE unit — submitted step boundaries are preserved
// in `source` for provenance, but the estimate never silently sums independently
// sized steps.
//
// Deliberately NOT here: model/provider/project do not steer the sizing engine
// (which sizes against the caller's own history, provider-agnostic); they are
// echoed in `source` as context only. Only `repo` reaches the engine, where it
// selects a repo-calibrated ladder.

import { ONBOARD_CLIENTS } from "./assistants.ts";

/** Mirrors the server's MAX_TASK_TEXT (packages/api sizing/taskMatching.ts). The
 *  assembled plan text must fit it, so an over-long plan earns a clean local
 *  rejection instead of a server 400. */
export const MAX_PLAN_TEXT = 4_000;
export const MAX_PLAN_TITLE = 300;
export const MAX_PLAN_STEP_TITLE = 300;
export const MAX_PLAN_STEP_DETAIL = 4_000;
export const MAX_PLAN_STEPS = 50;
export const MAX_PLAN_REPO = 200;
export const MAX_PLAN_PROJECT = 200;
export const MAX_PLAN_MODEL = 120;

/** The recognized coding-assistant providers: the assistants onboarding can
 *  connect (a plan comes from an assistant the user runs with CodeTelemetry).
 *  Free-form is rejected so the field stays a stable enum a consumer can
 *  branch on. */
export const PLAN_PROVIDERS = ONBOARD_CLIENTS;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/** One submitted plan step. A bare string is treated as the step's detail. */
export type PlanStepInput = string | { title?: string; detail?: string };

export type PlanInput = {
  /** Plain-text plan. Combined with `steps` when both are given. */
  planText?: string;
  /** Ordered structured steps. Order is preserved into `source.steps`. */
  steps?: PlanStepInput[];
  /** Optional plan title, used as the leading line of the sized text. */
  title?: string;
  /** Repo the work will land in — the ONE field that steers sizing (repo ladder). */
  repo?: string;
  /** Higher-level project grouping. Provenance only; does not steer sizing. */
  project?: string;
  /** Which coding assistant produced the plan. Provenance only. */
  provider?: PlanProvider;
  /** Model id the caller knows produced the plan. Provenance only. */
  model?: string;
};

/** A submitted step, boundary-preserved. `chars` is the length of its own
 *  content (title + detail) as submitted, so a consumer can see how the plan was
 *  weighted without the estimate ever summing per-step sizes. */
export type PlanSourceStep = {
  index: number;
  title: string | null;
  chars: number;
};

export type PlanSource = {
  kind: "plan";
  title: string | null;
  /** How the content arrived, so a consumer knows what it sized. */
  format: "text" | "steps" | "text+steps";
  stepCount: number;
  steps: PlanSourceStep[];
  repo: string | null;
  project: string | null;
  provider: PlanProvider | null;
  model: string | null;
  /** Length of the assembled `taskText` actually sized. */
  contentChars: number;
};

export type NormalizedPlan = {
  /** The single sized unit handed to the engine's `taskText` contract. */
  taskText: string;
  /** Passed through to the engine's `repo` field when present. */
  repo?: string;
  source: PlanSource;
};

export type NormalizePlanResult =
  | { ok: true; plan: NormalizedPlan }
  | { ok: false; message: string };

const bad = (message: string): NormalizePlanResult => ({ ok: false, message });

/** Absent → undefined; wrong type or over-long → null (rejected). Trims, so a
 *  whitespace-only value normalizes to "". */
function boundedString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) return null;
  return value.trim();
}

/**
 * Validate and normalize raw plan args into the sizing contract. Accepts the raw
 * object so the MCP tool stays thin: every bound, the step shape, the required
 * content, and the optional context are checked here.
 */
export function normalizePlan(raw: Record<string, unknown>): NormalizePlanResult {
  const planText = boundedString(raw.planText, MAX_PLAN_TEXT);
  if (planText === null) {
    return bad(`planText must be a string of at most ${MAX_PLAN_TEXT} characters`);
  }
  const title = boundedString(raw.title, MAX_PLAN_TITLE);
  if (title === null) return bad(`title must be a string of at most ${MAX_PLAN_TITLE} characters`);

  const repo = boundedString(raw.repo, MAX_PLAN_REPO);
  if (repo === null) return bad(`repo must be a string of at most ${MAX_PLAN_REPO} characters`);
  const project = boundedString(raw.project, MAX_PLAN_PROJECT);
  if (project === null) return bad(`project must be a string of at most ${MAX_PLAN_PROJECT} characters`);
  const model = boundedString(raw.model, MAX_PLAN_MODEL);
  if (model === null) return bad(`model must be a string of at most ${MAX_PLAN_MODEL} characters`);

  let provider: PlanProvider | undefined;
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !PLAN_PROVIDERS.includes(raw.provider as PlanProvider)) {
      return bad(`provider must be one of ${PLAN_PROVIDERS.join(", ")}`);
    }
    provider = raw.provider as PlanProvider;
  }

  // Steps: an ordered array of strings and/or { title?, detail? }. Each step must
  // carry some content; a shapeless or empty step is rejected rather than silently
  // dropped, so the preserved boundaries in `source` match what was submitted.
  const stepLines: string[] = [];
  const sourceSteps: PlanSourceStep[] = [];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) return bad("steps must be an array");
    if (raw.steps.length > MAX_PLAN_STEPS) return bad(`steps must contain at most ${MAX_PLAN_STEPS} items`);
    for (let i = 0; i < raw.steps.length; i++) {
      const step = raw.steps[i];
      let stepTitle: string | undefined;
      let stepDetail: string | undefined;
      if (typeof step === "string") {
        stepDetail = step.trim();
      } else if (step !== null && typeof step === "object" && !Array.isArray(step)) {
        const obj = step as Record<string, unknown>;
        const t = boundedString(obj.title, MAX_PLAN_STEP_TITLE);
        const d = boundedString(obj.detail, MAX_PLAN_STEP_DETAIL);
        if (t === null) return bad(`steps[${i}].title must be a string of at most ${MAX_PLAN_STEP_TITLE} characters`);
        if (d === null) return bad(`steps[${i}].detail must be a string of at most ${MAX_PLAN_STEP_DETAIL} characters`);
        stepTitle = t || undefined;
        stepDetail = d || undefined;
      } else {
        return bad(`steps[${i}] must be a string or an object with title/detail`);
      }
      if (!stepTitle && !stepDetail) {
        return bad(`steps[${i}] must have a non-empty title or detail`);
      }
      const label = stepTitle && stepDetail ? `${stepTitle}: ${stepDetail}` : stepTitle ?? stepDetail!;
      stepLines.push(`${i + 1}. ${label}`);
      sourceSteps.push({
        index: i + 1,
        title: stepTitle ?? null,
        chars: (stepTitle?.length ?? 0) + (stepDetail?.length ?? 0),
      });
    }
  }

  const hasText = !!planText;
  const hasSteps = sourceSteps.length > 0;
  if (!hasText && !hasSteps) {
    return bad("Provide planText or at least one step to estimate.");
  }

  // Assemble the single sized unit. Title leads; the plan body and steps follow.
  const parts: string[] = [];
  if (title) parts.push(title);
  if (planText) parts.push(planText);
  if (hasSteps) parts.push(`Plan steps:\n${stepLines.join("\n")}`);
  const taskText = parts.join("\n\n");

  if (taskText.length > MAX_PLAN_TEXT) {
    return bad(
      `Assembled plan is ${taskText.length} characters; keep title, plan text, and steps under ${MAX_PLAN_TEXT} together.`,
    );
  }

  const format: PlanSource["format"] = hasText && hasSteps ? "text+steps" : hasSteps ? "steps" : "text";
  const source: PlanSource = {
    kind: "plan",
    title: title || null,
    format,
    stepCount: sourceSteps.length,
    steps: sourceSteps,
    repo: repo || null,
    project: project || null,
    provider: provider ?? null,
    model: model || null,
    contentChars: taskText.length,
  };

  return { ok: true, plan: { taskText, ...(repo ? { repo } : {}), source } };
}
