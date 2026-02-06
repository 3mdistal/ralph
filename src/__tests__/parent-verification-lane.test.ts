import { describe, expect, test } from "bun:test";

import { maybeRunParentVerificationLane, type ParentVerificationLaneDeps } from "../worker/lanes/parent-verification";
import { PARENT_VERIFY_MARKER_PREFIX } from "../parent-verification";
import type { AgentTask } from "../queue-backend";
import type { EscalationType } from "../github/escalation-constants";
import type { EscalationContext } from "../notify";

type RecordAttemptFailureParams = {
  repo: string;
  issueNumber: number;
  attemptCount: number;
  nextAttemptAtMs: number;
  nowMs: number;
  details: string;
};

type CompleteVerificationParams = {
  repo: string;
  issueNumber: number;
  outcome: "skipped" | "work_remains" | "no_work";
  details: string;
  nowMs: number;
};

type EscalationWritebackParams = {
  reason: string;
  details?: string;
  escalationType: EscalationType;
};

type RecordEscalatedRunNoteParams = {
  reason: string;
  sessionId?: string;
  details?: string;
};

const baseTask: AgentTask = {
  _path: "tasks/123.md",
  _name: "123.md",
  type: "agent-task",
  "creation-date": "2026-02-04",
  scope: "repo",
  issue: "3mdistal/ralph#565",
  repo: "3mdistal/ralph",
  status: "queued",
  name: "Refactor parent verification lane",
};

function createDeps(overrides: Partial<ParentVerificationLaneDeps> = {}) {
  const now = 1_000_000;
  const calls = {
    updateTaskStatus: [] as Array<{ status: AgentTask["status"]; extra?: Record<string, string> }>,
    applyTaskPatch: [] as Array<{ status: AgentTask["status"]; extra: Record<string, string> }>,
    recordParentVerificationAttemptFailure: [] as Array<{ details: string }>,
    completeParentVerification: [] as Array<{ outcome: string; details: string }>,
    writeEscalationWriteback: [] as Array<{ reason: string }>,
    writeParentVerificationToGitHub: [] as Array<{ issueNumber: number }>,
    finalizeVerifiedTask: [] as Array<{ sessionId: string; cacheKey: string }>,
    notifyEscalation: [] as Array<{ reason: string }>,
    recordEscalatedRunNote: [] as Array<{ reason: string }>,
    runAgent: [] as Array<{ prompt: string }>,
  };

  const deps: ParentVerificationLaneDeps = {
    repo: "3mdistal/ralph",
    repoPath: "/repo",
    task: baseTask,
    issueNumber: "565",
    issueMeta: { title: "Refactor", url: "https://example.com", labels: [] },
    opencodeSessionOptions: undefined,
    nowMs: () => now,
    getParentVerificationState: () => ({ status: "pending", attemptCount: 0, nextAttemptAtMs: null }),
    tryClaimParentVerification: () => ({ attemptCount: 0 }),
    recordParentVerificationAttemptFailure: (params: RecordAttemptFailureParams) =>
      calls.recordParentVerificationAttemptFailure.push({ details: params.details }),
    completeParentVerification: (params: CompleteVerificationParams) =>
      calls.completeParentVerification.push({ outcome: params.outcome, details: params.details }),
    recordRunLogPath: async () => null,
    buildIssueContextForAgent: async () => "issue context",
    runAgent: async (_repoPath: string, _agentName: string, prompt: string) => {
      calls.runAgent.push({ prompt });
      return {
        sessionId: "sid",
        output: `${PARENT_VERIFY_MARKER_PREFIX}: ${JSON.stringify({ version: 1, work_remains: true, reason: "todo" })}`,
        success: true,
      };
    },
    buildWatchdogOptions: () => ({}),
    buildStallOptions: () => ({}),
    buildLoopDetectionOptions: () => ({}),
    handleLoopTrip: async () => ({ taskName: baseTask.name, repo: baseTask.repo, outcome: "failed" }),
    updateTaskStatus: async (_task: AgentTask, status: AgentTask["status"], extraFields: Record<string, string> = {}) => {
      calls.updateTaskStatus.push({ status, extra: extraFields });
      return true;
    },
    applyTaskPatch: (_task: AgentTask, status: AgentTask["status"], extraFields: Record<string, string>) => {
      calls.applyTaskPatch.push({ status, extra: extraFields });
    },
    writeEscalationWriteback: async (_task: AgentTask, params: EscalationWritebackParams) => {
      calls.writeEscalationWriteback.push({ reason: params.reason });
      return null;
    },
    writeParentVerificationToGitHub: async (params) => {
      calls.writeParentVerificationToGitHub.push({ issueNumber: params.issueNumber });
      return { ok: true, closed: true, labelOpsApplied: true };
    },
    finalizeVerifiedTask: async (params) => {
      calls.finalizeVerifiedTask.push({ sessionId: params.sessionId, cacheKey: params.cacheKey });
      return { taskName: baseTask.name, repo: baseTask.repo, outcome: "success" };
    },
    notifyEscalation: async (params: EscalationContext) => {
      calls.notifyEscalation.push({ reason: params.reason });
      return true;
    },
    recordEscalatedRunNote: async (_task: AgentTask, params: RecordEscalatedRunNoteParams) => {
      calls.recordEscalatedRunNote.push({ reason: params.reason });
    },
    ...overrides,
  };

  return { deps, calls, now };
}

