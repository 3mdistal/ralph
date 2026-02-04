import { describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "github:3mdistal/ralph#10",
    _name: "issue-10",
    type: "agent-task",
    "creation-date": "2026-02-01",
    scope: "builder",
    issue: "3mdistal/ralph#10",
    repo: "3mdistal/ralph",
    status: "in-progress",
    name: "Issue 10",
    "session-id": "sess-1",
    ...overrides,
  } as any;
}

describe("RepoWorker.resumeTask merge-conflict preflight", () => {
  test("merge-conflict recovery bypasses session resume", async () => {
    const updateTaskStatusMock = mock(async () => true);
    const queueAdapter = { updateTaskStatus: updateTaskStatusMock } as any;
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const task = createTask();

    const sentinel = {
      taskName: task.name,
      repo: task.repo,
      outcome: "failed",
      escalationReason: "merge-conflict preflight handled",
    } as any;

    (worker as any).getIssueMetadata = mock(async () => ({
      state: "OPEN",
      title: "Issue 10",
      labels: [],
      url: "https://example.com/issues/10",
    }));
    (worker as any).ensureRalphWorkflowLabelsOnce = mock(async () => {});
    (worker as any).ensureBranchProtectionOnce = mock(async () => {});
    (worker as any).formatWorkerId = mock(async () => "worker-1");
    (worker as any).resolveAssignedRepoSlot = mock(() => 0);
    (worker as any).assertRepoRootClean = mock(async () => {});
    (worker as any).resolveTaskRepoPath = mock(async () => ({
      kind: "ok",
      repoPath: "/tmp/repo",
      worktreePath: null,
    }));
    (worker as any).prepareContextRecovery = mock(async () => {});
    (worker as any).resolveOpencodeXdgForTask = mock(async () => ({
      error: null,
      profileName: null,
      opencodeXdg: null,
    }));
    (worker as any).pauseIfHardThrottled = mock(async () => null);
    (worker as any).ensureSetupForTask = mock(async () => null);

    const continueSessionMock = mock(async () => ({
      success: true,
      output: "ok",
      sessionId: task["session-id"],
      prUrl: null,
    }));
    (worker as any).session = { continueSession: continueSessionMock };

    (worker as any).maybeHandleQueuedMergeConflict = mock(async () => sentinel);

    const result = await worker.resumeTask(task);
    expect(result).toEqual(sentinel);
    expect(continueSessionMock).not.toHaveBeenCalled();
  });
});
