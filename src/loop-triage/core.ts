import { createHash } from "crypto";

import type { LoopTripInfo } from "../loop-detection/core";
import { parseStrictFinalLineJsonMarker } from "../markers";

const LOOP_TRIAGE_MARKER_PREFIX = "RALPH_LOOP_TRIAGE";

export type LoopTriageAction = "resume-existing" | "restart-new-agent" | "restart-ci-debug" | "escalate";

export type LoopTriagePayloadV1 = {
  version: 1;
  decision: LoopTriageAction;
  rationale: string;
  nudge?: string;
};

export type LoopTriageDecision = {
  action: LoopTriageAction;
  rationale: string;
  nudge: string;
  source: "model" | "deterministic";
  reasonCode:
    | "ci_debug_override"
    | "budget_exhausted"
    | "model_parse_failed"
    | "resume_unavailable"
    | "model_decision";
  parseError?: string;
};

export type LoopTriageParseResult =
  | { ok: true; payload: LoopTriagePayloadV1; markerLine: string }
  | { ok: false; error: string };

const VALID_ACTIONS = new Set<LoopTriageAction>([
  "resume-existing",
  "restart-new-agent",
  "restart-ci-debug",
  "escalate",
]);

function normalizeText(value: unknown, fallback: string, maxChars: number): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return fallback;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function parseLoopTriageMarker(output: string): LoopTriageParseResult {
  const parsed = parseStrictFinalLineJsonMarker<unknown>(output, LOOP_TRIAGE_MARKER_PREFIX);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const payload = parsed.value as Partial<LoopTriagePayloadV1> | null | undefined;
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Loop triage marker payload must be an object" };
  }

  if (payload.version !== 1) {
    return { ok: false, error: "Loop triage marker payload must include version=1" };
  }

  if (!VALID_ACTIONS.has(payload.decision as LoopTriageAction)) {
    return { ok: false, error: "Loop triage marker payload has unsupported decision" };
  }

  const rationale = normalizeText(payload.rationale, "No rationale provided.", 200);
  const nudge = normalizeText(payload.nudge, "Resume with a narrow next step and run a deterministic gate now.", 500);

  return {
    ok: true,
    markerLine: parsed.markerLine,
    payload: {
      version: 1,
      decision: payload.decision as LoopTriageAction,
      rationale,
      nudge,
    },
  };
}

export function computeLoopTriageSignature(params: { stage: string; trip: LoopTripInfo | undefined }): string {
  const trip = params.trip;
  const material = {
    stage: params.stage,
    reason: trip?.reason ?? "",
    thresholds: trip?.thresholds ?? null,
    editsSinceGate: trip?.metrics.editsSinceGate ?? 0,
    gateCommandCount: trip?.metrics.gateCommandCount ?? 0,
    elapsedMsWithoutGate: trip?.elapsedMsWithoutGate ?? 0,
    topFiles: (trip?.metrics.topFiles ?? []).map((f) => ({ path: f.path, touches: f.touches })),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

export function decideLoopTripAction(params: {
  deterministicCiDebug: boolean;
  parse: LoopTriageParseResult;
  priorAttempts: number;
  maxAttempts: number;
  canResumeExisting: boolean;
}): LoopTriageDecision {
  if (params.deterministicCiDebug) {
    return {
      action: "restart-ci-debug",
      rationale: "Open PR already has failing required checks; route to deterministic CI-debug lane.",
      nudge: "Use CI-debug lane with failing check URLs and run deterministic remediation.",
      source: "deterministic",
      reasonCode: "ci_debug_override",
    };
  }

  if (params.priorAttempts >= params.maxAttempts) {
    return {
      action: "escalate",
      rationale: `Loop-triage budget exhausted (${params.priorAttempts}/${params.maxAttempts}).`,
      nudge: "Escalate with bounded diagnostics and attempted actions.",
      source: "deterministic",
      reasonCode: "budget_exhausted",
    };
  }

  if (!params.parse.ok) {
    const fallbackAction: LoopTriageAction = params.priorAttempts === 0 ? "restart-new-agent" : "escalate";
    return {
      action: fallbackAction,
      rationale: `Loop-triage model output invalid: ${params.parse.error}`,
      nudge: "Restart with a narrow objective and run a deterministic gate immediately.",
      source: "deterministic",
      reasonCode: "model_parse_failed",
      parseError: params.parse.error,
    };
  }

  if (params.parse.payload.decision === "resume-existing" && !params.canResumeExisting) {
    return {
      action: "restart-new-agent",
      rationale: "Resume-existing requested, but no resumable session is available after loop trip.",
      nudge: params.parse.payload.nudge ?? "Restart with a narrow objective and run a deterministic gate immediately.",
      source: "deterministic",
      reasonCode: "resume_unavailable",
    };
  }

  return {
    action: params.parse.payload.decision,
    rationale: params.parse.payload.rationale,
    nudge: params.parse.payload.nudge ?? "Run a deterministic gate now.",
    source: "model",
    reasonCode: "model_decision",
  };
}
