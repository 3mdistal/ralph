import { describe, expect, test } from "bun:test";

import { groupByRepo } from "../queue";
import type { AgentTask } from "../queue/types";

const BASE_TASK = {
  type: "agent-task",
  "creation-date": "2026-01-23T00:00:00.000Z",
  scope: "builder",
  repo: "3mdistal/ralph",
  status: "queued",
} as const;

function makeTask(params: { issue: string; name: string; priority?: AgentTask["priority"] }): AgentTask {
  return {
    ...BASE_TASK,
    _path: `github:${params.issue}`,
    _name: params.name,
    issue: params.issue,
    name: params.name,
    priority: params.priority,
  };
}

describe("groupByRepo priority ordering", () => {
  test("ties use issue number ordering", () => {
    const tasks = [
      makeTask({ issue: "3mdistal/ralph#2", name: "Second" }),
      makeTask({ issue: "3mdistal/ralph#1", name: "First" }),
    ];

    const grouped = groupByRepo(tasks).get("3mdistal/ralph") ?? [];
    expect(grouped.map((task) => task.issue)).toEqual(["3mdistal/ralph#1", "3mdistal/ralph#2"]);
  });

  test("invalid priority does not outrank p0", () => {
    const invalid = makeTask({ issue: "3mdistal/ralph#3", name: "Invalid" });
    (invalid as { priority?: string }).priority = "p9";
    const critical = makeTask({ issue: "3mdistal/ralph#4", name: "Critical", priority: "p0-critical" });

    const grouped = groupByRepo([invalid, critical]).get("3mdistal/ralph") ?? [];
    expect(grouped[0]?.issue).toBe("3mdistal/ralph#4");
  });
});
