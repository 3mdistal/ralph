import { describe, expect, test } from "bun:test";

import { __formatRequiredChecksGuidanceForTests, __summarizeRequiredChecksForTests } from "../worker";

describe("requiredChecks semantics", () => {
  test("requiredChecks=[] is treated as no gating (success)", () => {
    const summary = __summarizeRequiredChecksForTests(
      [{ name: "ci", state: "FAILURE", rawState: "FAILURE" }] as any,
      []
    );

    expect(summary.status).toBe("success");
    expect(summary.required).toEqual([]);
    expect(summary.available).toEqual(["ci"]);
  });

  test("requiredChecks with missing check is pending", () => {
    const summary = __summarizeRequiredChecksForTests([], ["ci"]);

    expect(summary.status).toBe("pending");
    expect(summary.required).toEqual([{ name: "ci", state: "UNKNOWN", rawState: "missing" }]);
    expect(summary.available).toEqual([]);
  });

  test("required checks guidance includes repo, branch, and hints", () => {
    const guidance = __formatRequiredChecksGuidanceForTests({
      repo: "acme/rocket",
      branch: "main",
      requiredChecks: ["ci"],
      missingChecks: ["ci"],
      availableChecks: [],
    });

    expect(guidance).toContain("Repo: acme/rocket");
    expect(guidance).toContain("Branch: main");
    expect(guidance).toContain("Required checks: ci");
    expect(guidance).toContain("Available check contexts: (none)");
    expect(guidance).toContain("update repos[].requiredChecks");
  });
});
