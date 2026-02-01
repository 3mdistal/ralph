import { describe, expect, test } from "bun:test";

import {
  buildIssueStorePlan,
  computeNewLastSyncAt,
  computeSince,
  extractLabelNames,
  normalizeIssueState,
  shouldStoreIssue,
} from "../github/issues-sync-core";

describe("github issues sync core", () => {
  test("computeSince applies skew and handles invalid timestamps", () => {
    expect(computeSince(null)).toBeNull();
    expect(computeSince("not-a-date")).toBeNull();
    expect(computeSince("2026-01-11T00:00:10.000Z", 5)).toBe("2026-01-11T00:00:05.000Z");
  });

  test("extractLabelNames normalizes strings and objects", () => {
    expect(extractLabelNames(undefined)).toEqual([]);
    expect(extractLabelNames([" ralph:queued ", { name: " dx " }, { name: "" }])).toEqual([
      "ralph:queued",
      "dx",
    ]);
  });

  test("shouldStoreIssue honors ralph, snapshot, and storeAllOpen", () => {
    expect(
      shouldStoreIssue({ hasRalph: true, hasSnapshot: false, storeAllOpen: false, normalizedState: "OPEN" })
    ).toBe(true);
    expect(
      shouldStoreIssue({ hasRalph: false, hasSnapshot: true, storeAllOpen: false, normalizedState: "OPEN" })
    ).toBe(true);
    expect(
      shouldStoreIssue({ hasRalph: false, hasSnapshot: false, storeAllOpen: true, normalizedState: "OPEN" })
    ).toBe(true);
    expect(
      shouldStoreIssue({ hasRalph: false, hasSnapshot: false, storeAllOpen: true, normalizedState: "CLOSED" })
    ).toBe(false);
  });

  test("buildIssueStorePlan filters and counts ralph labels", () => {
    const issues = [
      {
        number: 1,
        state: "open",
        labels: [{ name: "ralph:queued" }],
        title: "Issue 1",
      },
      {
        number: 2,
        state: "closed",
        labels: [{ name: "dx" }],
        title: "Issue 2",
      },
    ];

    const plan = buildIssueStorePlan({
      repo: "org/repo",
      issues,
      storeAllOpen: false,
      hasIssueSnapshot: () => false,
    });

    expect(plan.plans.length).toBe(1);
    expect(plan.plans[0]?.issueRef).toBe("org/repo#1");
    expect(plan.plans[0]?.state).toBe(normalizeIssueState("open"));
    expect(plan.ralphCount).toBe(1);
  });

  test("computeNewLastSyncAt mirrors fetch rules", () => {
    expect(
      computeNewLastSyncAt({
        fetched: 0,
        maxUpdatedAt: "2026-01-11T00:00:03.000Z",
        lastSyncAt: "2026-01-11T00:00:01.000Z",
        nowIso: "2026-01-11T00:00:10.000Z",
      })
    ).toBe("2026-01-11T00:00:01.000Z");

    expect(
      computeNewLastSyncAt({
        fetched: 2,
        maxUpdatedAt: null,
        lastSyncAt: null,
        nowIso: "2026-01-11T00:00:10.000Z",
      })
    ).toBe("2026-01-11T00:00:10.000Z");
  });
});
