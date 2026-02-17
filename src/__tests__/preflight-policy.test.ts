import { describe, expect, test } from "bun:test";

import { decidePreflightForPrCreate } from "../gates/preflight-policy";

describe("decidePreflightForPrCreate", () => {
  test("returns run decision for configured commands", () => {
    const decision = decidePreflightForPrCreate({
      repoName: "demo/repo",
      resolution: {
        kind: "run",
        commands: ["bun test", "bun run typecheck"],
        source: "preflightCommand",
        configured: true,
      },
    });

    expect(decision).toEqual({
      action: "run",
      commands: ["bun test", "bun run typecheck"],
      source: "preflightCommand",
    });
  });

  test("returns skip decision only for explicit disable", () => {
    const decision = decidePreflightForPrCreate({
      repoName: "demo/repo",
      resolution: {
        kind: "disabled",
        commands: [],
        source: "preflightCommand",
        configured: true,
      },
    });

    expect(decision).toEqual({
      action: "skip",
      commands: [],
      source: "preflightCommand",
      skipReason: "preflight disabled (preflightCommand=[])",
    });
  });

  test("returns fail decision for missing config", () => {
    const decision = decidePreflightForPrCreate({
      repoName: "demo/repo",
      resolution: {
        kind: "missing",
        commands: [],
        source: "none",
        configured: false,
        reason: "no repo preflight command configured",
      },
    });

    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") throw new Error("expected fail");
    expect(decision.reason).toContain("required before PR creation");
    expect(decision.remediation).toContain("repos[].preflightCommand");
  });

  test("returns fail decision for misconfigured config", () => {
    const decision = decidePreflightForPrCreate({
      repoName: "demo/repo",
      resolution: {
        kind: "misconfigured",
        commands: [],
        source: "verification.preflight",
        configured: true,
        reason: "invalid repos[].verification.preflight",
      },
    });

    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") throw new Error("expected fail");
    expect(decision.reason).toContain("misconfigured");
    expect(decision.source).toBe("verification.preflight");
  });
});
