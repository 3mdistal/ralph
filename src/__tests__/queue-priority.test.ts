import { describe, expect, test } from "bun:test";

import { inferPriorityFromLabels, normalizePriorityInputToRalphPriorityLabel, normalizeTaskPriority } from "../queue/priority";

describe("priority parsing", () => {
  test("inferPriorityFromLabels defaults to p2-medium", () => {
    expect(inferPriorityFromLabels([])).toBe("p2-medium");
  });

  test("inferPriorityFromLabels matches case-insensitive prefixes", () => {
    expect(inferPriorityFromLabels(["P2"])).toBe("p2-medium");
  });

  test("inferPriorityFromLabels prefers canonical labels", () => {
    expect(inferPriorityFromLabels(["ralph:priority:p3"])).toBe("p3-low");
  });

  test("inferPriorityFromLabels accepts suffixes", () => {
    expect(inferPriorityFromLabels(["p3:low"])).toBe("p3-low");
    expect(inferPriorityFromLabels(["p4 backlog"])).toBe("p4-backlog");
  });

  test("inferPriorityFromLabels chooses highest priority", () => {
    expect(inferPriorityFromLabels(["p3-low", "p1-high"])).toBe("p1-high");
  });

  test("inferPriorityFromLabels uses canonical over legacy", () => {
    expect(inferPriorityFromLabels(["p0-critical", "ralph:priority:p3"])).toBe("p3-low");
  });

  test("inferPriorityFromLabels chooses highest canonical priority", () => {
    expect(inferPriorityFromLabels(["ralph:priority:p4", "ralph:priority:p1"]))
      .toBe("p1-high");
  });

  test("inferPriorityFromLabels ignores p10 legacy labels", () => {
    expect(inferPriorityFromLabels(["p10"])).toBe("p2-medium");
  });

  test("inferPriorityFromLabels ignores invalid canonical labels", () => {
    expect(inferPriorityFromLabels(["ralph:priority:p10"])).toBe("p2-medium");
  });
});

describe("normalizeTaskPriority", () => {
  test("normalizes canonical values", () => {
    expect(normalizeTaskPriority("p0-critical")).toBe("p0-critical");
  });

  test("normalizes canonical label inputs", () => {
    expect(normalizeTaskPriority("ralph:priority:p1")).toBe("p1-high");
  });

  test("normalizes prefix values", () => {
    expect(normalizeTaskPriority("P2")).toBe("p2-medium");
    expect(normalizeTaskPriority("p4 backlog")).toBe("p4-backlog");
  });

  test("normalizes p10 to default", () => {
    expect(normalizeTaskPriority("p10")).toBe("p2-medium");
  });
});

describe("normalizePriorityInputToRalphPriorityLabel", () => {
  test("maps legacy inputs to canonical labels", () => {
    expect(normalizePriorityInputToRalphPriorityLabel("p3:low")).toBe("ralph:priority:p3");
  });

  test("maps canonical labels to themselves", () => {
    expect(normalizePriorityInputToRalphPriorityLabel("ralph:priority:p0")).toBe("ralph:priority:p0");
  });
});
