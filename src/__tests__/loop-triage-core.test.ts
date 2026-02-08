import { describe, expect, test } from "bun:test";

import {
  computeLoopTriageSignature,
  decideLoopTripAction,
  parseLoopTriageMarker,
} from "../loop-triage/core";

describe("loop triage core", () => {
  test("parses strict final-line marker", () => {
    const output = [
      "analysis",
      'RALPH_LOOP_TRIAGE: {"version":1,"decision":"restart-new-agent","rationale":"Need fresh context","nudge":"Run bun test first."}',
    ].join("\n");

    const parsed = parseLoopTriageMarker(output);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.version).toBe(1);
      expect(parsed.payload.decision).toBe("restart-new-agent");
      expect(parsed.payload.rationale).toContain("fresh context");
    }
  });

  test("rejects missing marker", () => {
    const parsed = parseLoopTriageMarker("no marker");
    expect(parsed.ok).toBe(false);
  });

  test("rejects unsupported decision", () => {
    const parsed = parseLoopTriageMarker(
      'RALPH_LOOP_TRIAGE: {"version":1,"decision":"resume","rationale":"bad","nudge":"bad"}'
    );
    expect(parsed.ok).toBe(false);
  });

  test("signature is stable for same inputs", () => {
    const trip = {
      kind: "loop-trip" as const,
      triggeredAtTs: 123,
      reason: "Edit churn without gates exceeded thresholds",
      elapsedMsWithoutGate: 500_000,
      thresholds: {
        minEdits: 20,
        minElapsedMsWithoutGate: 480_000,
        minTopFileTouches: 8,
        minTopFileShare: 0.6,
      },
      metrics: {
        editsTotal: 25,
        editsSinceGate: 21,
        gateCommandCount: 0,
        lastGateTs: null,
        firstEditSinceGateTs: 1,
        topFiles: [{ path: "src/worker/repo-worker.ts", touches: 10 }],
      },
    };

    const a = computeLoopTriageSignature({ stage: "build", trip });
    const b = computeLoopTriageSignature({ stage: "build", trip });
    expect(a).toBe(b);
  });

  test("decision helper enforces deterministic ci override", () => {
    const parsed = parseLoopTriageMarker(
      'RALPH_LOOP_TRIAGE: {"version":1,"decision":"resume-existing","rationale":"ok","nudge":"ok"}'
    );
    const decision = decideLoopTripAction({
      deterministicCiDebug: true,
      parse: parsed,
      priorAttempts: 0,
      maxAttempts: 2,
      canResumeExisting: true,
    });
    expect(decision.action).toBe("restart-ci-debug");
    expect(decision.reasonCode).toBe("ci_debug_override");
  });

  test("decision helper falls back on parse failure", () => {
    const decision = decideLoopTripAction({
      deterministicCiDebug: false,
      parse: { ok: false, error: "invalid" },
      priorAttempts: 0,
      maxAttempts: 2,
      canResumeExisting: true,
    });
    expect(decision.action).toBe("restart-new-agent");
  });

  test("decision helper escalates after parse failure repeats", () => {
    const decision = decideLoopTripAction({
      deterministicCiDebug: false,
      parse: { ok: false, error: "invalid" },
      priorAttempts: 1,
      maxAttempts: 2,
      canResumeExisting: true,
    });
    expect(decision.action).toBe("escalate");
  });

  test("decision helper remaps resume when no session", () => {
    const parsed = parseLoopTriageMarker(
      'RALPH_LOOP_TRIAGE: {"version":1,"decision":"resume-existing","rationale":"resume","nudge":"resume"}'
    );
    const decision = decideLoopTripAction({
      deterministicCiDebug: false,
      parse: parsed,
      priorAttempts: 0,
      maxAttempts: 2,
      canResumeExisting: false,
    });
    expect(decision.action).toBe("restart-new-agent");
    expect(decision.reasonCode).toBe("resume_unavailable");
  });
});
