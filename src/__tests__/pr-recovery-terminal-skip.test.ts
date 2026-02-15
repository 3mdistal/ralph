import { describe, expect, mock, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
    expect(result.terminalRun?.pr).toBe("https://github.com/3mdistal/ralph/pull/631");
    expect(result.terminalRun?.completionKind).toBe("pr");

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

  test("closed issue terminal skip carries explicit no-PR terminal reason", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });

    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Closed",
      state: "CLOSED",
      url: "https://github.com/3mdistal/ralph/issues/319",
      closedAt: "2026-02-10T00:00:00Z",
      stateReason: "completed",
    });

    (worker as any).createAgentRun = async () => {};

    const task = createMockTask({ status: "in-progress", "session-id": "ses_closed" });

    const result = await (worker as any).tryEnsurePrFromWorktree({
      task,
      issueNumber: "319",
      issueTitle: "Closed Task",
      botBranch: "bot/integration",
      started: new Date("2026-02-09T00:00:00.000Z"),
    });

    expect(result.terminalRun?.outcome).toBe("success");
    expect(result.terminalRun?.completionKind).toBe("verified");
    expect(result.terminalRun?.noPrTerminalReason).toBe("ISSUE_CLOSED_UPSTREAM");
  });

  test("detached worktree attempts recovery branch materialization before NO_WORKTREE_BRANCH", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const wtRoot = mkdtempSync(join(tmpdir(), "ralph-pr-recovery-"));
    const wtPath = join(wtRoot, "745", "github-3mdistal-ralph-745");
    mkdirSync(wtPath, { recursive: true });

    const materializeMock = mock(async () => ({
      branch: "ralph/recovery-745-deadbeefcafe",
      diagnostics: ["- Materialized recovery branch from detached HEAD: ralph/recovery-745-deadbeefcafe"],
    }));

    (worker as any).maybeSkipIssueForPrRecovery = async () => null;
    (worker as any).getIssuePrResolution = async () => ({
      selectedUrl: null,
      duplicates: [],
      source: "none",
      diagnostics: [],
    });
    (worker as any).getGitWorktrees = async () => [
      {
        worktreePath: wtPath,
        branch: undefined,
        detached: true,
      },
    ];
    (worker as any).materializeDetachedHeadRecoveryBranch = materializeMock;

    const task = createMockTask({ issue: "3mdistal/ralph#745" });
    const result = await (worker as any).tryEnsurePrFromWorktree({
      task,
      issueNumber: "745",
      issueTitle: "Status reporting",
      botBranch: "bot/integration",
      started: new Date("2026-02-09T00:00:00.000Z"),
    });

    expect(materializeMock).toHaveBeenCalled();
    expect(result.causeCode).not.toBe("NO_WORKTREE_BRANCH");
    expect(result.diagnostics).toContain("Materialized recovery branch from detached HEAD");
  });
});
