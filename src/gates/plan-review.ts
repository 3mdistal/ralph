import { readFile } from "fs/promises";
import { join } from "path";

import { parseStrictFinalLineJsonMarker } from "../markers";
import { hasProductGap } from "../product-gap";
import { recordRalphRunGateArtifact, upsertRalphRunGateResult } from "../state";
import { isDefaultRalphPlanTemplate, RALPH_PLAN_RELATIVE_PATH } from "../worktree-artifacts";

import type { StrictJsonMarkerParseFailure } from "../markers";
import type { SessionResult } from "../session";

type PlanReviewMarkerFailure = StrictJsonMarkerParseFailure | "invalid_status" | "missing_reason";

type PlanReviewMarkerParseResult =
  | { ok: true; status: "pass" | "fail"; reason: string; markerLine: string }
  | { ok: false; failure: PlanReviewMarkerFailure; reason: string };

type PlanReviewMarkerParseArtifact = {
  version: 1;
  ok: boolean;
  failure: PlanReviewMarkerFailure | null;
  reason: string;
  markerLine: string | null;
};

export type PlanReviewInputSource = "plan_file" | "planner_output" | "missing";

export type PlanReviewInput = {
  source: PlanReviewInputSource;
  planText: string;
  note: string;
};

export type PlanReviewGateResult = {
  status: "pass" | "fail";
  reason: string;
  hasProductGap: boolean;
  output: string;
  sessionId?: string;
};

const PLAN_REVIEW_MARKER_PREFIX = "RALPH_PLAN_REVIEW";
const MAX_REPAIR_ATTEMPTS = 2;

function validatePlanReviewPayload(value: unknown):
  | { ok: true; status: "pass" | "fail"; reason: string }
  | { ok: false; failure: "invalid_status" | "missing_reason"; reason: string } {
  const payload = value as { status?: unknown; reason?: unknown };
  if (payload?.status !== "pass" && payload?.status !== "fail") {
    return {
      ok: false,
      failure: "invalid_status",
      reason: "Plan-review marker invalid: status must be pass|fail",
    };
  }

  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!reason) {
    return {
      ok: false,
      failure: "missing_reason",
      reason: "Plan-review marker invalid: reason is required",
    };
  }

  return { ok: true, status: payload.status, reason };
}

export function parseRalphPlanReviewMarker(output: string): PlanReviewMarkerParseResult {
  const parsed = parseStrictFinalLineJsonMarker<unknown>(output, PLAN_REVIEW_MARKER_PREFIX);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: parsed.failure,
      reason: `Plan-review marker invalid: ${parsed.error}`,
    };
  }

  const payload = validatePlanReviewPayload(parsed.value);
  if (!payload.ok) return payload;
  return {
    ok: true,
    status: payload.status,
    reason: payload.reason,
    markerLine: parsed.markerLine,
  };
}

function buildPlanReviewPrompt(params: {
  repo: string;
  issueRef: string;
  planText: string;
  issueContext?: string;
}): string {
  const issueContext = params.issueContext?.trim();
  const lines = [
    "Plan-stage product review (deterministic gate)",
    "IMPORTANT: do not call tools.",
    "Review the implementation plan against canonical claims/docs.",
    "If guidance is missing, emit PRODUCT GAP: on its own line before the final marker.",
    `Repo: ${params.repo}`,
    `Issue: ${params.issueRef}`,
    "",
    "Plan content:",
    "```md",
    params.planText,
    "```",
  ];

  if (issueContext) {
    lines.push("", "Issue context:", issueContext);
  }

  lines.push(
    "",
    "Return exactly one final line marker:",
    'RALPH_PLAN_REVIEW: {"status":"pass"|"fail","reason":"..."}'
  );

  return lines.join("\n");
}

function buildPlanReviewRepairPrompt(reason: string, priorOutput: string): string {
  const prior = String(priorOutput ?? "");
  return [
    "Your prior plan-review response failed deterministic marker parsing.",
    `Parser error: ${reason}`,
    "Do not call tools.",
    "Prior response (verbatim):",
    "```",
    prior,
    "```",
    "Do not change your review decision; only fix marker formatting.",
    "Re-emit exactly one final line with valid JSON:",
    'RALPH_PLAN_REVIEW: {"status":"pass"|"fail","reason":"..."}',
    "No code fences.",
    "No extra lines before or after.",
  ].join("\n");
}

function buildPlanReviewParseArtifact(parsed: PlanReviewMarkerParseResult): string {
  const payload: PlanReviewMarkerParseArtifact = parsed.ok
    ? {
        version: 1,
        ok: true,
        failure: null,
        reason: parsed.reason,
        markerLine: parsed.markerLine,
      }
    : {
        version: 1,
        ok: false,
        failure: parsed.failure,
        reason: parsed.reason,
        markerLine: null,
      };
  return JSON.stringify(payload, null, 2);
}

function isRepairableMarkerFailure(failure: PlanReviewMarkerFailure): boolean {
  return (
    failure === "missing_marker" ||
    failure === "multiple_markers" ||
    failure === "marker_not_final_line" ||
    failure === "missing_json" ||
    failure === "invalid_json"
  );
}

