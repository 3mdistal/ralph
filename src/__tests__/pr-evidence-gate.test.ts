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
      causeCode: "UNKNOWN",
    });
  });

  test("allows success with explicit no-PR terminal reason", () => {
    const decision = evaluatePrEvidenceCompletion({
      attemptedOutcome: "success",
      completionKind: "verified",
      issueLinked: true,
      prUrl: null,
      noPrTerminalReason: "PARENT_VERIFICATION_NO_PR",
    });

    expect(decision.finalOutcome).toBe("success");
    expect(decision.missingPrEvidence).toBe(false);
    expect(decision.causeCode).toBeNull();
  });

  test("does not allow implicit verified completion without terminal reason", () => {
    const decision = evaluatePrEvidenceCompletion({
      attemptedOutcome: "success",
      completionKind: "verified",
      issueLinked: true,
      prUrl: null,
    });

    expect(decision.finalOutcome).toBe("escalated");
    expect(decision.reasonCode).toBe("missing_pr_url");
    expect(decision.causeCode).toBe("UNKNOWN");
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
    expect(decision.causeCode).toBeNull();
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
    expect(decision.causeCode).toBeNull();
  });
});
