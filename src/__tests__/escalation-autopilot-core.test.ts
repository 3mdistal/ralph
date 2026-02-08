import { describe, expect, test } from "bun:test";
import {
  applyAutopilotResolutionPatch,
  computeEscalationSignature,
  computeLoopBudget,
  evaluateAutopilotEligibility,
  parseConsultantDecisionFromEscalationNote,
} from "../escalation-autopilot/core";
import type { ConsultantDecision } from "../escalation-consultant/core";

function buildDecision(overrides: Partial<ConsultantDecision> = {}): ConsultantDecision {
  return {
    schema_version: 2,
    decision: "auto-resolve",
    confidence: "high",
    requires_approval: true,
    current_state: "x",
    whats_missing: "y",
    options: ["a", "b"],
    recommendation: "a",
    questions: ["q"],
    proposed_resolution_text: "Apply deterministic remediation and continue.",
    reason: "Routine remediation",
    followups: [],
    ...overrides,
  };
}

describe("escalation autopilot core", () => {
  test("parses consultant decision JSON from note", () => {
    const note = [
      "## Consultant Decision (machine)",
      "```json",
      JSON.stringify(buildDecision()),
      "```",
    ].join("\n");
    const parsed = parseConsultantDecisionFromEscalationNote(note);
    expect(parsed?.decision).toBe("auto-resolve");
    expect(parsed?.confidence).toBe("high");
  });

  test("eligibility allows watchdog auto-resolve at high confidence", () => {
    const eligible = evaluateAutopilotEligibility({
      escalationType: "watchdog",
      reason: "Tool call timed out during build",
      noteContent: "",
      decision: buildDecision(),
    });
    expect(eligible.eligible).toBe(true);
  });

  test("eligibility blocks product-gap and contract-surface", () => {
    const gap = evaluateAutopilotEligibility({
      escalationType: "product-gap",
      reason: "Missing product guidance",
      noteContent: "PRODUCT GAP: behavior unspecified",
      decision: buildDecision(),
    });
    expect(gap).toEqual({ eligible: false, reason: "product-gap" });

    const contract = evaluateAutopilotEligibility({
      escalationType: "watchdog",
      reason: "Need decision on CLI output format",
      noteContent: "",
      decision: buildDecision(),
    });
    expect(contract).toEqual({ eligible: false, reason: "contract-surface" });
  });

  test("blocked eligibility requires dependency reference", () => {
    const blockedNoRef = evaluateAutopilotEligibility({
      escalationType: "blocked",
      reason: "blocked by unknown external system",
      noteContent: "",
      decision: buildDecision(),
    });
    expect(blockedNoRef).toEqual({ eligible: false, reason: "blocked-not-dependency-ref" });

    const blockedRef = evaluateAutopilotEligibility({
      escalationType: "blocked",
      reason: "blocked by 3mdistal/ralph#209",
      noteContent: "",
      decision: buildDecision(),
    });
    expect(blockedRef.eligible).toBe(true);
  });

  test("loop budget enforces max attempts per signature", () => {
    const sig = computeEscalationSignature({
      escalationType: "watchdog",
      reason: "Tool timeout",
      decision: buildDecision(),
    });
    const one = computeLoopBudget({ ledgerRaw: undefined, signature: sig, nowIso: "2026-02-07T00:00:00.000Z", maxAttempts: 2 });
    expect(one.allowed).toBe(true);
    const two = computeLoopBudget({ ledgerRaw: one.ledgerJson, signature: sig, nowIso: "2026-02-07T00:01:00.000Z", maxAttempts: 2 });
    expect(two.allowed).toBe(true);
    const three = computeLoopBudget({ ledgerRaw: two.ledgerJson, signature: sig, nowIso: "2026-02-07T00:02:00.000Z", maxAttempts: 2 });
    expect(three.allowed).toBe(false);
    expect(three.reason).toBe("max-attempts");
  });

  test("resolution patch is idempotent once filled", () => {
    const start = ["## Resolution", "", "<!-- Add human guidance here. -->", "", "## Next Steps"].join("\n");
    const first = applyAutopilotResolutionPatch(start, "Use the suggested auto remediation.");
    expect(first.changed).toBe(true);
    const second = applyAutopilotResolutionPatch(first.noteContent, "Different text");
    expect(second.changed).toBe(false);
    expect(second.reason).toBe("already-filled");
  });
});
