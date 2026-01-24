import { describe, expect, test } from "bun:test";
import { RepoWorker } from "../worker";

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

    let observedStage: "merge-conflict" | "ci-failure" | null = null;
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
    (worker as any).runExistingPrRecovery = async (params: any) => {
      observedStage = params.stage;
      return { taskName: task.name, repo: task.repo, outcome: "success" };
    };

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

    if (!observedStage) {
      throw new Error("Expected merge-conflict recovery stage to be set.");
    }
    expect(observedStage).toBe("merge-conflict");
    expect(result?.outcome).toBe("success");
  });

  test("routes CI failure recovery when required checks fail", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = { ...baseTask, "session-id": "ses_123" };

    let observedStage: "merge-conflict" | "ci-failure" | null = null;
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
    (worker as any).runExistingPrRecovery = async (params: any) => {
      observedStage = params.stage;
      return { taskName: task.name, repo: task.repo, outcome: "success" };
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
    expect(observedStage).toBe("ci-failure");
    expect(result?.outcome).toBe("success");
  });
});
