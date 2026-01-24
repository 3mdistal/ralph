import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { RepoWorker } from "../worker";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let autoUpdateEnabled = false;
let autoUpdateLabelGate: string | null = null;
let autoUpdateMinMinutes = 30;
let botBranchOverride: string | null = null;

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

async function writeTestConfig(): Promise<void> {
  await writeJson(getRalphConfigJsonPath(), {
    repos: [
      {
        name: "3mdistal/ralph",
        requiredChecks: ["ci"],
        autoUpdateBehindPrs: autoUpdateEnabled,
        autoUpdateBehindMinMinutes: autoUpdateMinMinutes,
        autoUpdateBehindLabel: autoUpdateLabelGate,
        botBranch: botBranchOverride ?? "bot/integration",
      },
    ],
    maxWorkers: 1,
    batchSize: 10,
    pollInterval: 30_000,
    bwrbVault: "/tmp",
    owner: "3mdistal",
    allowedOwners: ["3mdistal"],
    devDir: "/tmp",
  });
  __resetConfigForTests();
}

// --- Mocks used by adapters ---

const updateTaskStatusMock = mock(async () => true);

const notifyEscalationMock = mock(async () => true);
const notifyErrorMock = mock(async () => {});
const notifyTaskCompleteMock = mock(async () => {});

