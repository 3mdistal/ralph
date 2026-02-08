import { describe, expect, test } from "bun:test";

import { mergePrWithRequiredChecks } from "../worker/merge/merge-runner";

function buildSuccessSummary() {
  return {
    status: "success" as const,
    required: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
    available: ["Test"],
  };
}

function buildParams(overrides: Record<string, unknown> = {}) {
  const markTaskBlockedCalls: Array<{ source: string; reason: string; details?: string }> = [];
  const mergeCalls: string[] = [];
  const updateCalls: string[] = [];

  const task = {
    issue: "3mdistal/ralph#611",
    repo: "3mdistal/ralph",
    name: "Issue 611",
    status: "queued",
  } as any;

  const defaults: Record<string, unknown> = {
    repo: "3mdistal/ralph",
    task,
    repoPath: "/tmp/ralph",
    cacheKey: "611",
    botBranch: "bot/integration",
    prUrl: "https://github.com/3mdistal/ralph/pull/611",
    sessionId: "ses_611",
    issueMeta: { labels: [], title: "Issue 611" },
    watchdogStagePrefix: "watchdog",
    notifyTitle: "notify",
    resolveRequiredChecksForMerge: async () => ({ checks: ["Test"] }),
    recordCheckpoint: async () => {},
    getPullRequestFiles: async () => ["src/index.ts"],
    getPullRequestBaseBranch: async () => "bot/integration",
    isMainMergeAllowed: () => true,
    createAgentRun: async () => ({}),
    markTaskBlocked: async (_task: unknown, source: string, opts: { reason: string; details?: string }) => {
      markTaskBlockedCalls.push({ source, reason: opts.reason, details: opts.details });
      return {};
    },
    getPullRequestChecks: async () => ({
      headSha: "sha-initial",
      mergeStateStatus: "CLEAN",
      baseRefName: "bot/integration",
      checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
    }),
    recordCiGateSummary: () => {},
    buildIssueContextForAgent: async () => "",
    runReviewAgent: async () => ({ success: true, output: "ok", sessionId: "ses_611" }),
    runMergeConflictRecovery: async () => ({ status: "failed", run: { taskName: "x", repo: "x", outcome: "failed" } }),
    updatePullRequestBranch: async (pr: string) => {
      updateCalls.push(pr);
    },
    formatGhError: (error: any) => String(error?.message ?? error),
    mergePullRequest: async (_pr: string, sha: string) => {
      mergeCalls.push(sha);
    },
    recordPrSnapshotBestEffort: () => {},
    applyMidpointLabelsBestEffort: async () => {},
    deleteMergedPrHeadBranchBestEffort: async () => {},
    normalizeGitRef: (ref: string) => ref,
    isOutOfDateMergeError: () => false,
    isBaseBranchModifiedMergeError: () => false,
    isRequiredChecksExpectedMergeError: () => false,
    waitForRequiredChecks: async () => ({
      headSha: "sha-initial",
      mergeStateStatus: "CLEAN",
      baseRefName: "bot/integration",
      summary: buildSuccessSummary(),
      checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
      timedOut: false,
    }),
    runCiFailureTriage: async () => ({ status: "failed", run: { taskName: "x", repo: "x", outcome: "failed" } }),
    recordMergeFailureArtifact: () => {},
    pauseIfHardThrottled: async () => null,
    shouldAttemptProactiveUpdate: () => ({ ok: false }),
    shouldRateLimitAutoUpdate: () => false,
    recordAutoUpdateAttempt: () => {},
    recordAutoUpdateFailure: () => {},
    getPullRequestMergeState: async () => ({ mergeStateStatus: "CLEAN", labels: [] }),
    recurse: async () => ({ ok: true as const, prUrl: "https://github.com/3mdistal/ralph/pull/611", sessionId: "ses_611" }),
    log: () => {},
    warn: () => {},
  };

  return {
    params: { ...defaults, ...overrides } as any,
    markTaskBlockedCalls,
    mergeCalls,
    updateCalls,
  };
}

