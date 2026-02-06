import { describe, expect, test } from "bun:test";

import { evaluatePrEvidenceCompletion } from "../gates/pr-evidence-gate";

describe("evaluatePrEvidenceCompletion", () => {
  test("fails closed for issue-linked success with no PR evidence", () => {
    const decision = evaluatePrEvidenceCompletion({
      attemptedOutcome: "success",
      completionKind: "pr",
      issueLinked: true,
      prUrl: null,
    });

    expect(decision).toEqual({
      finalOutcome: "escalated",
      reasonCode: "missing_pr_url",
      missingPrEvidence: true,
    });
  });

  test("allows verified success without PR evidence", () => {
    const decision = evaluatePrEvidenceCompletion({
      attemptedOutcome: "success",
      completionKind: "verified",
      issueLinked: true,
      prUrl: null,
    });

    expect(decision.finalOutcome).toBe("success");
    expect(decision.missingPrEvidence).toBe(false);
  });

  test("allows success when PR URL exists", () => {
    const decision = evaluatePrEvidenceCompletion({
      attemptedOutcome: "success",
      completionKind: "pr",
      issueLinked: true,
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
    });

    expect(decision.finalOutcome).toBe("success");
    expect(decision.missingPrEvidence).toBe(false);
  });

  test("does not alter non-success outcomes", () => {
    const decision = evaluatePrEvidenceCompletion({
      attemptedOutcome: "failed",
      completionKind: "pr",
      issueLinked: true,
      prUrl: null,
    });

    expect(decision.finalOutcome).toBe("failed");
    expect(decision.missingPrEvidence).toBe(false);
  });
});
