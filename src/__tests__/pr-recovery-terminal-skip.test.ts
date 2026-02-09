import { describe, expect, mock, test, beforeEach } from "bun:test";

import { RepoWorker } from "../worker";

const updateTaskStatusMock = mock(async () => true);

const queueAdapter = {
  updateTaskStatus: updateTaskStatusMock,
};

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/ralph#319",
    repo: "3mdistal/ralph",
    status: "queued",
    priority: "p2-medium",
    name: "Test Task",
    ...overrides,
  } as any;
}

describe("PR recovery terminal skip", () => {
  beforeEach(() => {
    updateTaskStatusMock.mockClear();
  });

  test("tryEnsurePrFromWorktree returns terminal run when merged fix PR exists on bot branch", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });

    const issueMeta = {
      labels: [],
      title: "Still open",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/319",
    };

    let agentRunData: any = null;
    (worker as any).getIssueMetadata = async () => issueMeta;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    // Ensure we short-circuit before any PR lookup / GH commands.
    (worker as any).getIssuePrResolution = async () => {
      throw new Error("unexpected getIssuePrResolution call");
    };

    (worker as any).searchMergedPullRequestsByIssueLink = async () => [
      {
        url: "https://github.com/3mdistal/ralph/pull/631",
        number: 631,
        baseRefName: "bot/integration",
        createdAt: "2026-02-08T13:27:00Z",
        updatedAt: "2026-02-08T20:00:01Z",
      },
    ];

    const task = createMockTask({
      status: "in-progress",
      "session-id": "ses_abc123",
      "worktree-path": "/tmp/worktree-1",
    });

    const result = await (worker as any).tryEnsurePrFromWorktree({
      task,
      issueNumber: "319",
      issueTitle: "Test Task",
      botBranch: "bot/integration",
      started: new Date("2026-02-09T00:00:00.000Z"),
    });

    expect(result.prUrl).toBeNull();
    expect(result.terminalRun?.outcome).toBe("success");

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("done");
    expect(lastCall[2]["session-id"]).toBe("");
    expect(lastCall[2]["worktree-path"]).toBe("");
    expect(lastCall[2]["completed-at"]).toBeTruthy();

    expect(agentRunData?.outcome).toBe("success");
    expect(String(agentRunData?.bodyPrefix ?? "")).toContain("merged fix PR");
    expect(String(agentRunData?.bodyPrefix ?? "")).toContain("https://github.com/3mdistal/ralph/pull/631");
  });

  test("merged PR on another base branch does not trigger terminal skip", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });

    (worker as any).getIssueMetadata = async () => ({ labels: [], title: "Open", state: "OPEN", url: "x" });
    (worker as any).searchMergedPullRequestsByIssueLink = async () => [
      { url: "https://github.com/3mdistal/ralph/pull/100", number: 100, baseRefName: "main" },
    ];

    (worker as any).getIssuePrResolution = async () => ({
      selectedUrl: "https://github.com/3mdistal/ralph/pull/123",
      duplicates: [],
      source: "db",
      diagnostics: [],
    });

    const task = createMockTask();

    const result = await (worker as any).tryEnsurePrFromWorktree({
      task,
      issueNumber: "319",
      issueTitle: "Test Task",
      botBranch: "bot/integration",
      started: new Date("2026-02-09T00:00:00.000Z"),
    });

    expect(result.terminalRun).toBeUndefined();
    expect(result.prUrl).toBe("https://github.com/3mdistal/ralph/pull/123");
  });
});
