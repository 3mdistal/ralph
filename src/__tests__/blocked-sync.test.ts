import { afterAll, describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";
import type { IssueRelationshipProvider, IssueRelationshipSnapshot } from "../github/issue-relationships";

const updateTaskStatusMock = mock(async () => true);

const queueAdapter = {
  updateTaskStatus: updateTaskStatusMock,
};

const notifyAdapter = {
  notifyEscalation: async () => true,
  notifyError: async () => {},
  notifyTaskComplete: async () => {},
};

const sessionAdapter = {
  runAgent: async () => ({ sessionId: "", success: true, output: "" }),
  continueSession: async () => ({ sessionId: "", success: true, output: "" }),
  continueCommand: async () => ({ sessionId: "", success: true, output: "" }),
  getRalphXdgCacheHome: () => "/tmp",
};

const throttleAdapter = {
  getThrottleDecision: async () => ({ state: "ok", snapshot: { resumeAt: null } }),
} as any;

function createTask(overrides: Record<string, unknown>) {
  return {
    _path: "orchestration/tasks/issue-10.md",
    _name: "issue-10",
    type: "agent-task",
    "creation-date": "2026-01-22",
    scope: "builder",
    issue: "3mdistal/ralph#10",
    repo: "3mdistal/ralph",
    status: "queued",
    priority: "p2-medium",
    name: "Issue 10",
    ...overrides,
  } as any;
}

describe("syncBlockedStateForTasks", () => {
  afterAll(() => {
    mock.restore();
  });

  test("blocks queued tasks when dependencies are open", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [
          { source: "github", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 11 } },
        ],
        coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: false },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).addIssueLabel = async () => {};
    const blocked = await worker.syncBlockedStateForTasks([createTask({})]);

    expect(blocked.has("orchestration/tasks/issue-10.md")).toBe(true);
    expect(updateTaskStatusMock).toHaveBeenCalled();
    const call = updateTaskStatusMock.mock.calls[0] as any;
    expect(call?.[1]).toBe("blocked");
    expect(call?.[2]?.["blocked-source"]).toBe("deps");
  });

  test("does not unblock tasks blocked for other reasons", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [],
        coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).removeIssueLabel = async () => {};
    const task = createTask({ status: "blocked", "blocked-source": "allowlist" });
    await worker.syncBlockedStateForTasks([task]);

    expect(updateTaskStatusMock).not.toHaveBeenCalled();
  });

  test("keeps blocked label when non-deps blocks remain", async () => {
    updateTaskStatusMock.mockClear();
    const removeIssueLabelMock = mock(async () => {});
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [],
        coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).removeIssueLabel = removeIssueLabelMock;
    const tasks = [
      createTask({ status: "blocked", "blocked-source": "deps" }),
      createTask({ status: "blocked", "blocked-source": "allowlist" }),
    ];
    await worker.syncBlockedStateForTasks(tasks);

    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
  });

  test("keeps blocked label when unblocking fails", async () => {
    updateTaskStatusMock.mockClear();
    updateTaskStatusMock.mockImplementationOnce(async () => false);
    const removeIssueLabelMock = mock(async () => {});
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [],
        coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).removeIssueLabel = removeIssueLabelMock;
    const task = createTask({ status: "blocked", "blocked-source": "deps" });
    await worker.syncBlockedStateForTasks([task]);

    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
  });

  test("removes blocked label when deps unblock succeeds", async () => {
    updateTaskStatusMock.mockClear();
    const removeIssueLabelMock = mock(async () => {});
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [],
        coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).removeIssueLabel = removeIssueLabelMock;
    const task = createTask({ status: "blocked", "blocked-source": "deps" });
    await worker.syncBlockedStateForTasks([task]);

    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
  });

  test("ignores body blockers when GitHub deps coverage is present", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [
          { source: "body", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 12 } },
        ],
        coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).removeIssueLabel = async () => {};
    const task = createTask({ status: "blocked", "blocked-source": "deps" });
    await worker.syncBlockedStateForTasks([task]);

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const call = updateTaskStatusMock.mock.calls[0] as any;
    expect(call?.[1]).toBe("queued");
    expect(call?.[2]?.["blocked-source"]).toBe("");
  });

  test("falls back to body blockers when GitHub deps are unavailable", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [
          { source: "body", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 12 } },
        ],
        coverage: { githubDepsComplete: false, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).addIssueLabel = async () => {};
    await worker.syncBlockedStateForTasks([createTask({})]);

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const call = updateTaskStatusMock.mock.calls[0] as any;
    expect(call?.[1]).toBe("blocked");
    expect(call?.[2]?.["blocked-source"]).toBe("deps");
  });

  test("treats partial GitHub deps coverage as unknown", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [
          { source: "github", kind: "blocked_by", state: "closed", ref: { repo: issue.repo, number: 12 } },
          { source: "body", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 13 } },
        ],
        coverage: { githubDepsComplete: false, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    const task = createTask({ status: "blocked", "blocked-source": "deps" });
    await worker.syncBlockedStateForTasks([task]);

    expect(updateTaskStatusMock).not.toHaveBeenCalled();
  });

  test("blocks when partial GitHub deps include an open blocker", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [
          { source: "github", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 12 } },
          { source: "body", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 13 } },
        ],
        coverage: { githubDepsComplete: false, githubSubIssuesComplete: true, bodyDeps: true },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    (worker as any).addIssueLabel = async () => {};
    await worker.syncBlockedStateForTasks([createTask({})]);

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const call = updateTaskStatusMock.mock.calls[0] as any;
    expect(call?.[1]).toBe("blocked");
    expect(call?.[2]?.["blocked-source"]).toBe("deps");
  });

  test("skips changes when relationship coverage is unknown", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [],
        coverage: { githubDepsComplete: false, githubSubIssuesComplete: false, bodyDeps: false },
      }),
    };

    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: sessionAdapter,
      queue: queueAdapter,
      notify: notifyAdapter,
      throttle: throttleAdapter,
      relationships: provider,
    });

    await worker.syncBlockedStateForTasks([createTask({})]);

    expect(updateTaskStatusMock).not.toHaveBeenCalled();
  });
});
