import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";

// --- Mocks used by adapters ---

const updateTaskStatusMock = mock(async () => true);

const notifyEscalationMock = mock(async () => true);
const notifyErrorMock = mock(async () => {});
const notifyTaskCompleteMock = mock(async () => {});

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

const sessionAdapter = {
  runCommand: runCommandMock,
  continueSession: continueSessionMock,
  continueCommand: continueCommandMock,
  getRalphXdgCacheHome: () => "/tmp/ralph-opencode-cache-test",
};

const queueAdapter = {
  updateTaskStatus: updateTaskStatusMock,
};

const notifyAdapter = {
  notifyEscalation: notifyEscalationMock,
  notifyError: notifyErrorMock,
  notifyTaskComplete: notifyTaskCompleteMock,
};

const getThrottleDecisionMock = mock(async () =>
  ({
    state: "ok",
    resumeAtTs: null,
    snapshot: {
      computedAt: new Date(0).toISOString(),
      providerID: "openai",
      state: "ok",
      resumeAt: null,
      windows: [],
    },
  }) as any
);

const throttleAdapter = {
  getThrottleDecision: getThrottleDecisionMock,
};

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

afterAll(() => {
  mock.restore();
});

describe("integration-ish harness: full task lifecycle", () => {
  beforeEach(() => {
    updateTaskStatusMock.mockClear();
    notifyEscalationMock.mockClear();
    notifyErrorMock.mockClear();
    notifyTaskCompleteMock.mockClear();
    runCommandMock.mockClear();
    continueSessionMock.mockClear();
    continueCommandMock.mockClear();
    getThrottleDecisionMock.mockClear();
    getThrottleDecisionMock.mockImplementation(async () =>
      ({
        state: "ok",
        resumeAtTs: null,
        snapshot: {
          computedAt: new Date(0).toISOString(),
          providerID: "openai",
          state: "ok",
          resumeAt: null,
          windows: [],
        },
      }) as any
    );
  });

  test("queued → in-progress → build → PR → merge → survey → done", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    // Avoid touching git worktree creation (depends on local config).
    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });

    // Avoid real side-effects (nudges/git/gh).
    (worker as any).drainNudges = async () => {};

    // Avoid touching the real gh CLI.
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";

    const waitForRequiredChecksMock = mock()
      .mockImplementationOnce(async () => ({
        headSha: "deadbeef",
        mergeStateStatus: "CLEAN",
        baseRefName: "main",
        summary: {
          status: "success",
          required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
          available: ["ci"],
        },
        checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        timedOut: false,
      }))
      .mockImplementationOnce(async () => ({
        headSha: "beadfeed",
        mergeStateStatus: "CLEAN",
        baseRefName: "main",
        summary: {
          status: "success",
          required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
          available: ["ci"],
        },
        checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        timedOut: false,
      }));


    const mergePullRequestMock = mock(async () => {});
    const isPrBehindMock = mock(async () => false);

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).isPrBehind = isPrBehindMock;

    let agentRunData: any = null;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask();

    const result = await worker.processTask(task);

    expect(result.outcome).toBe("success");
    expect(result.pr).toBe("https://github.com/3mdistal/ralph/pull/999");

    // Next-task + build + CI-gated merge + survey happened.
    expect(runCommandMock).toHaveBeenCalled();
    expect(continueSessionMock).toHaveBeenCalledTimes(1);
    expect(mergePullRequestMock).toHaveBeenCalled();
    expect(continueCommandMock).toHaveBeenCalled();

    // Task status transitions are explicit and deterministic.
    const statuses = updateTaskStatusMock.mock.calls.map((call: any[]) => call[1]);
    expect(statuses).toContain("in-progress");
    expect(statuses[statuses.length - 1]).toBe("done");

    // Per-run log path is persisted for restart survivability.
    const calls = updateTaskStatusMock.mock.calls as any[];
    const runLogUpdates = calls.filter((call) => {
      const extra = call?.[2] as Record<string, unknown> | undefined;
      return typeof extra?.["run-log-path"] === "string" && extra["run-log-path"].length > 0;
    });
    expect(runLogUpdates.length).toBeGreaterThan(0);

    // Pre-session log updates should stay in starting; only in-progress once session exists.
    const firstSessionIndex = calls.findIndex((call) => {
      const extra = call?.[2] as Record<string, unknown> | undefined;
      const sessionId = typeof extra?.["session-id"] === "string" ? extra["session-id"].trim() : "";
      return sessionId.length > 0;
    });

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i] as any[];
      const status = call?.[1] as string | undefined;
      const extra = call?.[2] as Record<string, unknown> | undefined;
      const runLogPath = typeof extra?.["run-log-path"] === "string" ? extra["run-log-path"] : "";
      if (!runLogPath) continue;

      if (firstSessionIndex === -1 || i < firstSessionIndex) {
        expect(status).toBe("starting");
      } else {
        expect(status).toBe("in-progress");
      }
    }

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

  test("ci-only PR blocks non-CI issue", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => [".github/workflows/ci.yml"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";

    const waitForRequiredChecksMock = mock(async () => ({
      headSha: "deadbeef",
      mergeStateStatus: "CLEAN",
      baseRefName: "main",
      summary: {
        status: "success",
        required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        available: ["ci"],
      },
      checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
      timedOut: false,
    }));

    const mergePullRequestMock = mock(async () => {});
    const isPrBehindMock = mock(async () => false);

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).isPrBehind = isPrBehindMock;

    let agentRunData: any = null;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(updateTaskStatusMock.mock.calls.map((call: any[]) => call[1])).toContain("blocked");
    expect(waitForRequiredChecksMock).not.toHaveBeenCalled();
    expect(mergePullRequestMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(agentRunData?.bodyPrefix).toContain("Blocked: CI-only PR for non-CI issue");
  });

  test("merge retries after updating out-of-date branch", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";

    const waitForRequiredChecksMock = mock()
      .mockImplementationOnce(async () => ({
        headSha: "deadbeef",
        mergeStateStatus: "CLEAN",
        baseRefName: "main",
        summary: {
          status: "success",
          required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
          available: ["ci"],
        },
        checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        timedOut: false,
      }))
      .mockImplementationOnce(async () => ({
        headSha: "beadfeed",
        mergeStateStatus: "CLEAN",
        baseRefName: "main",
        summary: {
          status: "success",
          required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
          available: ["ci"],
        },
        checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        timedOut: false,
      }));

    const mergePullRequestMock = mock()
      .mockImplementationOnce(async () => {
        const err: any = new Error("GraphQL: Head branch is not up to date with the base branch");
        err.stderr = "GraphQL: Head branch is not up to date with the base branch";
        throw err;
      })
      .mockImplementationOnce(async () => {});

    const updatePullRequestBranchMock = mock(async () => {});
    const isPrBehindMock = mock(async () => false);

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).updatePullRequestBranch = updatePullRequestBranchMock;
    (worker as any).isPrBehind = isPrBehindMock;

    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(updatePullRequestBranchMock).toHaveBeenCalledTimes(1);
    expect(waitForRequiredChecksMock).toHaveBeenCalledTimes(2);
    expect(mergePullRequestMock).toHaveBeenCalledTimes(2);
    expect(mergePullRequestMock.mock.calls[0][1]).toBe("deadbeef");
    expect(mergePullRequestMock.mock.calls[1][1]).toBe("beadfeed");
  });

  test("merge escalates when update-branch fails", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";

    const waitForRequiredChecksMock = mock(async () => ({
      headSha: "deadbeef",
      mergeStateStatus: "CLEAN",
      baseRefName: "main",
      summary: {
        status: "success",
        required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        available: ["ci"],
      },
      checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
      timedOut: false,
    }));

    const mergePullRequestMock = mock(async () => {
      const err: any = new Error("GraphQL: Head branch is not up to date with the base branch");
      err.stderr = "GraphQL: Head branch is not up to date with the base branch";
      throw err;
    });

    const updatePullRequestBranchMock = mock(async () => {
      throw new Error("GraphQL: branch protection rule prevents update");
    });
    const isPrBehindMock = mock(async () => false);
    const getPullRequestChecksMock = mock(async () => ({
      headSha: "deadbeef",
      mergeStateStatus: "CLEAN",
      baseRefName: "main",
      checks: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
    }));

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).updatePullRequestBranch = updatePullRequestBranchMock;
    (worker as any).isPrBehind = isPrBehindMock;
    (worker as any).getPullRequestChecks = getPullRequestChecksMock;

    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(updateTaskStatusMock.mock.calls.map((call: any[]) => call[1])).toContain("blocked");
  });

  test("blocks main merge without override label", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "main";
    (worker as any).createAgentRun = async () => {};

    const waitForRequiredChecksMock = mock(async () => ({
      headSha: "deadbeef",
      summary: {
        status: "success",
        required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        available: ["ci"],
      },
      timedOut: false,
    }));

    const mergePullRequestMock = mock(async () => {});

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(updateTaskStatusMock.mock.calls.map((call: any[]) => call[1])).toContain("blocked");
    expect(waitForRequiredChecksMock).not.toHaveBeenCalled();
    expect(mergePullRequestMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalled();
  });

  test("allows main merge with override label", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: ["allow-main"],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "main";
    (worker as any).createAgentRun = async () => {};

    const waitForRequiredChecksMock = mock(async () => ({
      headSha: "deadbeef",
      summary: {
        status: "success",
        required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        available: ["ci"],
      },
      timedOut: false,
    }));

    const mergePullRequestMock = mock(async () => {});

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(waitForRequiredChecksMock).toHaveBeenCalled();
    expect(mergePullRequestMock).toHaveBeenCalled();
  });

  test("hard throttle pauses before any model send", async () => {
    const resumeAtTs = Date.now() + 60_000;

    getThrottleDecisionMock.mockImplementation(async () => ({
      state: "hard",
      resumeAtTs,
      snapshot: {
        computedAt: new Date().toISOString(),
        providerID: "openai",
        state: "hard",
        resumeAt: new Date(resumeAtTs).toISOString(),
        windows: [],
      },
    }));

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });
    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";
    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("throttled");
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(continueSessionMock).not.toHaveBeenCalled();

    const statuses = updateTaskStatusMock.mock.calls.map((call: any[]) => call[1]);
    expect(statuses).toContain("throttled");
  });

  test("missing opencode/PATH mismatch fails without crashing", async () => {
    runCommandMock.mockImplementationOnce(async () => ({
      sessionId: "ses_plan",
      success: false,
      output: "spawn opencode ENOENT (is opencode installed and on PATH?)",
    }));

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });
    (worker as any).resolveTaskRepoPath = async () => ({ repoPath: "/tmp", worktreePath: undefined });
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureBaselineLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";
    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(notifyEscalationMock).not.toHaveBeenCalled();
  });
});
