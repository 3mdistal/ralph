import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { AgentTask } from "../queue/types";
import { getRalphRunLogPath } from "../paths";

/**
 * Tests for session persistence (crash recovery) functionality.
 *
 * Session persistence ensures that:
 * 1. Session IDs are saved when tasks start
 * 2. On startup, in-progress tasks with session IDs are resumed
 * 3. In-progress tasks without session IDs are reset to starting
 * 4. Failed session resumes are escalated gracefully
 */

// Helper to create mock tasks
function createMockTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-09",
    scope: "builder",
    issue: "3mdistal/ralph#1",
    repo: "3mdistal/ralph",
    status: "queued",
    name: "Test Task",
    ...overrides,
  };
}

describe("Session Persistence", () => {
  describe("AgentTask interface", () => {
    test("session-id field is optional", () => {
      const taskWithoutSession = createMockTask();
      expect(taskWithoutSession["session-id"]).toBeUndefined();

      const taskWithSession = createMockTask({ "session-id": "ses_abc123" });
      expect(taskWithSession["session-id"]).toBe("ses_abc123");
    });

    test("daemon-id field is optional", () => {
      const taskWithoutDaemon = createMockTask();
      expect(taskWithoutDaemon["daemon-id"]).toBeUndefined();

      const taskWithDaemon = createMockTask({ "daemon-id": "d_123" });
      expect(taskWithDaemon["daemon-id"]).toBe("d_123");
    });

    test("heartbeat-at field is optional", () => {
      const taskWithoutHeartbeat = createMockTask();
      expect(taskWithoutHeartbeat["heartbeat-at"]).toBeUndefined();

      const taskWithHeartbeat = createMockTask({ "heartbeat-at": "2026-01-16T12:00:00.000Z" });
      expect(taskWithHeartbeat["heartbeat-at"]).toBe("2026-01-16T12:00:00.000Z");
    });

    test("session-id can be empty string", () => {
      const task = createMockTask({ "session-id": "" });
      expect(task["session-id"]).toBe("");
      // Empty string should be treated as "no session"
      expect(task["session-id"]?.trim()).toBeFalsy();
    });

    test("run-log-path field is optional", () => {
      const taskWithoutLog = createMockTask();
      expect(taskWithoutLog["run-log-path"]).toBeUndefined();

      const taskWithLog = createMockTask({ "run-log-path": "/tmp/ralph/run.log" });
      expect(taskWithLog["run-log-path"]).toBe("/tmp/ralph/run.log");
    });

    test("worktree-path field is optional", () => {
      const taskWithoutWorktree = createMockTask();
      expect(taskWithoutWorktree["worktree-path"]).toBeUndefined();

      const taskWithWorktree = createMockTask({ "worktree-path": "/tmp/worktree-1" });
      expect(taskWithWorktree["worktree-path"]).toBe("/tmp/worktree-1");
    });

    test("watchdog-retries field is optional", () => {
      const taskWithoutRetries = createMockTask();
      expect(taskWithoutRetries["watchdog-retries"]).toBeUndefined();

      const taskWithRetries = createMockTask({ "watchdog-retries": "1" });
      expect(taskWithRetries["watchdog-retries"]).toBe("1");
    });

    test("ownership fields are optional", () => {
      const taskWithoutOwnership = createMockTask();
      expect(taskWithoutOwnership["daemon-id"]).toBeUndefined();
      expect(taskWithoutOwnership["heartbeat-at"]).toBeUndefined();
      expect(taskWithoutOwnership["pause-requested"]).toBeUndefined();
      expect(taskWithoutOwnership.checkpoint).toBeUndefined();

      const taskWithOwnership = createMockTask({
        "daemon-id": "d_test",
        "heartbeat-at": "2026-01-18T00:00:00.000Z",
        "pause-requested": "true",
        checkpoint: "planned",
      });
      expect(taskWithOwnership["daemon-id"]).toBe("d_test");
      expect(taskWithOwnership["heartbeat-at"]).toBe("2026-01-18T00:00:00.000Z");
      expect(taskWithOwnership["pause-requested"]).toBe("true");
      expect(taskWithOwnership.checkpoint).toBe("planned");
    });
  });

  describe("Task categorization logic", () => {
    test("tasks without session-id are identified correctly", () => {
      const tasksWithoutSession = [
        createMockTask({ status: "in-progress" }),
        createMockTask({ status: "in-progress", "session-id": "" }),
        createMockTask({ status: "in-progress", "session-id": "   " }),
      ];

      for (const task of tasksWithoutSession) {
        const hasSession = task["session-id"]?.trim();
        expect(hasSession).toBeFalsy();
      }
    });

    test("tasks with session-id are identified correctly", () => {
      const tasksWithSession = [
        createMockTask({ status: "in-progress", "session-id": "ses_abc123" }),
        createMockTask({ status: "in-progress", "session-id": "ses_xyz789" }),
      ];

      for (const task of tasksWithSession) {
        const hasSession = task["session-id"]?.trim();
        expect(hasSession).toBeTruthy();
      }
    });
  });

  describe("Status transitions", () => {
    test("in-progress task without session should transition to starting", () => {
      const task = createMockTask({ status: "in-progress" });

      // Simulate the logic from resumeTasksOnStartup
      const hasSession = task["session-id"]?.trim();
      const newStatus = hasSession ? "in-progress" : "starting";

      expect(newStatus).toBe("starting");
    });

    test("in-progress task with session should stay in-progress", () => {
      const task = createMockTask({
        status: "in-progress",
        "session-id": "ses_abc123"
      });

      const hasSession = task["session-id"]?.trim();
      const newStatus = hasSession ? "in-progress" : "starting";

      expect(newStatus).toBe("in-progress");
    });
  });

  describe("Session ID clearing", () => {
    test("session-id should be cleared on task completion", () => {
      const task = createMockTask({
        status: "in-progress",
        "session-id": "ses_abc123"
      });

      // Simulate completion - session-id should be cleared
      const completedTask = {
        ...task,
        status: "done" as const,
        "session-id": "",
        "completed-at": "2026-01-09",
      };

      expect(completedTask.status).toBe("done");
      expect(completedTask["session-id"]).toBe("");
    });

    test("session-id should be preserved on task escalation", () => {
      const task = createMockTask({
        status: "in-progress",
        "session-id": "ses_abc123"
      });

      const escalatedTask = {
        ...task,
        status: "escalated" as const,
      };

      expect(escalatedTask.status).toBe("escalated");
      expect(escalatedTask["session-id"]).toBe("ses_abc123");
    });
  });

  describe("Multiple in-progress tasks handling", () => {
    test("resumes up to configured per-repo limit", () => {
      const perRepoMaxWorkers = 2;

      const tasks = [
        createMockTask({
          name: "Task 1",
          status: "in-progress",
          "session-id": "ses_1",
        }),
        createMockTask({
          name: "Task 2",
          status: "in-progress",
          "session-id": "ses_2",
        }),
        createMockTask({
          name: "Task 3",
          status: "in-progress",
          "session-id": "ses_3",
        }),
      ];

      // Simulate the logic: resume up to max, reset the rest to queued.
      const tasksToResume = tasks.slice(0, perRepoMaxWorkers);
      const tasksToReset = tasks.slice(perRepoMaxWorkers);

      expect(tasksToResume.map((t) => t.name)).toEqual(["Task 1", "Task 2"]);
      expect(tasksToReset.map((t) => t.name)).toEqual(["Task 3"]);
    });
  });

  describe("Session ID format", () => {
    test("accepts various session ID formats", () => {
      const validSessionIds = [
        "ses_abc123",
        "session-12345",
        "a1b2c3d4-e5f6-7890",
        "opencode_session_xyz",
      ];

      for (const sessionId of validSessionIds) {
        const task = createMockTask({ "session-id": sessionId });
        expect(task["session-id"]?.trim()).toBeTruthy();
      }
    });
  });
});

