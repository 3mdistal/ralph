import { describe, expect, test } from "bun:test";

import {
  ControlPlaneRequestError,
  buildGitHubTaskCommandPlan,
  parseTaskCommandRequest,
} from "../dashboard/task-command";

describe("dashboard task command", () => {
  test("parses valid request and trims comment", () => {
    const parsed = parseTaskCommandRequest({
      taskId: "github:3mdistal/ralph#37",
      command: "Pause",
      comment: "  please pause at checkpoint  ",
    });

    expect(parsed).toEqual({
      taskId: "github:3mdistal/ralph#37",
      command: "pause",
      comment: "please pause at checkpoint",
    });
  });

  test("rejects invalid command", () => {
    expect(() =>
      parseTaskCommandRequest({
        taskId: "github:3mdistal/ralph#37",
        command: "resume",
      })
    ).toThrow(ControlPlaneRequestError);
  });

  test("builds plan and maps command label", () => {
    const plan = buildGitHubTaskCommandPlan({
      taskId: "github:3mdistal/ralph#37",
      command: "queue",
      comment: null,
      allowedRepos: new Set(["3mdistal/ralph"]),
    });

    expect(plan.repo).toBe("3mdistal/ralph");
    expect(plan.issueNumber).toBe(37);
    expect(plan.cmdLabel).toBe("ralph:cmd:queue");
  });

  test("rejects non-github task ids", () => {
    expect(() =>
      buildGitHubTaskCommandPlan({
        taskId: "orchestration/tasks/foo",
        command: "queue",
        allowedRepos: new Set(["3mdistal/ralph"]),
      })
    ).toThrow(ControlPlaneRequestError);
  });

  test("rejects repos outside configured allowlist", () => {
    expect(() =>
      buildGitHubTaskCommandPlan({
        taskId: "github:someone/else#9",
        command: "stop",
        allowedRepos: new Set(["3mdistal/ralph"]),
      })
    ).toThrow(ControlPlaneRequestError);
  });
});
