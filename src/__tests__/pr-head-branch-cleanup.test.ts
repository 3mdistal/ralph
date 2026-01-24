import { describe, expect, test } from "bun:test";
import { computeHeadBranchDeletionDecision } from "../pr-head-branch-cleanup";

const baseInput = {
  merged: true,
  isCrossRepository: false,
  headRepoFullName: "3mdistal/ralph",
  headRefName: "ralph/task-123",
  baseRefName: "bot/integration",
  botBranch: "bot/integration",
  defaultBranch: "main",
  mergedHeadSha: "deadbeef",
  currentHeadSha: "deadbeef",
};

describe("computeHeadBranchDeletionDecision", () => {
  test("allows deletion when eligible", () => {
    expect(computeHeadBranchDeletionDecision(baseInput)).toEqual({
      action: "delete",
      branch: "ralph/task-123",
      reason: "eligible",
    });
  });

  test("skips when PR is not merged", () => {
    expect(
      computeHeadBranchDeletionDecision({
        ...baseInput,
        merged: false,
      })
    ).toEqual({ action: "skip", reason: "pr not merged" });
  });

  test("skips cross-repo PRs", () => {
    expect(
      computeHeadBranchDeletionDecision({
        ...baseInput,
        isCrossRepository: true,
      })
    ).toEqual({ action: "skip", reason: "pr is cross-repo" });
  });

  test("skips when base branch is not the bot branch", () => {
    expect(
      computeHeadBranchDeletionDecision({
        ...baseInput,
        baseRefName: "main",
      })
    ).toEqual({ action: "skip", reason: "base not bot branch" });
  });

  test("skips when head branch is default", () => {
    expect(
      computeHeadBranchDeletionDecision({
        ...baseInput,
        headRefName: "main",
      })
    ).toEqual({ action: "skip", reason: "head is default branch" });
  });

  test("skips when head ref is missing", () => {
    expect(
      computeHeadBranchDeletionDecision({
        ...baseInput,
        headRefName: "",
      })
    ).toEqual({ action: "skip", reason: "missing head ref" });
  });

  test("skips when head ref moved", () => {
    expect(
      computeHeadBranchDeletionDecision({
        ...baseInput,
        currentHeadSha: "beadfeed",
      })
    ).toEqual({ action: "skip", reason: "head ref moved" });
  });
});
