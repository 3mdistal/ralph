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
      issue: { ...baseIssue, labels: ["ralph:status:blocked"] },
      blocked: { blocked: false, confidence: "certain", reasons: [] },
      scope: "all-open",
    });

    expect(plan.add).toEqual(["ralph:status:queued"]);
    expect(plan.remove).toEqual(["ralph:status:blocked"]);
  });

  test("adds queued when blocked", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: [] },
      blocked: { blocked: true, confidence: "certain", reasons: ["blocked by #1"] },
      scope: "all-open",
    });

    expect(plan.add).toEqual(["ralph:status:queued"]);
    expect(plan.remove).toEqual([]);
    expect(plan.runnable).toBe(false);
  });

  test("skips when dependency coverage is unknown", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: ["ralph:status:queued"] },
      blocked: { blocked: false, confidence: "unknown", reasons: ["relationship coverage unknown"] },
      scope: "all-open",
    });

    expect(plan.skipped).toBe(true);
  });

  test("skips in-progress issues", () => {
    const plan = computeAutoQueueLabelPlan({
      issue: { ...baseIssue, labels: ["ralph:status:in-progress"] },
      blocked: { blocked: false, confidence: "certain", reasons: [] },
      scope: "all-open",
    });

    expect(plan.skipped).toBe(true);
  });
});
