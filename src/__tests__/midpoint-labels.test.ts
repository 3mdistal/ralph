import { describe, expect, test } from "bun:test";

import { computeMidpointLabelPlan as computePlan } from "../midpoint-labels";

describe("midpoint label plan", () => {
  test("adds in-bot and clears in-progress for bot branch merge", () => {
    expect(computePlan({ baseBranch: "bot/integration", botBranch: "bot/integration" })).toEqual({
      addInBot: true,
      removeInProgress: true,
    });
  });

  test("clears in-progress for main merges", () => {
    expect(computePlan({ baseBranch: "main", botBranch: "bot/integration" })).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("clears in-progress when botBranch is main", () => {
    expect(computePlan({ baseBranch: "main", botBranch: "main" })).toEqual({
      addInBot: false,
      removeInProgress: true,
    });
  });

  test("no label changes when base differs from bot branch", () => {
    expect(computePlan({ baseBranch: "feature", botBranch: "bot/integration" })).toEqual({
      addInBot: false,
      removeInProgress: false,
    });
  });

  test("normalizes refs/heads prefixes", () => {
    expect(computePlan({ baseBranch: "refs/heads/bot/integration", botBranch: "bot/integration" })).toEqual({
      addInBot: true,
      removeInProgress: true,
    });
  });
});
