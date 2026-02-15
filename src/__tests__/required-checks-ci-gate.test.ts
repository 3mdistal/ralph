import { describe, expect, test } from "bun:test";

import { __evaluateCiGateForTests, __formatCiGateReasonForTests } from "../worker";

describe("required checks CI gate evaluation", () => {
  test("marks timeout as fail when required checks remain pending", () => {
    const evaluation = __evaluateCiGateForTests({
      allChecks: [{ name: "ci", state: "PENDING", rawState: "IN_PROGRESS", detailsUrl: null }] as any,
      requiredChecks: ["ci"],
      timedOut: true,
    });

    expect(evaluation.status).toBe("fail");
    expect(evaluation.timedOut).toBe(true);
    expect(evaluation.required).toEqual([{ name: "ci", state: "PENDING", rawState: "IN_PROGRESS", detailsUrl: null }]);
  });

  test("formats deterministic, bounded CI gate reason", () => {
    const evaluation = __evaluateCiGateForTests({
      allChecks: [
        { name: "z-check", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null },
        { name: "a-check", state: "FAILURE", rawState: "FAILURE", detailsUrl: null },
        { name: "extra", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null },
      ] as any,
      requiredChecks: ["a-check", "z-check"],
      timedOut: false,
    });

    const reason = __formatCiGateReasonForTests(evaluation, 400);
    const short = __formatCiGateReasonForTests(evaluation, 60);

    expect(reason).toContain("required=a-check:FAILURE,z-check:SUCCESS");
    expect(reason).toContain("status=fail");
    expect(reason).toContain("timed_out=no");
    expect(reason.length).toBeLessThanOrEqual(400);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short.endsWith("...")).toBe(true);
  });
});
