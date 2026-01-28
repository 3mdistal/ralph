import { describe, expect, test } from "bun:test";

import { computeAutoQueueLabelPlan } from "../github/auto-queue";

const baseIssue = {
  repo: "3mdistal/ralph",
  number: 100,
  title: "Issue 100",
  labels: [],
  state: "OPEN",
};

describe("auto-queue planning", () => {
  test("skips closed issues", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, state: "CLOSED" },
      blocked: { blocked: false, confidence: "certain", reasons: [] },
      scope: "all-open",
    });

    expect(plan.skipped).toBe(true);
  });

  test("skips unlabeled issues when scope is labeled-only", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: [] },
      blocked: { blocked: false, confidence: "certain", reasons: [] },
      scope: "labeled-only",
    });

    expect(plan.skipped).toBe(true);
  });

  test("adds queued and removes blocked when unblocked", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: ["ralph:blocked"] },
      blocked: { blocked: false, confidence: "certain", reasons: [] },
      scope: "all-open",
    });

    expect(plan.add).toEqual(["ralph:queued"]);
    expect(plan.remove).toEqual(["ralph:blocked"]);
  });

  test("adds blocked when blocked", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: [] },
      blocked: { blocked: true, confidence: "certain", reasons: ["blocked by #1"] },
      scope: "all-open",
    });

    expect(plan.add).toEqual(["ralph:blocked"]);
    expect(plan.remove).toEqual([]);
  });

  test("skips when dependency coverage is unknown", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: ["ralph:queued"] },
      blocked: { blocked: false, confidence: "unknown", reasons: ["relationship coverage unknown"] },
      scope: "all-open",
    });

    expect(plan.skipped).toBe(true);
  });

  test("skips escalated issues", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: ["ralph:escalated"] },
      blocked: { blocked: false, confidence: "certain", reasons: [] },
      scope: "all-open",
    });

    expect(plan.skipped).toBe(true);
  });
});
