import { recordRalphRunGateArtifact, upsertRalphRunGateResult } from "../state";

type PlanReviewParseFailure =
  | "empty_output"
  | "missing_marker"
  | "multiple_markers"
  | "marker_not_final_line"
  | "missing_json"
  | "invalid_json"
  | "invalid_status"
  | "missing_reason";

export type PlanReviewParseResult =
  | { ok: true; status: "pass" | "fail"; reason: string; markerLine: string }
  | { ok: false; failure: PlanReviewParseFailure; reason: string };

const PLAN_REVIEW_MARKER_REGEX = /^\s*RALPH_PLAN_REVIEW:\s*/i;

function tryParsePlanReviewPayload(jsonText: string):
  | { ok: true; status: "pass" | "fail"; reason: string }
  | { ok: false; reason: string } {
  if (!jsonText.trim()) {
    return { ok: false, reason: "Plan review marker invalid: missing JSON payload" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: any) {
    return {
      ok: false,
      reason: `Plan review marker invalid: malformed JSON (${error?.message ?? String(error)})`,
    };
  }

  const status = parsed?.status;
  if (status !== "pass" && status !== "fail") {
    return { ok: false, reason: "Plan review marker invalid: status must be pass|fail" };
  }

  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";
  if (!reason) {
    return { ok: false, reason: "Plan review marker invalid: reason is required" };
  }

  return { ok: true, status, reason };
}

export function parseRalphPlanReviewMarker(output: string): PlanReviewParseResult {
  const text = String(output ?? "");
  const lines = text.split(/\r?\n/);
  let lastNonEmptyIndex = -1;
  const markerIndices: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim()) lastNonEmptyIndex = i;
    if (PLAN_REVIEW_MARKER_REGEX.test(line)) {
      markerIndices.push(i);
    }
  }

  if (lastNonEmptyIndex < 0) {
    return {
      ok: false,
      failure: "empty_output",
      reason: "Plan review marker invalid: output was empty",
    };
  }

  if (markerIndices.length === 0) {
    return {
      ok: false,
      failure: "missing_marker",
      reason: "Plan review marker invalid: missing RALPH_PLAN_REVIEW on final line",
    };
  }

  if (markerIndices.length > 1) {
    return {
      ok: false,
      failure: "multiple_markers",
      reason: "Plan review marker invalid: multiple RALPH_PLAN_REVIEW lines",
    };
  }

  if (markerIndices[0] !== lastNonEmptyIndex) {
    return {
      ok: false,
      failure: "marker_not_final_line",
      reason: "Plan review marker invalid: RALPH_PLAN_REVIEW not on final line",
    };
  }

  const markerLine = lines[lastNonEmptyIndex].trim();
  if (!PLAN_REVIEW_MARKER_REGEX.test(markerLine)) {
    return {
      ok: false,
      failure: "missing_marker",
      reason: "Plan review marker invalid: missing RALPH_PLAN_REVIEW on final line",
    };
  }

  const jsonText = markerLine.replace(PLAN_REVIEW_MARKER_REGEX, "").trim();
  const payload = tryParsePlanReviewPayload(jsonText);
  if (!payload.ok) {
    const reason = payload.reason;
    if (reason.includes("missing JSON payload")) {
      return { ok: false, failure: "missing_json", reason };
    }
    if (reason.includes("malformed JSON")) {
      return { ok: false, failure: "invalid_json", reason };
    }
    if (reason.includes("status must be")) {
      return { ok: false, failure: "invalid_status", reason };
    }
    return { ok: false, failure: "missing_reason", reason };
  }

  return { ok: true, status: payload.status, reason: payload.reason, markerLine };
}

function buildParseArtifact(parsed: PlanReviewParseResult): string {
  return JSON.stringify(
    {
      version: 1,
      ok: parsed.ok,
      failure: parsed.ok ? null : parsed.failure,
      reason: parsed.reason,
      markerLine: parsed.ok ? parsed.markerLine : null,
    },
    null,
    2
  );
}

export function recordPlanReviewGateResult(params: { runId: string; output: string; success: boolean }): PlanReviewParseResult {
  upsertRalphRunGateResult({ runId: params.runId, gate: "plan_review", status: "pending" });
  recordRalphRunGateArtifact({ runId: params.runId, gate: "plan_review", kind: "command_output", content: params.output });

  const parsed = parseRalphPlanReviewMarker(params.output);
  recordRalphRunGateArtifact({
    runId: params.runId,
    gate: "plan_review",
    kind: "failure_excerpt",
    content: buildParseArtifact(parsed),
  });

  if (!params.success) {
    const reason = parsed.ok ? `Plan stage did not complete successfully: ${parsed.reason}` : parsed.reason;
    upsertRalphRunGateResult({ runId: params.runId, gate: "plan_review", status: "fail", reason });
    return parsed;
  }

  if (!parsed.ok) {
    upsertRalphRunGateResult({ runId: params.runId, gate: "plan_review", status: "fail", reason: parsed.reason });
    return parsed;
  }

  upsertRalphRunGateResult({ runId: params.runId, gate: "plan_review", status: parsed.status, reason: parsed.reason });
  return parsed;
}
