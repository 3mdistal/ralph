import { describe, expect, test } from "bun:test";

import { computeQueueParityAudit } from "../github/queue-parity-audit";

describe("queue parity audit", () => {
  test("counts gh queued/local blocked drift", () => {
    const report = computeQueueParityAudit({
      repo: "3mdistal/ralph",
      issues: [
        {
          repo: "3mdistal/ralph",
          number: 101,
          state: "OPEN",
          labels: ["ralph:status:queued"],
        },
      ],
      opStates: [
        {
          repo: "3mdistal/ralph",
          issueNumber: 101,
          taskPath: "github:3mdistal/ralph#101",
          status: "blocked",
        },
      ],
    });

    expect(report.ghQueuedLocalBlocked).toBe(1);
    expect(report.sampleGhQueuedLocalBlocked).toEqual(["3mdistal/ralph#101"]);
  });

  test("counts multi-status and missing-status issues", () => {
    const report = computeQueueParityAudit({
      repo: "3mdistal/ralph",
      issues: [
        {
          repo: "3mdistal/ralph",
          number: 201,
          state: "OPEN",
          labels: ["ralph:status:queued", "ralph:status:in-progress"],
        },
        {
          repo: "3mdistal/ralph",
          number: 202,
          state: "OPEN",
          labels: ["bug"],
        },
      ],
      opStates: [
        {
          repo: "3mdistal/ralph",
          issueNumber: 202,
          taskPath: "github:3mdistal/ralph#202",
          status: "in-progress",
        },
      ],
    });

    expect(report.multiStatusLabels).toBe(1);
    expect(report.missingStatusWithOpState).toBe(1);
  });
});
