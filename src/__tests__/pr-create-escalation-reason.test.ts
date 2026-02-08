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
  });

  test("uses no-PR fallback when no classifier signal exists", () => {
    const derived = derivePrCreateEscalationReason({
      continueAttempts: 3,
      evidence: ["Implementation complete but PR URL missing."],
    });

    expect(derived.classification).toBeNull();
    expect(derived.reason).toBe("Agent completed but did not create a PR after 3 continue attempts");
    expect(derived.details).toBeUndefined();
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
  });
});