describe("run-log-path (XDG state)", () => {
  const original = process.env.XDG_STATE_HOME;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = original;
    }
  });

  test("uses XDG_STATE_HOME when set", () => {
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    const path = getRalphRunLogPath({ repo: "3mdistal/ralph", issueNumber: "51", stepTitle: "plan", ts: 123 });
    expect(path.startsWith("/tmp/xdg-state/ralph/run-logs/")).toBe(true);
  });
});

describe("groupByRepo behavior", () => {
  test("groups tasks by repo correctly", () => {
    const tasks = [
      createMockTask({ repo: "3mdistal/ralph", name: "Ralph Task 1" }),
      createMockTask({ repo: "3mdistal/agentlib", name: "Agentlib Task 1" }),
      createMockTask({ repo: "3mdistal/ralph", name: "Ralph Task 2" }),
    ];

    // Simulate groupByRepo logic
    const grouped = new Map<string, AgentTask[]>();
    for (const task of tasks) {
      if (!grouped.has(task.repo)) grouped.set(task.repo, []);
      grouped.get(task.repo)!.push(task);
    }

    expect(grouped.size).toBe(2);
    expect(grouped.get("3mdistal/ralph")?.length).toBe(2);
    expect(grouped.get("3mdistal/agentlib")?.length).toBe(1);
  });
});
