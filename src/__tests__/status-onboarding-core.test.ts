import { describe, expect, test } from "bun:test";

import { evaluateRepoOnboarding } from "../status-onboarding/core";

describe("status onboarding core", () => {
  test("fails overall when a critical check fails", () => {
    const result = evaluateRepoOnboarding({
      repo: "acme/rocket",
      checks: [
        {
          checkId: "repo.access",
          status: "fail",
          reason: "403",
          remediation: ["Grant access"],
        },
        {
          checkId: "github.degraded_mode",
          status: "pass",
          reason: "ok",
          remediation: [],
        },
      ],
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0]?.checkId).toBe("repo.access");
  });

  test("warns overall when checks are unavailable but no critical failures", () => {
    const result = evaluateRepoOnboarding({
      repo: "acme/rocket",
      checks: [
        {
          checkId: "repo.access",
          status: "pass",
          reason: "ok",
          remediation: [],
        },
        {
          checkId: "ci.required_checks_policy",
          status: "unavailable",
          reason: "deferred",
          remediation: ["retry"],
        },
      ],
    });

    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.status === "unavailable")).toBe(true);
  });

  test("fills missing checks as unavailable in stable order", () => {
    const result = evaluateRepoOnboarding({
      repo: "acme/rocket",
      checks: [],
    });

    expect(result.checks.map((check) => check.checkId)).toEqual([
      "repo.access",
      "labels.required_set",
      "local.checkout_path",
      "worktree.root_writable",
      "ci.required_checks_policy",
      "opencode.setup",
      "github.degraded_mode",
    ]);
    expect(result.checks.every((check) => check.status === "unavailable")).toBe(true);
  });
});
