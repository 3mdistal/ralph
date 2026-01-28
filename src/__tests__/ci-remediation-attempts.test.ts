import { describe, expect, test } from "bun:test";
import { RepoWorker } from "../worker";

function buildGithubCommentStub(params: { owner: string; repo: string; issueNumber: number }) {
  let commentBody: string | null = null;

  return {
    getCommentBody: () => commentBody,
    github: {
      request: async (path: string, opts?: any) => {
        const method = String(opts?.method ?? "GET").toUpperCase();
        const issueCommentsPrefix = `/repos/${params.owner}/${params.repo}/issues/${params.issueNumber}/comments`;
        const commentIdPrefix = `/repos/${params.owner}/${params.repo}/issues/comments/`;

        if (method === "GET" && path.startsWith(`${issueCommentsPrefix}?`)) {
          if (!commentBody) return { data: [] };
          return {
            data: [{ id: 1, body: commentBody, updated_at: "2000-01-01T00:00:00Z" }],
          };
        }

        if (method === "POST" && path === issueCommentsPrefix) {
          commentBody = String(opts?.body?.body ?? "");
          return { data: { id: 1 } };
        }

        if (method === "PATCH" && path.startsWith(commentIdPrefix)) {
          commentBody = String(opts?.body?.body ?? "");
          return { data: { id: 1 } };
        }

        return { data: [] };
      },
    },
  };
}