const runAgentMock = mock(async () => ({
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
  runAgent: runAgentMock,
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
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    __resetConfigForTests();

    updateTaskStatusMock.mockClear();
    notifyEscalationMock.mockClear();
    notifyErrorMock.mockClear();
    notifyTaskCompleteMock.mockClear();
    runAgentMock.mockClear();
    continueSessionMock.mockClear();
    continueCommandMock.mockClear();
    getThrottleDecisionMock.mockClear();
    autoUpdateEnabled = false;
    autoUpdateLabelGate = null;
    autoUpdateMinMinutes = 30;
    botBranchOverride = null;
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

    await writeTestConfig();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("queued → in-progress → build → PR → merge → survey → done", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    // Avoid touching git worktree creation (depends on local config).
    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};

    // Avoid real side-effects (nudges/git/gh).
    (worker as any).drainNudges = async () => {};

    // Avoid touching the real gh CLI.
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "CLEAN",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: [],
    }));
    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";

    const addIssueLabelMock = mock(async () => {});
    const removeIssueLabelMock = mock(async () => {});
    (worker as any).addIssueLabel = addIssueLabelMock;
    (worker as any).removeIssueLabel = removeIssueLabelMock;

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
    const deleteMergedPrHeadBranchMock = mock(async () => {});

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).isPrBehind = isPrBehindMock;
    (worker as any).deleteMergedPrHeadBranchBestEffort = deleteMergedPrHeadBranchMock;

    let agentRunData: any = null;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask();

    const result = await worker.processTask(task);

    expect(result.outcome).toBe("success");
    expect(result.pr).toBe("https://github.com/3mdistal/ralph/pull/999");

    // Next-task + build + CI-gated merge + survey happened.
    expect(runAgentMock).toHaveBeenCalled();
    expect(continueSessionMock).toHaveBeenCalledTimes(1);
    expect(mergePullRequestMock).toHaveBeenCalled();
    expect(deleteMergedPrHeadBranchMock).toHaveBeenCalled();
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

    expect(addIssueLabelMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "3mdistal/ralph", number: 102 }),
      "ralph:in-bot"
    );
    expect(removeIssueLabelMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "3mdistal/ralph", number: 102 }),
      "ralph:in-progress"
    );
  });

  test("merge to main with allow-main does not apply in-bot labels", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: ["allow-main"],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "CLEAN",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "main",
      labels: [],
    }));
    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;
    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "main";

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
    const deleteMergedPrHeadBranchMock = mock(async () => {});

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).isPrBehind = isPrBehindMock;
    (worker as any).deleteMergedPrHeadBranchBestEffort = deleteMergedPrHeadBranchMock;

    const addIssueLabelMock = mock(async () => {});
    const removeIssueLabelMock = mock(async () => {});
    (worker as any).addIssueLabel = addIssueLabelMock;
    (worker as any).removeIssueLabel = removeIssueLabelMock;

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(mergePullRequestMock).toHaveBeenCalled();
    expect(deleteMergedPrHeadBranchMock).not.toHaveBeenCalled();
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(removeIssueLabelMock).toHaveBeenCalled();
  });

  test("botBranch main skips midpoint labels", async () => {
    botBranchOverride = "main";
    await writeTestConfig();

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "CLEAN",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "main",
      labels: [],
    }));
    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;
    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];
    (worker as any).getPullRequestBaseBranch = async () => "main";

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

    const addIssueLabelMock = mock(async () => {});
    const removeIssueLabelMock = mock(async () => {});
    (worker as any).addIssueLabel = addIssueLabelMock;
    (worker as any).removeIssueLabel = removeIssueLabelMock;

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(mergePullRequestMock).toHaveBeenCalled();
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(removeIssueLabelMock).toHaveBeenCalled();
  });

  test("midpoint label failures do not block merge", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "CLEAN",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: [],
    }));
    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;
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

    const mergePullRequestMock = mock(async () => {});
    const isPrBehindMock = mock(async () => false);

    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).isPrBehind = isPrBehindMock;

    const addIssueLabelMock = mock(async () => {
      throw new Error("label add failed");
    });
    const removeIssueLabelMock = mock(async () => {
      throw new Error("label remove failed");
    });
    (worker as any).addIssueLabel = addIssueLabelMock;
    (worker as any).removeIssueLabel = removeIssueLabelMock;

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(mergePullRequestMock).toHaveBeenCalled();
    expect(addIssueLabelMock).toHaveBeenCalled();
    expect(removeIssueLabelMock).toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalled();
  });

  test("ci-only PR blocks non-CI issue", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};

    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });
    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "CLEAN",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: [],
    }));
    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;

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

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};

    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
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

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};

    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
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

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(notifyEscalationMock).not.toHaveBeenCalled();
  });

  test("blocks main merge without override label", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: undefined });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};


    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
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

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(waitForRequiredChecksMock).toHaveBeenCalled();
    expect(mergePullRequestMock).toHaveBeenCalled();
  });

  test("auto-update updates behind branch before merge", async () => {
    autoUpdateEnabled = true;
    await writeTestConfig();

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: undefined });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];

    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "BEHIND",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: ["ready"],
    }));
    const updatePullRequestBranchMock = mock(async () => {});
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

    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;
    (worker as any).updatePullRequestBranch = updatePullRequestBranchMock;
    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(getPullRequestMergeStateMock).toHaveBeenCalledTimes(1);
    expect(updatePullRequestBranchMock).toHaveBeenCalledTimes(1);
    expect(waitForRequiredChecksMock).toHaveBeenCalledTimes(1);
    expect(mergePullRequestMock).toHaveBeenCalledTimes(1);
  });

  test("auto-update respects label gate", async () => {
    autoUpdateEnabled = true;
    autoUpdateLabelGate = "autoupdate";
    await writeTestConfig();

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: undefined });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];

    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "BEHIND",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: [],
    }));
    const updatePullRequestBranchMock = mock(async () => {});
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

    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;
    (worker as any).updatePullRequestBranch = updatePullRequestBranchMock;
    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).mergePullRequest = mergePullRequestMock;
    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("success");
    expect(getPullRequestMergeStateMock).toHaveBeenCalledTimes(1);
    expect(updatePullRequestBranchMock).not.toHaveBeenCalled();
    expect(waitForRequiredChecksMock).toHaveBeenCalledTimes(1);
    expect(mergePullRequestMock).toHaveBeenCalledTimes(1);
  });

  test("auto-update escalates on conflicts", async () => {
    autoUpdateEnabled = true;
    await writeTestConfig();

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });

    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: undefined });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
    (worker as any).ensureBranchProtectionOnce = async () => {};
    (worker as any).getPullRequestBaseBranch = async () => "bot/integration";
    (worker as any).getIssueMetadata = async () => ({
      labels: [],
      title: "Test issue",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/102",
      closedAt: null,
      stateReason: null,
    });

    (worker as any).getPullRequestFiles = async () => ["src/index.ts"];

    const getPullRequestMergeStateMock = mock(async () => ({
      number: 999,
      url: "https://github.com/3mdistal/ralph/pull/999",
      mergeStateStatus: "DIRTY",
      isCrossRepository: false,
      headRefName: "feature-branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: [],
    }));
    const waitForRequiredChecksMock = mock(async () => ({
      headSha: "deadbeef",
      summary: {
        status: "success",
        required: [{ name: "ci", state: "SUCCESS", rawState: "SUCCESS" }],
        available: ["ci"],
      },
      timedOut: false,
    }));

    (worker as any).getPullRequestMergeState = getPullRequestMergeStateMock;
    (worker as any).waitForRequiredChecks = waitForRequiredChecksMock;
    (worker as any).createAgentRun = async () => {};

    const result = await worker.processTask(createMockTask());

    expect(result.outcome).toBe("failed");
    expect(getPullRequestMergeStateMock).toHaveBeenCalledTimes(1);
    expect(waitForRequiredChecksMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(updateTaskStatusMock.mock.calls.map((call: any[]) => call[1])).toContain("blocked");
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
    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
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
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(continueSessionMock).not.toHaveBeenCalled();

    const statuses = updateTaskStatusMock.mock.calls.map((call: any[]) => call[1]);
    expect(statuses).toContain("throttled");
  });

  test("missing opencode/PATH mismatch fails without crashing", async () => {
    runAgentMock.mockImplementationOnce(async () => ({
      sessionId: "ses_plan",
      success: false,
      output: "spawn opencode ENOENT (is opencode installed and on PATH?)",
    }));

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { session: sessionAdapter, queue: queueAdapter, notify: notifyAdapter, throttle: throttleAdapter });
    (worker as any).resolveTaskRepoPath = async () => ({ kind: "ok", repoPath: "/tmp", worktreePath: "/tmp" });
    (worker as any).assertRepoRootClean = async () => {};
    (worker as any).drainNudges = async () => {};
    (worker as any).ensureRalphWorkflowLabelsOnce = async () => {};
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
