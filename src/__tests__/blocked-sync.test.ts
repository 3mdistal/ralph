import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { RepoWorker } from "../worker";
import type { IssueRelationshipProvider, IssueRelationshipSnapshot } from "../github/issue-relationships";
import { closeStateDbForTests, getParentVerificationState, initStateDb, recordIssueLabelsSnapshot } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

const updateTaskStatusMock = mock(async () => true);

const queueAdapter = {
  updateTaskStatus: updateTaskStatusMock,
};

const notifyAdapter = {
  notifyEscalation: async () => true,
  notifyError: async (_title: string, _body: string, _context?: unknown) => {},
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
    expect(typeof call?.[2]?.["blocked-at"]).toBe("string");
    expect(call?.[2]?.["blocked-at"]).not.toBe("");
    expect(typeof call?.[2]?.["blocked-details"]).toBe("string");
  });

  test("does not re-add blocked label when already present in state", async () => {
    updateTaskStatusMock.mockClear();
    const releaseLock = await acquireGlobalTestLock();
    const priorStateDb = process.env.RALPH_STATE_DB_PATH;
    const stateDir = await mkdtemp(join(tmpdir(), "ralph-state-"));
    process.env.RALPH_STATE_DB_PATH = join(stateDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();

    try {
      recordIssueLabelsSnapshot({
        repo: "3mdistal/ralph",
        issue: "3mdistal/ralph#10",
        labels: ["ralph:status:blocked"],
      });

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

      const addIssueLabelMock = mock(async () => {});
      (worker as any).addIssueLabel = addIssueLabelMock;

      await worker.syncBlockedStateForTasks([createTask({})]);
      await worker.syncBlockedStateForTasks([createTask({})]);

      expect(addIssueLabelMock).not.toHaveBeenCalled();
    } finally {
      closeStateDbForTests();
      if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorStateDb;
      await rm(stateDir, { recursive: true, force: true });
      releaseLock();
    }
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

  test("sets parent verification pending when deps unblock", async () => {
    updateTaskStatusMock.mockClear();
    const releaseLock = await acquireGlobalTestLock();
    const priorStateDb = process.env.RALPH_STATE_DB_PATH;
    const stateDir = await mkdtemp(join(tmpdir(), "ralph-state-"));
    process.env.RALPH_STATE_DB_PATH = join(stateDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();

    try {
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
      const task = createTask({ status: "blocked", "blocked-source": "deps" });
      await worker.syncBlockedStateForTasks([task]);

      const pending = getParentVerificationState({ repo: "3mdistal/ralph", issueNumber: 10 });
      expect(pending?.status).toBe("pending");
    } finally {
      closeStateDbForTests();
      if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorStateDb;
      await rm(stateDir, { recursive: true, force: true });
      releaseLock();
    }
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

  test("does not reset blocked-at when deps reason is unchanged", async () => {
    updateTaskStatusMock.mockClear();
    const provider: IssueRelationshipProvider = {
      getSnapshot: async (issue): Promise<IssueRelationshipSnapshot> => ({
        issue,
        signals: [{ source: "github", kind: "blocked_by", state: "open", ref: { repo: issue.repo, number: 11 } }],
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
    const task = createTask({
      status: "blocked",
      "blocked-source": "deps",
      "blocked-reason": "blocked by 3mdistal/ralph#11",
      "blocked-at": "2026-01-20T10:00:00.000Z",
    });
    await worker.syncBlockedStateForTasks([task]);

    const call = updateTaskStatusMock.mock.calls[0] as any;
    expect(call?.[1]).toBe("blocked");
    expect(call?.[2]?.["blocked-at"]).toBeUndefined();
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
