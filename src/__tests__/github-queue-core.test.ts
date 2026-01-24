import { describe, expect, test } from "bun:test";

import {
  deriveRalphStatus,
  deriveTaskView,
  planClaim,
  shouldRecoverStaleInProgress,
  statusToRalphLabelDelta,
} from "../github-queue/core";

function applyDelta(labels: string[], delta: { add: string[]; remove: string[] }): string[] {
  const set = new Set(labels);
  for (const label of delta.remove) {
    set.delete(label);
  }
  for (const label of delta.add) {
    set.add(label);
  }
  return Array.from(set);
}

describe("github queue core", () => {
  test("deriveTaskView infers priority from labels", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 285,
        title: "Priority labels",
        labels: ["p0-critical", "ralph:queued"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p0-critical");
  });

  test("deriveTaskView prefers highest priority label", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 286,
        title: "Priority labels",
        labels: ["p3-low", "p1-high"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p1-high");
  });

  test("deriveTaskView defaults to p2-medium when no priority labels", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 287,
        title: "Priority labels",
        labels: ["bug", "ralph:queued"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p2-medium");
  });

  test("deriveTaskView matches case-insensitive priority prefixes", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 288,
        title: "Priority labels",
        labels: ["P2", "p4 backlog"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p2-medium");
  });

  test("deriveTaskView accepts priority prefixes with suffixes", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 289,
        title: "Priority labels",
        labels: ["p3:low"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p3-low");
  });

  test("statusToRalphLabelDelta only mutates ralph labels", () => {
    const delta = statusToRalphLabelDelta("in-progress", ["bug", "ralph:queued", "dx"]);
    expect(delta).toEqual({ add: ["ralph:in-progress"], remove: ["ralph:queued"] });
  });

  test("statusToRalphLabelDelta preserves queued when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:queued"]);
    expect(delta).toEqual({ add: ["ralph:blocked"], remove: [] });
  });

  test("statusToRalphLabelDelta removes other status labels when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:queued", "ralph:in-progress"]);
    expect(delta).toEqual({ add: ["ralph:blocked"], remove: ["ralph:in-progress"] });
  });

  test("statusToRalphLabelDelta still removes queued when escalated", () => {
    const delta = statusToRalphLabelDelta("escalated", ["ralph:queued"]);
    expect(delta).toEqual({ add: ["ralph:escalated"], remove: ["ralph:queued"] });
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

  test("unblocked issues remain queued and claimable", () => {
    const blockedLabels = ["ralph:queued", "ralph:blocked"];
    const delta = statusToRalphLabelDelta("queued", blockedLabels);
    const updated = applyDelta(blockedLabels, delta);
    expect(updated).toEqual(["ralph:queued"]);
    expect(planClaim(updated).claimable).toBe(true);
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
