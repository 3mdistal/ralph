import { describe, expect, mock, test, beforeEach } from "bun:test";

// Mock queue updates so tests don't touch the real vault.
const updateTaskStatusMock = mock(async () => true);

mock.module("../queue", () => ({
  updateTaskStatus: updateTaskStatusMock,
}));

import { RepoWorker } from "../worker";

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/bwrb#319",
    repo: "3mdistal/bwrb",
    status: "queued",
    priority: "p2-medium",
    name: "Test Task",
    ...overrides,
  } as any;
}

describe("closed issue guardrail", () => {
  beforeEach(() => {
    updateTaskStatusMock.mockClear();
  });

  test("processTask skips when gh reports CLOSED", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");

    const issueMeta = {
      labels: [],
      title: "Already fixed",
      state: "CLOSED",
      url: "https://github.com/3mdistal/bwrb/issues/319",
      closedAt: "2026-01-09T21:24:15Z",
      stateReason: "completed",
    };

    let agentRunData: any = null;

    (worker as any).getIssueMetadata = async () => issueMeta;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask({
      status: "queued",
      "session-id": "ses_old",
      "worktree-path": "/tmp/worktree-1",
    });

    const result = await worker.processTask(task);

    expect(result.outcome).toBe("success");

    // Marks agent-task done and clears session/worktree fields.
    expect(updateTaskStatusMock).toHaveBeenCalled();
    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("done");
    expect(lastCall[2]["session-id"]).toBe("");
    expect(lastCall[2]["worktree-path"]).toBe("");
    expect(lastCall[2]["completed-at"]).toBeTruthy();

    // Writes an agent-run body with deterministic prefix + issue URL + closedAt.
    expect(agentRunData?.outcome).toBe("success");
    expect(String(agentRunData?.bodyPrefix ?? "").startsWith("Skipped: issue already closed upstream")).toBe(true);
    expect(agentRunData?.bodyPrefix).toContain(issueMeta.url);
    expect(agentRunData?.bodyPrefix).toContain(issueMeta.closedAt);
  });

  test("resumeTask skips when gh reports CLOSED", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");

    const issueMeta = {
      labels: [],
      title: "Already fixed",
      state: "CLOSED",
      url: "https://github.com/3mdistal/bwrb/issues/319",
      closedAt: "2026-01-09T21:24:15Z",
      stateReason: "completed",
    };

    let agentRunData: any = null;

    (worker as any).getIssueMetadata = async () => issueMeta;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask({
      status: "in-progress",
      "session-id": "ses_abc123",
      "worktree-path": "/tmp/worktree-1",
    });

    const result = await worker.resumeTask(task);

    expect(result.outcome).toBe("success");

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("done");
    expect(lastCall[2]["session-id"]).toBe("");
    expect(lastCall[2]["worktree-path"]).toBe("");
    expect(lastCall[2]["completed-at"]).toBeTruthy();

    expect(agentRunData?.outcome).toBe("success");
    expect(String(agentRunData?.bodyPrefix ?? "").startsWith("Skipped: issue already closed upstream")).toBe(true);
    expect(agentRunData?.bodyPrefix).toContain(issueMeta.url);
    expect(agentRunData?.bodyPrefix).toContain(issueMeta.closedAt);
  });
});
