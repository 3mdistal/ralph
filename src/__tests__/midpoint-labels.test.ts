import { describe, expect, test } from "bun:test";

import { computeMidpointLabelPlan as computePlan } from "../midpoint-labels";

describe("midpoint label plan", () => {
  test("adds in-bot and clears in-progress for bot branch merge", () => {
    expect(
      computePlan({ baseBranch: "bot/integration", botBranch: "bot/integration", defaultBranch: "main" })
    ).toEqual({
      addInBot: true,
      removeInProgress: true,
    });
  });

  test("clears in-progress for main merges", () => {
    expect(
      computePlan({ baseBranch: "main", botBranch: "bot/integration", defaultBranch: "main" })
    ).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("clears in-progress when botBranch is main", () => {
    expect(computePlan({ baseBranch: "main", botBranch: "main", defaultBranch: "main" })).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("clears in-progress when base branch is unknown", () => {
    expect(computePlan({ baseBranch: "", botBranch: "bot/integration", defaultBranch: "main" })).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("treats unknown default branch as bot-only midpoint", () => {
    expect(computePlan({ baseBranch: "bot/integration", botBranch: "bot/integration", defaultBranch: "" })).toEqual({
      addInBot: true,
      removeInProgress: true,
    });
    expect(computePlan({ baseBranch: "release", botBranch: "bot/integration", defaultBranch: "" })).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("clears in-progress when base differs from bot branch", () => {
    expect(
      computePlan({ baseBranch: "feature", botBranch: "bot/integration", defaultBranch: "main" })
    ).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("normalizes refs/heads prefixes", () => {
    expect(
      computePlan({
        baseBranch: "refs/heads/bot/integration",
        botBranch: "bot/integration",
        defaultBranch: "main",
      })
    ).toEqual({
      addInBot: true,
      removeInProgress: true,
    });
  });
});
