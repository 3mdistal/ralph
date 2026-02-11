import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { RepoWorker } from "../worker";
import { getIdempotencyRecord, initStateDb, recordIdempotencyKey } from "../state";

const baseTask = {
  _path: "github:3mdistal/ralph#1",
  _name: "test-task",
  type: "agent-task",
  "creation-date": "2026-01-10",
  scope: "builder",
  issue: "3mdistal/ralph#1",
  repo: "3mdistal/ralph",
  status: "queued",
  name: "Existing PR Task",
} as any;

describe("existing PR recovery", () => {
  test("routes merge-conflict recovery when PR is DIRTY", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = { ...baseTask };

    let recoveryCalled = false;
    (worker as any).getIssuePrResolution = async () => ({
      selectedUrl: "https://github.com/3mdistal/ralph/pull/123",
      duplicates: [],
      source: "db",
      diagnostics: [],
    });
    (worker as any).getPullRequestMergeState = async () => ({
      number: 123,
      url: "https://github.com/3mdistal/ralph/pull/123",
      mergeStateStatus: "DIRTY",
      isCrossRepository: false,
      headRefName: "branch",
      headRepoFullName: "3mdistal/ralph",
      baseRefName: "bot/integration",
      labels: [],
    });
    (worker as any).runMergeConflictRecovery = async () => {
      recoveryCalled = true;
      return { status: "success", prUrl: "https://github.com/3mdistal/ralph/pull/123", sessionId: "ses_1", headSha: "sha" };
    };
    (worker as any).mergePrWithRequiredChecks = async () => ({
      ok: true,
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      sessionId: "ses_1",
    });
    (worker as any).pauseIfHardThrottled = async () => null;
    (worker as any).recordRunLogPath = async () => "/tmp/log";
    (worker as any).session.continueCommand = async () => ({ success: true, output: "survey", sessionId: "ses_1" });

    const result = await (worker as any).maybeHandleQueuedMergeConflict({
      task,
      issueNumber: "1",
      taskRepoPath: "/tmp",
      cacheKey: "1",
      botBranch: "bot/integration",
      issueMeta: { labels: [], title: task.name },
      startTime: new Date(),
      opencodeSessionOptions: {},
    });

    expect(recoveryCalled).toBe(true);
    expect(result?.outcome).toBe("success");
  });

  test("routes CI failure recovery when required checks fail", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = { ...baseTask, "session-id": "ses_123" };

    let observedStage: "merge-conflict" | "ci-triage" | null = null;
    (worker as any).getIssuePrResolution = async () => ({
      selectedUrl: "https://github.com/3mdistal/ralph/pull/456",
      duplicates: [],
      source: "db",
      diagnostics: [],
    });
    (worker as any).resolveRequiredChecksForMerge = async () => ({
      checks: ["Test"],
      source: "config",
    });
    (worker as any).getPullRequestChecks = async () => ({
      headSha: "sha",
      mergeStateStatus: "CLEAN",
      baseRefName: "bot/integration",
      checks: [
        {
          name: "Test",
          state: "FAILURE",
          rawState: "FAILURE",
          detailsUrl: null,
        },
      ],
    });
    (worker as any).runCiFailureTriage = async () => {
      observedStage = "ci-triage";
      return { status: "failed", run: { taskName: task.name, repo: task.repo, outcome: "failed" } };
    };

    const result = await (worker as any).maybeHandleQueuedCiFailure({
      task,
      issueNumber: "1",
      taskRepoPath: "/tmp",
      cacheKey: "1",
      botBranch: "bot/integration",
      issueMeta: { labels: [], title: task.name },
      startTime: new Date(),
      opencodeSessionOptions: {},
    });

    if (!observedStage) {
      throw new Error("Expected ci-failure recovery stage to be set.");
    }
    expect(observedStage as unknown as string).toBe("ci-triage");
    expect(result?.outcome).toBe("failed");
  });

  test("skips CI failure recovery when issue is escalated", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = { ...baseTask };

    let ciTriageCalled = false;
    (worker as any).runCiFailureTriage = async () => {
      ciTriageCalled = true;
      return { status: "failed", run: { taskName: task.name, repo: task.repo, outcome: "failed" } };
    };

    const result = await (worker as any).maybeHandleQueuedCiFailure({
      task,
      issueNumber: "1",
      taskRepoPath: "/tmp",
      cacheKey: "1",
      botBranch: "bot/integration",
      issueMeta: { labels: ["ralph:status:escalated"], title: task.name },
      startTime: new Date(),
      opencodeSessionOptions: {},
    });

    expect(ciTriageCalled).toBe(false);
    expect(result).toBe(null);
  });

  test("refreshes issue-level PR resolution during PR-create lease conflicts", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");

    const freshFlags: boolean[] = [];
    (worker as any).getIssuePrResolution = async (_issueNumber: string, opts?: { fresh?: boolean }) => {
      freshFlags.push(Boolean(opts?.fresh));
      if (freshFlags.length === 1) {
        return { selectedUrl: null, duplicates: [], source: null, diagnostics: [] };
      }
      return {
        selectedUrl: "https://github.com/3mdistal/ralph/pull/624",
        duplicates: [],
        source: "db",
        diagnostics: [],
      };
    };
    (worker as any).sleepMs = async () => {};

    const resolved = await (worker as any).waitForExistingPrDuringPrCreateConflict({
      issueNumber: "598",
      maxWaitMs: 500,
    });

    expect(resolved?.selectedUrl).toBe("https://github.com/3mdistal/ralph/pull/624");
    expect(freshFlags).toEqual([true, true]);
  });

  test("reclaims stale lease after bounded conflict wait when no PR appears", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ralph-pr-lease-reclaim-"));
    const priorDb = process.env.RALPH_STATE_DB_PATH;
    try {
      process.env.RALPH_STATE_DB_PATH = join(tempRoot, "state.sqlite");
      initStateDb();

      const worker = new RepoWorker("3mdistal/ralph", "/tmp");
      const leaseKey = (worker as any).buildPrCreateLeaseKey("707", "bot/integration");
      const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const payloadJson = JSON.stringify({ holder: "worker-a" });
      recordIdempotencyKey({ key: leaseKey, scope: "pr-create", createdAt, payloadJson });

      (worker as any).getIssuePrResolution = async () => ({
        selectedUrl: null,
        duplicates: [],
        source: null,
        diagnostics: [],
      });

      const reclaimed = await (worker as any).tryReclaimPrCreateLeaseAfterConflict({
        issueNumber: "707",
        leaseKey,
        observedCreatedAt: createdAt,
        observedPayloadJson: payloadJson,
      });

      expect(reclaimed.reclaimed).toBe(true);
      expect(getIdempotencyRecord(leaseKey)).toBeNull();
    } finally {
      if (priorDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorDb;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("retries transient PR-create operations within bounded policy", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const waits: number[] = [];
    (worker as any).sleepMs = async (ms: number) => {
      waits.push(ms);
    };

    let calls = 0;
    const result = await (worker as any).withPrCreateTransientRetries({
      label: "test-transient",
      operation: async () => {
        calls += 1;
        if (calls < 3) {
          const error: any = new Error("HTTP 429 secondary rate limit");
          error.stderr = "Retry-After: 1";
          throw error;
        }
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits.length).toBe(2);
    expect(waits[0]).toBe(1000);
    expect(waits[1]).toBe(1000);
  });

  test("does not retry non-retriable PR-create policy denial", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const waits: number[] = [];
    (worker as any).sleepMs = async (ms: number) => {
      waits.push(ms);
    };

    let calls = 0;
    await expect(
      (worker as any).withPrCreateTransientRetries({
        label: "test-non-retriable",
        operation: async () => {
          calls += 1;
          const error: any = new Error("Resource not accessible by integration (HTTP 403)");
          error.stderr = "HTTP 403";
          throw error;
        },
      })
    ).rejects.toThrow(/403/);

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  test("capability check blocks immediately on policy denial evidence", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = { ...baseTask, status: "in-progress", "session-id": "ses_policy" };

    let blockedCalled = 0;
    (worker as any).markTaskBlocked = async () => {
      blockedCalled += 1;
      return true;
    };

    const run = await (worker as any).blockOnPrCreateCapabilityIfMissing({
      task,
      stage: "test",
      sessionId: "ses_policy",
      evidence: ["Resource not accessible by integration (HTTP 403)"],
    });

    expect(blockedCalled).toBe(1);
    expect(run?.outcome).toBe("failed");
  });
});
