import { describe, expect, test } from "bun:test";
import { buildCiTriageDecision, buildCiTriageExecutionPlan } from "../ci-triage/core";
import { buildCiFailureSignatureV2, buildCiFailureSignatureV3 } from "../ci-triage/signature";

describe("ci triage core", () => {
  test("classifies infra on timeout", () => {
    const decision = buildCiTriageDecision({
      timedOut: true,
      failures: [{ name: "CI", rawState: "TIMED_OUT", excerpt: null }],
      commands: [],
      attempt: 1,
      maxAttempts: 5,
      hasSession: false,
      signature: "sig",
      priorSignature: null,
    });

    expect(decision.classification).toBe("infra");
    expect(decision.classificationReason).toBe("infra_timeout");
  });

  test("classifies flake when logs mention flaky", () => {
    const decision = buildCiTriageDecision({
      timedOut: false,
      failures: [{ name: "Test", rawState: "FAILURE", excerpt: "flaky test" }],
      commands: [],
      attempt: 1,
      maxAttempts: 5,
      hasSession: false,
      signature: "sig",
      priorSignature: null,
    });

    expect(decision.classification).toBe("flake-suspected");
    expect(decision.classificationReason).toBe("flake_transient");
  });

  test("chooses resume for regression with session", () => {
    const decision = buildCiTriageDecision({
      timedOut: false,
      failures: [{ name: "test", rawState: "FAILURE", excerpt: "" }],
      commands: ["bun test"],
      attempt: 1,
      maxAttempts: 5,
      hasSession: true,
      signature: "sig",
      priorSignature: null,
    });

    expect(decision.action).toBe("resume");
    expect(decision.actionReason).toBe("resume_has_session");
  });

  test("quarantines repeated non-regression signature", () => {
    const decision = buildCiTriageDecision({
      timedOut: false,
      failures: [{ name: "CI", rawState: "FAILURE", excerpt: "network error: ETIMEDOUT" }],
      commands: [],
      attempt: 2,
      maxAttempts: 5,
      hasSession: true,
      signature: "same",
      priorSignature: "same",
    });

    expect(decision.classification).toBe("infra");
    expect(decision.action).toBe("quarantine");
    expect(decision.actionReason).toBe("quarantine_repeated_signature");
  });

  test("does not quarantine repeated regression signature", () => {
    const decision = buildCiTriageDecision({
      timedOut: false,
      failures: [{ name: "test", rawState: "FAILURE", excerpt: "assertion failed" }],
      commands: ["bun test"],
      attempt: 2,
      maxAttempts: 5,
      hasSession: true,
      signature: "same",
      priorSignature: "same",
    });

    expect(decision.classification).toBe("regression");
    expect(decision.action).toBe("spawn");
    expect(decision.actionReason).toBe("spawn_regression");
  });

  test("execution plan encodes attempt boundaries deterministically", () => {
    const plan = buildCiTriageExecutionPlan({
      timedOut: false,
      failures: [{ name: "test", rawState: "FAILURE", excerpt: "assertion failed" }],
      commands: ["bun test"],
      attempt: 6,
      maxAttempts: 5,
      hasSession: false,
      signature: "sig",
      priorSignature: "prior",
      signatureVersion: 3,
    });

    expect(plan.attemptAllowed).toBe(false);
    expect(plan.exhaustedBudget).toBe(true);
    expect(plan.record.version).toBe(2);
    expect(plan.record.signatureVersion).toBe(3);
  });
});

describe("ci failure signature", () => {
  test("signature is stable across ordering", () => {
    const a = buildCiFailureSignatureV2({
      timedOut: false,
      failures: [
        { name: "Build", rawState: "FAILURE", excerpt: "Error: failed" },
        { name: "Test", rawState: "FAILURE", excerpt: "Assertion failed" },
      ],
    });

    const b = buildCiFailureSignatureV2({
      timedOut: false,
      failures: [
        { name: "Test", rawState: "FAILURE", excerpt: "Assertion failed" },
        { name: "Build", rawState: "FAILURE", excerpt: "Error: failed" },
      ],
    });

    expect(a.signature).toBe(b.signature);
  });

  test("v3 signature is stable across ordering", () => {
    const a = buildCiFailureSignatureV3({
      timedOut: false,
      failures: [
        { name: "Build", rawState: "FAILURE", excerpt: "Error: failed" },
        { name: "Test", rawState: "FAILURE", excerpt: "Assertion failed" },
      ],
    });

    const b = buildCiFailureSignatureV3({
      timedOut: false,
      failures: [
        { name: "Test", rawState: "FAILURE", excerpt: "Assertion failed" },
        { name: "Build", rawState: "FAILURE", excerpt: "Error: failed" },
      ],
    });

    expect(a.signature).toBe(b.signature);
  });

  test("v3 signature redacts and clips excerpts deterministically", () => {
    const longSecret = `${"x".repeat(2200)} token=sk-secret`;
    const a = buildCiFailureSignatureV3({
      timedOut: false,
      failures: [{ name: "Test", rawState: "FAILURE", excerpt: longSecret }],
    });
    const b = buildCiFailureSignatureV3({
      timedOut: false,
      failures: [{ name: "Test", rawState: "FAILURE", excerpt: `${"x".repeat(2200)} token=sk-other` }],
    });
    expect(a.signature).toBe(b.signature);
  });
});
