import { describe, test, expect } from "bun:test";
import { buildAlertSummary, buildAlertFingerprint, planAlertRecord } from "../alerts/core";

describe("alerts core", () => {
  test("buildAlertSummary produces bounded summary", () => {
    const summary = buildAlertSummary("Build failed", "Error: something went wrong\nstack line");
    expect(summary).toContain("Build failed");
    expect(summary).toContain("Error:");
  });

  test("buildAlertFingerprint is deterministic", () => {
    const a = buildAlertFingerprint("context", "error");
    const b = buildAlertFingerprint("context", "error");
    const c = buildAlertFingerprint("context", "different");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("planAlertRecord yields summary and fingerprint", () => {
    const planned = planAlertRecord({
      kind: "error",
      targetType: "issue",
      targetNumber: 1,
      context: "Task failed",
      error: "boom",
    });
    expect(planned.summary).toContain("Task failed");
    expect(planned.fingerprint.length).toBeGreaterThan(0);
  });
});
