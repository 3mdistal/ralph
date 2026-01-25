import { describe, expect, test } from "bun:test";

import type { AgentTask } from "../queue-backend";
import { deriveTaskId, deriveWorkerId } from "../task-identifiers";

describe("task identifier helpers", () => {
  test("prefers bwrb path when available", () => {
    const task = {
      _path: "orchestration/tasks/42",
      name: "Task 42",
      repo: "demo/repo",
      issue: "demo/repo#42",
    } as AgentTask;

    expect(deriveTaskId(task)).toBe("orchestration/tasks/42");
    expect(deriveWorkerId(task)).toBe("demo/repo#orchestration/tasks/42");
  });

  test("falls back to issue number for GitHub tasks", () => {
    const task = {
      name: "Issue 31",
      repo: "demo/repo",
      issue: "demo/repo#31",
    } as AgentTask;

    expect(deriveTaskId(task)).toBe("issue:31");
    expect(deriveWorkerId(task)).toBe("demo/repo#issue:31");
  });
});
