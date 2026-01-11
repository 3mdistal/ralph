import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (must be declared before importing worker) ---

const updateTaskStatusMock = mock(async () => true);

mock.module("../queue", () => ({
  updateTaskStatus: updateTaskStatusMock,
}));

const notifyEscalationMock = mock(async () => true);
const notifyErrorMock = mock(async () => true);
const notifyTaskCompleteMock = mock(async () => true);

mock.module("../notify", () => ({
  notifyEscalation: notifyEscalationMock,
  notifyError: notifyErrorMock,
  notifyTaskComplete: notifyTaskCompleteMock,
}));

mock.module("../nudge", () => ({
  drainQueuedNudges: async () => [],
}));

const runCommandMock = mock(async () => ({
  sessionId: "ses_plan",
  success: true,
  output: [
    "## Plan",
    "- Do the thing",
    "",
    "```json",
    JSON.stringify({ decision: "proceed", confidence: "high", escalation_reason: null }, null, 2),
    "```",
    "",
  ].join("\n"),
}));

const continueSessionMock = mock(async (_repoPath: string, _sessionId: string, message: string) => {
  if (message.includes("Proceed with implementation")) {
    return {
      sessionId: "ses_build",
      success: true,
      output: [
        "Implementation complete.",
        "PR: https://github.com/3mdistal/ralph/pull/999",
      ].join("\n"),
    };
  }

  // Merge approval step.
  return {
    sessionId: "ses_build",
    success: true,
    output: "Merged.",
  };
});

const continueCommandMock = mock(async () => ({
  sessionId: "ses_build",
  success: true,
  output: "survey: ok",
}));

mock.module("../session", () => ({
  runCommand: runCommandMock,
  continueSession: continueSessionMock,
  continueCommand: continueCommandMock,
  getRalphXdgCacheHome: () => "/tmp/ralph-opencode-cache-test",
}));

import { RepoWorker } from "../worker";

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/ralph#102",
    repo: "3mdistal/ralph",
    status: "queued",
    priority: "p2-medium",
    name: "Integration Harness Task",
    ...overrides,
  } as any;
}

describe("integration-ish harness: full task lifecycle", () => {
  beforeEach(() => {
    updateTaskStatusMock.mockClear();
    notifyEscalationMock.mockClear();
    notifyErrorMock.mockClear();
    notifyTaskCompleteMock.mockClear();
    runCommandMock.mockClear();
    continueSessionMock.mockClear();
    continueCommandMock.mockClear();
  });

  test("queued → in-progress → build → PR → merge → survey → done", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");

    // Avoid touching git worktree creation (depends on local config).
    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });

    // Avoid touching the real gh CLI.
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    let agentRunData: any = null;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask();

    const result = await worker.processTask(task);

    expect(result.outcome).toBe("success");
    expect(result.pr).toBe("https://github.com/3mdistal/ralph/pull/999");

    // Next-task + build + merge + survey happened.
    expect(runCommandMock).toHaveBeenCalled();
    expect(continueSessionMock).toHaveBeenCalled();
    expect(continueCommandMock).toHaveBeenCalled();

    // Task status transitions are explicit and deterministic.
    const statuses = updateTaskStatusMock.mock.calls.map((call: any[]) => call[1]);
    expect(statuses).toContain("in-progress");
    expect(statuses[statuses.length - 1]).toBe("done");

    // Agent-run captures PR + survey output.
    expect(agentRunData?.outcome).toBe("success");
    expect(agentRunData?.pr).toBe("https://github.com/3mdistal/ralph/pull/999");
    expect(String(agentRunData?.surveyResults ?? "")).toContain("survey: ok");

    // Completion notification is sent (stubbed).
    expect(notifyTaskCompleteMock).toHaveBeenCalled();

    // No escalation/error notification in the happy path.
    expect(notifyEscalationMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  test("missing opencode/PATH mismatch fails without crashing", async () => {
    runCommandMock.mockImplementationOnce(async () => ({
      sessionId: "ses_plan",
      success: false,
      output: "spawn opencode ENOENT (is opencode installed and on PATH?)",
    }));

    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(notifyEscalationMock).not.toHaveBeenCalled();
  });
});
