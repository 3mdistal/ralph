import { describe, expect, test } from "bun:test";

import { derivePrCreateEscalationReason } from "../worker/pr-create-escalation-reason";

describe("derivePrCreateEscalationReason", () => {
  test("prefers hard-failure classification over no-PR fallback", () => {
    const derived = derivePrCreateEscalationReason({
      continueAttempts: 5,
      evidence: [
        "Implementation finished.",
        "Invalid schema for function 'ahrefs_batch-analysis-batch-analysis': array schema missing items.",
        "code: invalid_function_parameters",
      ],
    });

    expect(derived.classification?.blockedSource).toBe("opencode-config-invalid");
    expect(derived.reason).toContain("OpenCode config invalid");
    expect(derived.reason).not.toContain("did not create a PR");
    expect(derived.details).toContain("No PR URL observed after 5 continue attempts");
    expect(derived.details).toContain("PR_EVIDENCE_CAUSE_CODE=UNKNOWN");
    expect(derived.causeCode).toBe("UNKNOWN");
  });

  test("uses no-PR fallback when no classifier signal exists", () => {
    const derived = derivePrCreateEscalationReason({
      continueAttempts: 3,
      evidence: ["Implementation complete but PR URL missing."],
    });

    expect(derived.classification).toBeNull();
    expect(derived.reason).toBe("Agent completed but did not create a PR after 3 continue attempts");
    expect(derived.details).toBe("PR_EVIDENCE_CAUSE_CODE=UNKNOWN");
    expect(derived.causeCode).toBe("UNKNOWN");
  });

  test("classifies from later continue output in accumulated evidence", () => {
    const derived = derivePrCreateEscalationReason({
      continueAttempts: 2,
      evidence: [
        "First continue output did not include a root cause.",
        "Invalid schema for function 'tool-x': missing items.",
        "code: invalid_function_parameters",
      ],
    });

    expect(derived.classification?.blockedSource).toBe("opencode-config-invalid");
    expect(derived.reason).toContain("tool schema rejected");
    expect(derived.causeCode).toBe("UNKNOWN");
  });

  test("maps permission-denied evidence to POLICY_DENIED cause code", () => {
    const derived = derivePrCreateEscalationReason({
      continueAttempts: 1,
      evidence: ["permission requested: file.write (/tmp/x); auto-rejecting"],
    });

    expect(derived.causeCode).toBe("POLICY_DENIED");
    expect(derived.details).toContain("PR_EVIDENCE_CAUSE_CODE=POLICY_DENIED");
  });
});
