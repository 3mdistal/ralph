import { describe, expect, test } from "bun:test";

import { inferPriorityFromLabels, normalizeTaskPriority, planRalphPriorityLabelDelta } from "../queue/priority";

describe("priority parsing", () => {
  test("inferPriorityFromLabels defaults to p2-medium", () => {
    expect(inferPriorityFromLabels([])).toBe("p2-medium");
  });

  test("inferPriorityFromLabels matches case-insensitive prefixes", () => {
    expect(inferPriorityFromLabels(["P2"])).toBe("p2-medium");
  });

  test("inferPriorityFromLabels accepts suffixes", () => {
    expect(inferPriorityFromLabels(["p3:low"])).toBe("p3-low");
    expect(inferPriorityFromLabels(["p4 backlog"])).toBe("p4-backlog");
  });

  test("inferPriorityFromLabels chooses highest priority", () => {
    expect(inferPriorityFromLabels(["p3-low", "p1-high"])).toBe("p1-high");
  });

  test("inferPriorityFromLabels prefers ralph:priority labels", () => {
    expect(inferPriorityFromLabels(["p0-critical", "ralph:priority:p3"])).toBe("p3-low");
  });

  test("inferPriorityFromLabels reads ralph:priority labels", () => {
    expect(inferPriorityFromLabels(["ralph:priority:p1"])).toBe("p1-high");
  });

  test("inferPriorityFromLabels treats p10 as p1-high", () => {
    expect(inferPriorityFromLabels(["p10"])).toBe("p1-high");
  });
});

describe("normalizeTaskPriority", () => {
  test("normalizes canonical values", () => {
    expect(normalizeTaskPriority("p0-critical")).toBe("p0-critical");
  });

  test("normalizes prefix values", () => {
    expect(normalizeTaskPriority("P2")).toBe("p2-medium");
    expect(normalizeTaskPriority("p4 backlog")).toBe("p4-backlog");
  });

  test("normalizes ralph:priority labels", () => {
    expect(normalizeTaskPriority("ralph:priority:p0")).toBe("p0-critical");
  });

  test("normalizes p10 to p1-high", () => {
    expect(normalizeTaskPriority("p10")).toBe("p1-high");
  });
});

describe("planRalphPriorityLabelDelta", () => {
  test("returns add/remove for ralph:priority labels only", () => {
    const delta = planRalphPriorityLabelDelta("p1-high", ["bug", "ralph:priority:p3"]);
    expect(delta).toEqual({ add: ["ralph:priority:p1"], remove: ["ralph:priority:p3"] });
  });
});
