import { describe, expect, test } from "bun:test";

import { BASELINE_LABELS, computeMissingBaselineLabels } from "../github-labels";

describe("computeMissingBaselineLabels", () => {
  test("returns all baseline labels when none exist", () => {
    const missing = computeMissingBaselineLabels([]);
    expect(missing.map((l) => l.name)).toEqual(BASELINE_LABELS.map((l) => l.name));
  });

  test("returns empty when all baseline labels exist (case-insensitive)", () => {
    const existing = ["DX", "Refactor", " bug ", "Chore", "TEST"];
    const missing = computeMissingBaselineLabels(existing);
    expect(missing).toEqual([]);
  });

  test("returns only missing baseline labels", () => {
    const existing = ["bug", "dx"];
    const missing = computeMissingBaselineLabels(existing);
    expect(missing.map((l) => l.name)).toEqual(["refactor", "chore", "test"]);
  });
});
