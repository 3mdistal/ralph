import { describe, expect, test } from "bun:test";

import { __computeRequiredChecksDelayForTests } from "../worker";

describe("required checks polling backoff", () => {
  test("backs off when required checks are pending and unchanged", () => {
    const first = __computeRequiredChecksDelayForTests({
      baseIntervalMs: 30_000,
      maxIntervalMs: 120_000,
      attempt: 0,
      lastSignature: "same",
      nextSignature: "same",
      pending: true,
    });

    expect(first.reason).toBe("backoff");
    expect(first.delayMs).toBe(45_000);
    expect(first.nextAttempt).toBe(1);

    const second = __computeRequiredChecksDelayForTests({
      baseIntervalMs: 30_000,
      maxIntervalMs: 120_000,
      attempt: first.nextAttempt,
      lastSignature: "same",
      nextSignature: "same",
      pending: true,
    });

    expect(second.delayMs).toBe(67_500);
    expect(second.nextAttempt).toBe(2);
  });

  test("resets delay when check state changes", () => {
    const decision = __computeRequiredChecksDelayForTests({
      baseIntervalMs: 30_000,
      maxIntervalMs: 120_000,
      attempt: 2,
      lastSignature: "before",
      nextSignature: "after",
      pending: true,
    });

    expect(decision.reason).toBe("progress");
    expect(decision.delayMs).toBe(30_000);
    expect(decision.nextAttempt).toBe(0);
  });
});