describe("parent verification lane", () => {
  test("defers when backoff is active", async () => {
    const { deps, calls, now } = createDeps({
      getParentVerificationState: () => ({ status: "pending", attemptCount: 0, nextAttemptAtMs: now + 60_000 }),
    });

    const result = await maybeRunParentVerificationLane(deps);
    expect(result?.outcome).toBe("failed");
    expect(calls.updateTaskStatus[0]?.status).toBe("queued");
    expect(calls.applyTaskPatch[0]?.status).toBe("queued");
  });

  test("returns null when work remains", async () => {
    const { deps, calls } = createDeps({
      runAgent: async (_repoPath: string, _agentName: string, _prompt: string) => ({
        sessionId: "sid",
        output: `${PARENT_VERIFY_MARKER_PREFIX}: ${JSON.stringify({
          version: 1,
          work_remains: true,
          reason: "work left",
        })}`,
        success: true,
      }),
    });

    const result = await maybeRunParentVerificationLane(deps);
    expect(result).toBe(null);
    expect(calls.completeParentVerification[0]?.outcome).toBe("work_remains");
  });

  test("completes when no work remains with strong confidence", async () => {
    const { deps, calls } = createDeps({
      runAgent: async (_repoPath: string, _agentName: string, _prompt: string) => ({
        sessionId: "sid",
        output: `${PARENT_VERIFY_MARKER_PREFIX}: ${JSON.stringify({
          version: 1,
          work_remains: false,
          reason: "already done",
          confidence: "high",
          checked: ["child issues reviewed"],
          why_satisfied: "All child issues are closed and acceptance criteria is met.",
          evidence: [{ url: "https://example.com", note: "child issue" }],
        })}`,
        success: true,
      }),
    });

    const result = await maybeRunParentVerificationLane(deps);
    expect(result?.outcome).toBe("success");
    expect(calls.writeParentVerificationToGitHub.length).toBe(1);
    expect(calls.finalizeVerifiedTask.length).toBe(1);
  });

  test("escalates when no work remains but confidence is low", async () => {
    const { deps, calls } = createDeps({
      runAgent: async (_repoPath: string, _agentName: string, _prompt: string) => ({
        sessionId: "sid",
        output: `${PARENT_VERIFY_MARKER_PREFIX}: ${JSON.stringify({
          version: 1,
          work_remains: false,
          reason: "already done",
          confidence: "low",
        })}`,
        success: true,
      }),
    });

    const result = await maybeRunParentVerificationLane(deps);
    expect(result?.outcome).toBe("escalated");
    expect(calls.updateTaskStatus[0]?.status).toBe("escalated");
    expect(calls.writeEscalationWriteback.length).toBe(1);
    expect(calls.notifyEscalation.length).toBe(1);
  });

  test("defers when claim is not acquired", async () => {
    const { deps, calls } = createDeps({
      tryClaimParentVerification: () => null,
    });

    const result = await maybeRunParentVerificationLane(deps);
    expect(result?.outcome).toBe("failed");
    expect(calls.runAgent.length).toBe(0);
  });
});