describe("mergePrWithRequiredChecks 405 handling", () => {
  test("retries by updating branch when merge API reports base branch modified", async () => {
    let mergeAttempt = 0;
    let waitCall = 0;
    let statusCall = 0;

    const { params, mergeCalls, updateCalls, markTaskBlockedCalls } = buildParams({
      isBaseBranchModifiedMergeError: () => true,
      mergePullRequest: async (_pr: string, sha: string) => {
        mergeCalls.push(sha);
        mergeAttempt += 1;
        if (mergeAttempt === 1) {
          throw new Error("HTTP 405: Base branch was modified. Review and try the merge again.");
        }
      },
      waitForRequiredChecks: async () => {
        waitCall += 1;
        return {
          headSha: waitCall === 1 ? "sha-initial" : "sha-after-update",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          summary: buildSuccessSummary(),
          checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
          timedOut: false,
        };
      },
      getPullRequestChecks: async () => {
        statusCall += 1;
        return {
          headSha: statusCall === 1 ? "sha-initial" : "sha-after-update",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
        };
      },
    });

    const result = await mergePrWithRequiredChecks(params);

    expect(result.ok).toBe(true);
    expect(updateCalls).toHaveLength(1);
    expect(mergeCalls).toEqual(["sha-initial", "sha-after-update"]);
    expect(markTaskBlockedCalls).toHaveLength(0);
  });

  test("falls back to auto-update blocked reason instead of ci-failure after repeated 405", async () => {
    let waitCall = 0;
    let statusCall = 0;

    const { params, markTaskBlockedCalls } = buildParams({
      isBaseBranchModifiedMergeError: () => true,
      mergePullRequest: async () => {
        throw new Error("HTTP 405: Base branch was modified. Review and try the merge again.");
      },
      waitForRequiredChecks: async () => {
        waitCall += 1;
        return {
          headSha: waitCall === 1 ? "sha-initial" : "sha-after-update",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          summary: buildSuccessSummary(),
          checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
          timedOut: false,
        };
      },
      getPullRequestChecks: async () => {
        statusCall += 1;
        return {
          headSha: statusCall === 1 ? "sha-initial" : statusCall === 2 ? "sha-after-update" : "sha-after-update",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
        };
      },
    });

    const result = await mergePrWithRequiredChecks(params);

    expect(result.ok).toBe(false);
    expect(markTaskBlockedCalls).toHaveLength(1);
    expect(markTaskBlockedCalls[0]?.source).toBe("auto-update");
    expect(markTaskBlockedCalls[0]?.reason).toContain("base branch changed");
    expect(markTaskBlockedCalls[0]?.reason).not.toContain("required checks not green");
  });
});

describe("mergePrWithRequiredChecks pre-merge CI remediation", () => {
  test("enters CI triage when required checks fail at merge time", async () => {
    let statusCall = 0;
    let triageCalls = 0;

    const { params, mergeCalls, markTaskBlockedCalls } = buildParams({
      getPullRequestChecks: async () => {
        statusCall += 1;
        if (statusCall === 1) {
          return {
            headSha: "sha-initial",
            mergeStateStatus: "CLEAN",
            baseRefName: "bot/integration",
            checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
          };
        }
        return {
          headSha: "sha-after-ci",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
        };
      },
      runCiFailureTriage: async () => {
        triageCalls += 1;
        return { status: "success", headSha: "sha-after-ci", sessionId: "ses_ci" };
      },
    });

    const result = await mergePrWithRequiredChecks(params);

    expect(result.ok).toBe(true);
    expect(triageCalls).toBe(1);
    expect(mergeCalls).toEqual(["sha-after-ci"]);
    expect(markTaskBlockedCalls).toHaveLength(0);
  });

  test("propagates CI triage failure instead of blocking immediately", async () => {
    let triageCalls = 0;

    const { params, mergeCalls, markTaskBlockedCalls } = buildParams({
      getPullRequestChecks: async () => ({
        headSha: "sha-initial",
        mergeStateStatus: "CLEAN",
        baseRefName: "bot/integration",
        checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
      }),
      runCiFailureTriage: async () => {
        triageCalls += 1;
        return { status: "failed", run: { taskName: "x", repo: "x", outcome: "failed" } };
      },
    });

    const result = await mergePrWithRequiredChecks(params);

    expect(result.ok).toBe(false);
    expect(triageCalls).toBe(1);
    expect(mergeCalls).toHaveLength(0);
    expect(markTaskBlockedCalls).toHaveLength(0);
  });
});
