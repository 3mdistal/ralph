import { describe, expect, test } from "bun:test";

import { deriveRalphStatus, planClaim, shouldRecoverStaleInProgress, statusToRalphLabelDelta } from "../github-queue/core";

describe("github queue core", () => {
  test("statusToRalphLabelDelta only mutates ralph labels", () => {
    const delta = statusToRalphLabelDelta("in-progress", ["bug", "ralph:queued", "dx"]);
    expect(delta).toEqual({ add: ["ralph:in-progress"], remove: ["ralph:queued"] });
  });

  test("planClaim requires queued label", () => {
    const plan = planClaim(["ralph:queued"]);
    expect(plan.claimable).toBe(true);
    expect(plan.steps).toEqual([
      { action: "add", label: "ralph:in-progress" },
      { action: "remove", label: "ralph:queued" },
    ]);
  });

  test("planClaim rejects in-progress issues", () => {
    const plan = planClaim(["ralph:in-progress"]);
    expect(plan.claimable).toBe(false);
  });

  test("planClaim rejects blocked issues", () => {
    const plan = planClaim(["ralph:queued", "ralph:blocked"]);
    expect(plan.claimable).toBe(false);
  });

  test("deriveRalphStatus honors blocked precedence", () => {
    const status = deriveRalphStatus(["ralph:queued", "ralph:blocked"], "OPEN");
    expect(status).toBe("blocked");
  });

  test("shouldRecoverStaleInProgress requires stale heartbeat", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recover = shouldRecoverStaleInProgress({
      labels: ["ralph:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "",
      },
      nowMs,
      ttlMs,
    });

    expect(recover).toBe(true);
  });
});
