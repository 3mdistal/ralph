import { describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "github:3mdistal/ralph#796",
    _name: "issue-796",
    type: "agent-task",
    "creation-date": "2026-02-01",
    scope: "builder",
    issue: "3mdistal/ralph#796",
    repo: "3mdistal/ralph",
    status: "in-progress",
    name: "Issue 796",
    "session-id": "sess-796",
    ...overrides,
  } as any;
}

describe("RepoWorker.resumeTask POLICY_DENIED recovery", () => {
  test("fast-fails without repeated continue retries", async () => {
    const updateTaskStatusMock = mock(async () => true);
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      queue: { updateTaskStatus: updateTaskStatusMock } as any,
    });
    const task = createTask();

    const continueSessionMock = mock(async () => ({
      success: true,
      output: "resume output without PR URL",
      sessionId: "sess-796",
      prUrl: null,
    }));
    const buildPrRecoveryNudgeMock = mock(() => "nudge");

    (worker as any).getIssueMetadata = mock(async () => ({
      state: "OPEN",
      title: "Issue 796",
      labels: [],
      url: "https://example.com/issues/796",
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
    (worker as any).maybeHandleQueuedMergeConflict = mock(async () => null);
    (worker as any).getIssuePrResolution = mock(async () => ({
      selectedUrl: null,
      duplicates: [],
      source: "none",
      diagnostics: [],
    }));
    (worker as any).markIssueInProgressForOpenPrBestEffort = mock(async () => {});
    (worker as any).withRunContext = mock(async (_task: any, _lane: string, fn: () => Promise<any>) => await fn());
    (worker as any).publishDashboardEvent = mock(() => {});
    (worker as any).logWorker = mock(() => {});
    (worker as any).recordRunLogPath = mock(async () => "/tmp/run.log");
    (worker as any).recordImplementationCheckpoint = mock(async () => {});
    (worker as any).publishCheckpoint = mock(() => {});
    (worker as any).drainNudges = mock(async () => {});
    (worker as any).updateOpenPrSnapshot = mock((_task: any, _prior: string | null, next: string | null) => next);
    (worker as any).checkPrCreateCapability = mock(async () => null);
    (worker as any).tryEnsurePrFromWorktree = mock(async () => ({
      terminalRun: undefined,
      prUrl: null,
      diagnostics: "- Preflight policy failed; refusing to create PR",
      causeCode: "POLICY_DENIED",
    }));
    (worker as any).buildWatchdogOptions = mock(() => ({}));
    (worker as any).buildStallOptions = mock(() => ({}));
    (worker as any).buildLoopDetectionOptions = mock(() => ({}));
    (worker as any).buildPrRecoveryNudge = buildPrRecoveryNudgeMock;
    (worker as any).writeEscalationWriteback = mock(async () => {});
    (worker as any).recordEscalatedRunNote = mock(async () => {});
    (worker as any).notify = { notifyEscalation: mock(async () => {}) };
    (worker as any).session = {
      continueSession: continueSessionMock,
      continueCommand: mock(async () => ({ success: true, output: "survey", sessionId: "sess-796" })),
    };

    const result = await worker.resumeTask(task);

    expect(result.outcome).toBe("escalated");
    expect(continueSessionMock).toHaveBeenCalledTimes(1);
    expect(buildPrRecoveryNudgeMock).not.toHaveBeenCalled();
    expect((worker as any).tryEnsurePrFromWorktree).toHaveBeenCalledTimes(2);
  });
});
