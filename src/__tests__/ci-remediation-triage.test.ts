import { describe, expect, test } from "bun:test";

import { runCiFailureTriage } from "../worker/ci/remediation";
import { buildCiFailureSignatureV3 } from "../ci-triage/signature";

function computeCiDebugMarkerId(repo: string, issueNumber: number): string {
  const fnv = (input: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const base = `${repo}|${issueNumber}`;
  return `${fnv(base)}${fnv(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildTask(): any {
  return {
    _path: "github:3mdistal/ralph#732",
    _name: "task-732",
    name: "CI triage",
    issue: "3mdistal/ralph#732",
    repo: "3mdistal/ralph",
    status: "in-progress",
    "session-id": "ses_1",
  };
}

describe("runCiFailureTriage", () => {
  test("fails closed when triage artifact cannot be persisted", async () => {
    const task = buildTask();
    let spawnCalls = 0;
    const worker: any = {
      repo: "3mdistal/ralph",
      github: { request: async () => ({ data: [] }) },
      resolveCiFixAttempts: () => 5,
      getPullRequestChecks: async () => ({
        headSha: "sha1",
        baseRefName: "bot/integration",
        checks: [{ name: "Test", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
      }),
      getPullRequestMergeState: async () => ({ headRefName: "branch" }),
      recordCiGateSummary: () => {},
      formatGhError: (error: any) => String(error?.message ?? error ?? "error"),
      buildRemediationFailureContext: async () => ({
        logs: [{ name: "Test", rawState: "FAILURE", logExcerpt: "assertion failed" }],
        failedChecks: [{ name: "Test", rawState: "FAILURE", detailsUrl: null }],
        commands: ["bun test"],
      }),
      buildCiTriageRecord: (input: any) => ({ ...input, version: 2, signatureVersion: input.signature.version }),
      recordCiTriageArtifact: () => false,
      runCiDebugRecovery: async () => {
        spawnCalls += 1;
        return { status: "success" };
      },
    };

    const result = await runCiFailureTriage(worker, {
      task,
      issueNumber: "732",
      cacheKey: "ck",
      prUrl: "https://github.com/3mdistal/ralph/pull/10",
      requiredChecks: ["Test"],
      issueMeta: { labels: [], title: task.name },
      botBranch: "bot/integration",
      timedOut: false,
      repoPath: "/tmp/repo",
      opencodeSessionOptions: {},
    });

    expect(result.status).toBe("failed");
    expect(spawnCalls).toBe(0);
  });

  test("quarantine action upserts follow-up issue and throttles", async () => {
    const task = buildTask();
    const signature = buildCiFailureSignatureV3({
      timedOut: false,
      failures: [{ name: "CI", rawState: "FAILURE", excerpt: "network error etimedout" }],
    }).signature;
    const markerId = computeCiDebugMarkerId("3mdistal/ralph", 732);
    const commentBody = [
      `<!-- ralph-ci-debug:id=${markerId} -->`,
      `<!-- ralph-ci-debug:state=${JSON.stringify({
        version: 1,
        triage: { version: 1, attemptCount: 1, lastSignature: signature },
      })} -->`,
      "",
      "CI triage status",
    ].join("\n");

    let followupCalls = 0;
    let throttleCalls = 0;
    const worker: any = {
      repo: "3mdistal/ralph",
      github: {
        request: async (path: string) => {
          if (path.includes("/issues/732/comments")) {
            return { data: [{ id: 1, body: commentBody, updated_at: "2026-02-18T00:00:00.000Z" }] };
          }
          return { data: [] };
        },
      },
      resolveCiFixAttempts: () => 5,
      getPullRequestChecks: async () => ({
        headSha: "sha1",
        baseRefName: "bot/integration",
        checks: [{ name: "CI", state: "FAILURE", rawState: "FAILURE", detailsUrl: null }],
      }),
      getPullRequestMergeState: async () => ({ headRefName: "branch" }),
      recordCiGateSummary: () => {},
      formatGhError: (error: any) => String(error?.message ?? error ?? "error"),
      buildRemediationFailureContext: async () => ({
        logs: [{ name: "CI", rawState: "FAILURE", logExcerpt: "network error etimedout" }],
        failedChecks: [{ name: "CI", rawState: "FAILURE", detailsUrl: null }],
        commands: [],
      }),
      buildCiTriageRecord: (input: any) => ({
        version: 2,
        signatureVersion: input.signature.version,
        signature: input.signature.signature,
        classification: input.decision.classification,
        classificationReason: input.decision.classificationReason,
        action: input.decision.action,
        actionReason: input.decision.actionReason,
        timedOut: input.timedOut,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        priorSignature: input.priorSignature,
        failingChecks: input.failedChecks,
        commands: input.commands,
      }),
      recordCiTriageArtifact: () => true,
      upsertCiQuarantineFollowupIssue: async () => {
        followupCalls += 1;
        return { number: 9001, url: "https://github.com/3mdistal/ralph/issues/9001" };
      },
      computeCiRemediationBackoffMs: () => 30000,
      buildCiTriageCommentLines: () => ["CI triage status"],
      upsertCiDebugComment: async () => {},
      clearCiDebugLabels: async () => {},
      throttleForCiQuarantine: async () => {
        throttleCalls += 1;
        return { taskName: task.name, repo: "3mdistal/ralph", outcome: "throttled" };
      },
      runCiDebugRecovery: async () => ({ status: "failed" }),
    };

    const result = await runCiFailureTriage(worker, {
      task,
      issueNumber: "732",
      cacheKey: "ck",
      prUrl: "https://github.com/3mdistal/ralph/pull/10",
      requiredChecks: ["CI"],
      issueMeta: { labels: [], title: task.name },
      botBranch: "bot/integration",
      timedOut: false,
      repoPath: "/tmp/repo",
      opencodeSessionOptions: {},
    });

    expect(result.status).toBe("throttled");
    expect(followupCalls).toBe(1);
    expect(throttleCalls).toBe(1);
  });
});
