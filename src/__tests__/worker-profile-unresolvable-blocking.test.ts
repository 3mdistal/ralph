import { describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "github:3mdistal/ralph#610",
    _name: "issue-610",
    type: "agent-task",
    "creation-date": "2026-02-01",
    scope: "builder",
    issue: "3mdistal/ralph#610",
    repo: "3mdistal/ralph",
    status: "queued",
    name: "Issue 610",
    ...overrides,
  } as any;
}

describe("RepoWorker profile unresolvable blocking", () => {
  test("processTask blocks with profile-unresolvable before any OpenCode session call", async () => {
    const runAgentMock = mock(async () => ({ success: true, output: "", sessionId: "" }));
    const continueSessionMock = mock(async () => ({ success: true, output: "", sessionId: "" }));
    const continueCommandMock = mock(async () => ({ success: true, output: "", sessionId: "" }));

    const sessionAdapter = {
      runAgent: runAgentMock,
      continueSession: continueSessionMock,
      continueCommand: continueCommandMock,
      getRalphXdgCacheHome: mock(() => "/tmp/cache"),
    } as any;

    const updateTaskStatusMock = mock(async (task: any, status: string, patch: Record<string, string>) => {
      task.status = status;
      for (const [key, value] of Object.entries(patch)) task[key] = value;
      return true;
    });

    const notifyAdapter = {
      notifyEscalation: mock(async () => {}),
      notifyError: mock(async () => {}),
      notifyTaskComplete: mock(async () => {}),
    } as any;

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: { updateTaskStatus: updateTaskStatusMock } as any,
      notify: notifyAdapter,
    });

    const task = createTask();

    (worker as any).getIssueMetadata = mock(async () => ({
      state: "OPEN",
      title: "Issue 610",
      labels: [],
      url: "https://example.com/issues/610",
    }));
    (worker as any).formatWorkerId = mock(async () => "worker-1");
    (worker as any).pauseIfHardThrottled = mock(async () => null);
    (worker as any).createAgentRun = mock(async () => {});
    (worker as any).notifyTaskFailure = mock(async () => {});
    (worker as any).resolveOpencodeXdgForTask = mock(async () => ({
      profileName: null,
      error: {
        code: "profile-unresolvable",
        reasonCode: "start-profile-unresolvable",
        message: "OpenCode profiles are enabled but default profile is not configured.",
      },
    }));

    const result = await worker.processTask(task);

    expect(result.outcome).toBe("failed");
    expect(result.escalationReason).toContain("default profile is not configured");
    expect(task.status).toBe("blocked");
    expect(task["blocked-source"]).toBe("profile-unresolvable");
    expect(task["blocked-reason"]).toContain("default profile is not configured");
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(continueSessionMock).not.toHaveBeenCalled();
    expect(continueCommandMock).not.toHaveBeenCalled();
  });
});
