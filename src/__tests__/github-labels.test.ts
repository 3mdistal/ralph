import { describe, expect, test } from "bun:test";

import {
  BASELINE_LABELS,
  RALPH_WORKFLOW_LABELS,
  computeMissingBaselineLabels,
  computeMissingRalphLabels,
} from "../github-labels";

describe("computeMissingBaselineLabels", () => {
  test("returns all baseline labels when none exist", () => {
    const missing = computeMissingBaselineLabels([]);
    expect(missing.map((l) => l.name)).toEqual(BASELINE_LABELS.map((l) => l.name));
  });

  test("returns empty when all baseline labels exist (case-insensitive)", () => {
    const existing = ["DX", "Refactor", " bug ", "Chore", "TEST", "ALLOW-MAIN"];
    const missing = computeMissingBaselineLabels(existing);
    expect(missing).toEqual([]);
  });

  test("returns only missing baseline labels", () => {
    const existing = ["bug", "dx"];
    const missing = computeMissingBaselineLabels(existing);
    expect(missing.map((l) => l.name)).toEqual(["refactor", "chore", "test", "allow-main"]);
  });
});

describe("computeMissingRalphLabels", () => {
  test("returns all workflow labels when none exist", () => {
    const missing = computeMissingRalphLabels([]);
    expect(missing.map((l) => l.name)).toEqual(RALPH_WORKFLOW_LABELS.map((l) => l.name));
  });

  test("returns empty when all workflow labels exist", () => {
    const existing = ["RALPH:QUEUED", "ralph:in-progress", "ralph:in-bot", "RALPH:BLOCKED", "ralph:escalated"];
    const missing = computeMissingRalphLabels(existing);
    expect(missing).toEqual([]);
  });

  test("returns missing workflow labels", () => {
    const existing = ["ralph:queued", "ralph:blocked"];
    const missing = computeMissingRalphLabels(existing);
    expect(missing.map((l) => l.name)).toEqual(["ralph:in-progress", "ralph:in-bot", "ralph:escalated"]);
  });
});
