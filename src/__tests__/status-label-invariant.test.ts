import { describe, expect, test } from "bun:test";

import { countStatusLabels, chooseStatusHealTarget, enforceSingleStatusLabelInvariant } from "../github/status-label-invariant";

function createLabelIo(initial: string[]) {
  const labels = new Set(initial);
  return {
    io: {
      listLabels: async () => Array.from(labels),
      addLabels: async (next: string[]) => {
        for (const label of next) labels.add(label);
      },
      removeLabel: async (label: string) => {
        labels.delete(label);
      },
    },
    current: () => Array.from(labels),
  };
}

describe("status label invariant", () => {
  test("counts only status labels", () => {
    expect(countStatusLabels(["bug", "ralph:status:queued", "ralph:cmd:queue"])).toBe(1);
  });

  test("chooses queued when not actively owned", () => {
    expect(
      chooseStatusHealTarget({
        repo: "3mdistal/ralph",
        issueNumber: 1,
        activeOwnership: false,
      })
    ).toBe("ralph:status:queued");
  });

  test("chooses queued when dependency blocked even if actively owned", () => {
    expect(
      chooseStatusHealTarget({
        repo: "3mdistal/ralph",
        issueNumber: 2,
        activeOwnership: true,
        dependencyBlocked: true,
      })
    ).toBe("ralph:status:queued");
  });

  test("dependency blocked overrides in-progress desired hint", () => {
    expect(
      chooseStatusHealTarget({
        repo: "3mdistal/ralph",
        issueNumber: 3,
        desiredHint: "ralph:status:in-progress",
        dependencyBlocked: true,
      })
    ).toBe("ralph:status:queued");
  });

  test("heals empty status label set", async () => {
    const labels = createLabelIo(["bug"]);
    await enforceSingleStatusLabelInvariant({
      repo: "3mdistal/ralph",
      issueNumber: 42,
      io: labels.io,
      activeOwnership: false,
      logPrefix: "[test]",
    });

    expect(labels.current()).toContain("ralph:status:queued");
    expect(countStatusLabels(labels.current())).toBe(1);
  });

  test("heals multiple statuses to desired hint", async () => {
    const labels = createLabelIo(["ralph:status:queued", "ralph:status:in-progress", "dx"]);
    await enforceSingleStatusLabelInvariant({
      repo: "3mdistal/ralph",
      issueNumber: 99,
      io: labels.io,
      desiredHint: "ralph:status:in-progress",
      logPrefix: "[test]",
    });

    expect(labels.current()).toContain("ralph:status:in-progress");
    expect(labels.current()).not.toContain("ralph:status:queued");
    expect(labels.current()).toContain("dx");
    expect(countStatusLabels(labels.current())).toBe(1);
  });
});