describe("CI remediation attempts", () => {
  test("CI-debug prompt uses detached checkout and push-to-head", () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const prompt = (worker as any).buildCiDebugPrompt({
      prUrl: "https://github.com/3mdistal/ralph/pull/1",
      baseRefName: "bot/integration",
      headRefName: "feat/test-branch",
      summary: { status: "failed", required: [], optional: [] },
      timedOut: false,
      remediationContext: "",
    });

    expect(prompt).toContain("gh pr checkout --detach");
    expect(prompt).toContain("git push origin HEAD:feat/test-branch");
  });

  test("defaults CI remediation attempts to 5", () => {
    const prev = process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS;
    delete process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS;
    try {
      const worker = new RepoWorker("3mdistal/ralph", "/tmp");
      expect((worker as any).resolveCiFixAttempts()).toBe(5);
    } finally {
      if (prev) process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS = prev;
      else delete process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS;
    }
  });

  test("escalates immediately when head SHA does not change", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const comment = buildGithubCommentStub({ owner: "3mdistal", repo: "ralph", issueNumber: 1 });

    const task: any = {
      _path: "github:3mdistal/ralph#1",
      _name: "test-task",
      type: "agent-task",
      "creation-date": "2026-01-10",
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      status: "queued",
      name: "CI remediation test",
    };

    (worker as any).github = comment.github;
    (worker as any).formatWorkerId = async () => "worker-1";
    (worker as any).ensureGitWorktree = async () => {};
    (worker as any).cleanupGitWorktree = async () => {};
    (worker as any).recordRunLogPath = async () => "/tmp/run.log";
    (worker as any).pauseIfHardThrottled = async () => null;
    (worker as any).buildWatchdogOptions = () => ({}) as any;
    (worker as any).applyCiDebugLabels = async () => {};
    (worker as any).clearCiDebugLabels = async () => {};
    (worker as any).buildRemediationFailureContext = async () => "";
    (worker as any).formatRemediationFailureContext = (x: any) => x;
    (worker as any).buildCiDebugPrompt = () => "";
    (worker as any).session = {
      runAgent: async () => ({ sessionId: "ses_1" }),
    };
    (worker as any).queue = { updateTaskStatus: async () => true };
    (worker as any).writeEscalationWriteback = async () => {};
    (worker as any).notify = { notifyEscalation: async () => {} };
    (worker as any).recordEscalatedRunNote = async () => {};

    let checksCall = 0;
    (worker as any).getPullRequestChecks = async () => {
      checksCall += 1;
      // Preflight + post-attempt both report the same head SHA.
      return {
        headSha: "sha_same",
        mergeStateStatus: "CLEAN",
        baseRefName: "bot/integration",
        checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
      };
    };
    (worker as any).getPullRequestMergeState = async () => ({ headRefName: "branch" });

    const result = await (worker as any).runCiDebugRecovery({
      task,
      issueNumber: "1",
      cacheKey: "1",
      prUrl: "https://github.com/3mdistal/ralph/pull/1",
      requiredChecks: ["Test"],
      issueMeta: { labels: [], title: task.name },
      botBranch: "bot/integration",
      timedOut: false,
      opencodeSessionOptions: {},
    });

    expect(checksCall).toBe(2);
    expect(result.status).toBe("escalated");
    expect(result.run.outcome).toBe("escalated");
    expect(String(result.run.escalationReason)).toContain("no progress");
  });

  test("continues when head SHA changes and stops when green", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const comment = buildGithubCommentStub({ owner: "3mdistal", repo: "ralph", issueNumber: 1 });

    const task: any = {
      _path: "github:3mdistal/ralph#1",
      _name: "test-task",
      type: "agent-task",
      "creation-date": "2026-01-10",
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      status: "queued",
      name: "CI remediation test",
    };

    (worker as any).github = comment.github;
    (worker as any).formatWorkerId = async () => "worker-1";
    (worker as any).ensureGitWorktree = async () => {};
    (worker as any).cleanupGitWorktree = async () => {};
    (worker as any).recordRunLogPath = async () => "/tmp/run.log";
    (worker as any).pauseIfHardThrottled = async () => null;
    (worker as any).buildWatchdogOptions = () => ({}) as any;
    (worker as any).applyCiDebugLabels = async () => {};
    (worker as any).clearCiDebugLabels = async () => {};
    (worker as any).buildRemediationFailureContext = async () => "";
    (worker as any).formatRemediationFailureContext = (x: any) => x;
    (worker as any).buildCiDebugPrompt = () => "";
    (worker as any).sleepMs = async () => {};
    (worker as any).session = {
      runAgent: async () => ({ sessionId: "ses_1" }),
    };
    (worker as any).queue = { updateTaskStatus: async () => true };
    (worker as any).writeEscalationWriteback = async () => {};
    (worker as any).notify = { notifyEscalation: async () => {} };
    (worker as any).recordEscalatedRunNote = async () => {};

    let checksCall = 0;
    (worker as any).getPullRequestChecks = async () => {
      checksCall += 1;

      // Two attempts => 4 calls (pre/post per attempt).
      if (checksCall === 1) {
        return {
          headSha: "sha1",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
        };
      }

      if (checksCall === 2) {
        // Attempt 1 changed head SHA but still failing.
        return {
          headSha: "sha2",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
        };
      }

      if (checksCall === 3) {
        // Preflight attempt 2.
        return {
          headSha: "sha2",
          mergeStateStatus: "CLEAN",
          baseRefName: "bot/integration",
          checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
        };
      }

      return {
        // Post attempt 2 is green.
        headSha: "sha3",
        mergeStateStatus: "CLEAN",
        baseRefName: "bot/integration",
        checks: [{ name: "Test", state: "SUCCESS", rawState: "SUCCESS", detailsUrl: null }],
      };
    };
    (worker as any).getPullRequestMergeState = async () => ({ headRefName: "branch" });

    const result = await (worker as any).runCiDebugRecovery({
      task,
      issueNumber: "1",
      cacheKey: "1",
      prUrl: "https://github.com/3mdistal/ralph/pull/1",
      requiredChecks: ["Test"],
      issueMeta: { labels: [], title: task.name },
      botBranch: "bot/integration",
      timedOut: false,
      opencodeSessionOptions: {},
    });

    expect(checksCall).toBe(4);
    expect(result.status).toBe("success");
  });
});