export async function resolvePlanReviewInput(params: {
  worktreePath: string;
  plannerOutput: string;
}): Promise<PlanReviewInput> {
  const planPath = join(params.worktreePath, RALPH_PLAN_RELATIVE_PATH);

  let planFileText = "";
  try {
    planFileText = await readFile(planPath, "utf8");
  } catch {
    planFileText = "";
  }

  const normalizedPlanFile = String(planFileText ?? "").trim();
  if (normalizedPlanFile && !isDefaultRalphPlanTemplate(normalizedPlanFile)) {
    return {
      source: "plan_file",
      planText: normalizedPlanFile,
      note: `Using plan input from ${RALPH_PLAN_RELATIVE_PATH}`,
    };
  }

  const plannerOutput = String(params.plannerOutput ?? "").trim();
  if (plannerOutput) {
    return {
      source: "planner_output",
      planText: plannerOutput,
      note: `Using planner output as plan input because ${RALPH_PLAN_RELATIVE_PATH} is missing/empty/default`,
    };
  }

  return {
    source: "missing",
    planText: "",
    note: `Plan input unavailable: ${RALPH_PLAN_RELATIVE_PATH} missing/empty/default and planner output empty`,
  };
}

export async function runPlanReviewGate(params: {
  runId: string;
  repo: string;
  issueRef: string;
  planInput: PlanReviewInput;
  issueContext?: string;
  runAgent: (prompt: string) => Promise<SessionResult>;
  runRepairAgent?: (prompt: string) => Promise<SessionResult>;
}): Promise<PlanReviewGateResult> {
  const gate = "plan_review" as const;
  upsertRalphRunGateResult({ runId: params.runId, gate, status: "pending" });
  recordRalphRunGateArtifact({ runId: params.runId, gate, kind: "note", content: params.planInput.note });

  if (params.planInput.source === "missing" || !params.planInput.planText.trim()) {
    const reason = params.planInput.note;
    upsertRalphRunGateResult({ runId: params.runId, gate, status: "fail", reason });
    return { status: "fail", reason, hasProductGap: false, output: "" };
  }

  const prompt = buildPlanReviewPrompt({
    repo: params.repo,
    issueRef: params.issueRef,
    planText: params.planInput.planText,
    issueContext: params.issueContext,
  });

  let result: SessionResult;
  try {
    result = await params.runAgent(prompt);
  } catch (error: any) {
    const reason = `Plan-review agent failed: ${error?.message ?? String(error)}`;
    upsertRalphRunGateResult({ runId: params.runId, gate, status: "fail", reason });
    recordRalphRunGateArtifact({
      runId: params.runId,
      gate,
      kind: "note",
      content: `Plan-review agent error:\n${reason}`,
    });
    return { status: "fail", reason, hasProductGap: false, output: "" };
  }

  let latestOutput = result.output ?? "";
  let finalSessionId = result.sessionId;
  recordRalphRunGateArtifact({ runId: params.runId, gate, kind: "command_output", content: latestOutput });

  if (!result.success) {
    const reason = "Plan-review agent did not complete successfully";
    upsertRalphRunGateResult({ runId: params.runId, gate, status: "fail", reason });
    return {
      status: "fail",
      reason,
      hasProductGap: hasProductGap(latestOutput),
      output: latestOutput,
      sessionId: finalSessionId,
    };
  }

  let parsed = parseRalphPlanReviewMarker(latestOutput);
  recordRalphRunGateArtifact({
    runId: params.runId,
    gate,
    kind: "failure_excerpt",
    content: buildPlanReviewParseArtifact(parsed),
  });

  for (let attempt = 1; !parsed.ok && isRepairableMarkerFailure(parsed.failure) && attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const repairPrompt = buildPlanReviewRepairPrompt(parsed.reason, latestOutput);
    recordRalphRunGateArtifact({
      runId: params.runId,
      gate,
      kind: "note",
      content: [`Plan-review marker parse failed (attempt ${attempt}); requesting repair:`, parsed.reason].join("\n"),
    });

    try {
      const repairRunner = params.runRepairAgent ?? (async (repairPromptText: string) => await params.runAgent(repairPromptText));
      const repair = await repairRunner(repairPrompt);
      finalSessionId = repair.sessionId ?? finalSessionId;
      latestOutput = repair.output ?? "";
      recordRalphRunGateArtifact({ runId: params.runId, gate, kind: "command_output", content: latestOutput });

      if (!repair.success) {
        parsed = {
          ok: false,
          failure: "missing_marker",
          reason: "Plan-review repair attempt did not complete successfully",
        };
        continue;
      }

      parsed = parseRalphPlanReviewMarker(latestOutput);
      recordRalphRunGateArtifact({
        runId: params.runId,
        gate,
        kind: "failure_excerpt",
        content: buildPlanReviewParseArtifact(parsed),
      });
    } catch {
      parsed = {
        ok: false,
        failure: "missing_marker",
        reason: "Plan-review repair attempt failed to execute",
      };
    }
  }

  if (!parsed.ok) {
    upsertRalphRunGateResult({ runId: params.runId, gate, status: "fail", reason: parsed.reason });
    return {
      status: "fail",
      reason: parsed.reason,
      hasProductGap: hasProductGap(latestOutput),
      output: latestOutput,
      sessionId: finalSessionId,
    };
  }

  upsertRalphRunGateResult({ runId: params.runId, gate, status: parsed.status, reason: parsed.reason });
  return {
    status: parsed.status,
    reason: parsed.reason,
    hasProductGap: hasProductGap(latestOutput),
    output: latestOutput,
    sessionId: finalSessionId,
  };
}
