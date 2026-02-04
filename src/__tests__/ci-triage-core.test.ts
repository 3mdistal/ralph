import { describe, expect, test } from "bun:test";
import { buildCiTriageDecision } from "../ci-triage/core";
import { buildCiFailureSignatureV2 } from "../ci-triage/signature";

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
});
