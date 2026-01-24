import { describe, expect, mock, test, beforeEach } from "bun:test";
import { join } from "path";
import { getRalphWorktreesDir } from "../paths";
import { RepoWorker } from "../worker";

const updateTaskStatusMock = mock(async () => true);

const queueAdapter = {
  updateTaskStatus: updateTaskStatusMock,
};

const repoSlug = "ralph";

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/ralph#277",
    repo: "3mdistal/ralph",
    status: "starting",
    priority: "p2-medium",
    name: "Worktree Recovery Task",
    ...overrides,
  } as any;
}

describe("worktree-path recovery", () => {
  beforeEach(() => {
    updateTaskStatusMock.mockClear();
  });

  test("start mode recreates missing recorded worktree path", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    (worker as any).ensureGitWorktree = mock(async () => {});
    (worker as any).safeRemoveWorktree = mock(async () => {});

    const stalePath = join(getRalphWorktreesDir(), repoSlug, "slot-0", "277", "stale-worktree");
    const task = createMockTask({
      status: "starting",
      "worktree-path": stalePath,
    });

    const result = await (worker as any).resolveTaskRepoPath(task, "277", "start", 0);

    expect(result.kind).toBe("ok");

    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("starting");
    expect(lastCall[2]["worktree-path"]).toBe(result.worktreePath);
    expect(result.worktreePath).toBeTruthy();
  });

  test("resume mode resets task when recorded worktree path is missing", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    (worker as any).safeRemoveWorktree = mock(async () => {});

    const stalePath = join(getRalphWorktreesDir(), repoSlug, "slot-0", "277", "missing-worktree");
    const task = createMockTask({
      status: "in-progress",
      "session-id": "ses_123",
      "worktree-path": stalePath,
    });

    const result = await (worker as any).resolveTaskRepoPath(task, "277", "resume", 0);

    expect(result.kind).toBe("reset");

    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("queued");
    expect(lastCall[2]["session-id"]).toBe("");
    expect(lastCall[2]["worktree-path"]).toBe("");
    expect(lastCall[2]["worker-id"]).toBe("");
    expect(lastCall[2]["repo-slot"]).toBe("");
    expect(lastCall[2]["daemon-id"]).toBe("");
    expect(lastCall[2]["heartbeat-at"]).toBe("");
    expect(lastCall[2]["watchdog-retries"]).toBe("");
  });
});
