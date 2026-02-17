import { describe, expect, test } from "bun:test";

import { evaluatePreflightPolicy } from "../gates/preflight-policy";

describe("evaluatePreflightPolicy", () => {
  test("blocks invalid preflight config", () => {
    const decision = evaluatePreflightPolicy({
      commands: [],
      source: "preflightCommand",
      configured: true,
      invalid: true,
    });

    expect(decision.action).toBe("block");
    if (decision.action === "block") {
      expect(decision.causeCode).toBe("POLICY_DENIED");
      expect(decision.diagnostics.join("\n")).toContain("Preflight config is invalid");
    }
  });

  test("blocks when preflight is not configured", () => {
    const decision = evaluatePreflightPolicy({
      commands: [],
      source: "none",
      configured: false,
      invalid: false,
    });

    expect(decision.action).toBe("block");
    if (decision.action === "block") {
      expect(decision.diagnostics.join("\n")).toContain("Preflight is not configured");
    }
  });

  test("blocks empty legacy verification.preflight", () => {
    const decision = evaluatePreflightPolicy({
      commands: [],
      source: "verification.preflight",
      configured: true,
      invalid: false,
    });

    expect(decision.action).toBe("block");
    if (decision.action === "block") {
      expect(decision.diagnostics.join("\n")).toContain("verification.preflight is empty");
    }
  });

  test("allows explicit disable via preflightCommand=[]", () => {
    const decision = evaluatePreflightPolicy({
      commands: [],
      source: "preflightCommand",
      configured: true,
      invalid: false,
    });

    expect(decision.action).toBe("run");
    if (decision.action === "run") {
      expect(decision.commands).toEqual([]);
      expect(decision.skipReason).toBe("preflight disabled (preflightCommand=[])");
    }
  });

  test("allows configured commands", () => {
    const decision = evaluatePreflightPolicy({
      commands: ["bun test", "bun run typecheck"],
      source: "preflightCommand",
      configured: true,
      invalid: false,
    });

    expect(decision.action).toBe("run");
    if (decision.action === "run") {
      expect(decision.commands).toEqual(["bun test", "bun run typecheck"]);
      expect(decision.skipReason).toBe("preflight configured but empty");
    }
  });
});
