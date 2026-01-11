import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { AgentTask } from "../queue";

/**
 * Tests for session persistence (crash recovery) functionality.
 *
 * Session persistence ensures that:
 * 1. Session IDs are saved when tasks start
 * 2. On startup, in-progress tasks with session IDs are resumed
 * 3. In-progress tasks without session IDs are reset to queued
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

    test("session-id can be empty string", () => {
      const task = createMockTask({ "session-id": "" });
      expect(task["session-id"]).toBe("");
      // Empty string should be treated as "no session"
      expect(task["session-id"]?.trim()).toBeFalsy();
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
    test("in-progress task without session should transition to queued", () => {
      const task = createMockTask({ status: "in-progress" });

      // Simulate the logic from resumeTasksOnStartup
      const hasSession = task["session-id"]?.trim();
      const newStatus = hasSession ? "in-progress" : "queued";

      expect(newStatus).toBe("queued");
    });

    test("in-progress task with session should stay in-progress", () => {
      const task = createMockTask({
        status: "in-progress",
        "session-id": "ses_abc123"
      });

      const hasSession = task["session-id"]?.trim();
      const newStatus = hasSession ? "in-progress" : "queued";

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

describe("groupByRepo behavior", () => {
  test("groups tasks by repo correctly", () => {
    const tasks = [
      createMockTask({ repo: "3mdistal/ralph", name: "Ralph Task 1" }),
      createMockTask({ repo: "3mdistal/bwrb", name: "BWRB Task 1" }),
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
    expect(grouped.get("3mdistal/bwrb")?.length).toBe(1);
  });
});

describe("Queue discovery", () => {
  let dataset: AgentTask[] = [];
  let lastCommand = "";

  function buildCommand(strings: TemplateStringsArray, values: unknown[]): string {
    let out = "";
    for (let i = 0; i < strings.length; i++) {
      out += strings[i] ?? "";
      if (i < values.length) out += String(values[i]);
    }
    return out;
  }

  function applyWhereFilter(rows: AgentTask[], cmd: string): AgentTask[] {
    if (cmd.includes("type == 'agent-task'")) {
      rows = rows.filter((r) => r.type === "agent-task");
    }

    const statusMatch = cmd.match(/status == '([^']+)'/);
    if (statusMatch?.[1]) {
      const status = statusMatch[1] as AgentTask["status"];
      rows = rows.filter((r) => r.status === status);
    }

    return rows;
  }

  function createMockBwrbRunner() {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
      lastCommand = buildCommand(strings, values);

      const runner = {
        cwd: () => runner,
        quiet: async () => {
          const filtered = applyWhereFilter(dataset, lastCommand);
          return { stdout: Buffer.from(JSON.stringify(filtered)) };
        },
      };

      return runner;
    };
  }

  async function loadQueue() {
    return await import("../queue");
  }

  beforeEach(async () => {
    dataset = [];
    lastCommand = "";

    const queue = await loadQueue();
    queue.__setBwrbRunnerForTests(createMockBwrbRunner());
  });

  afterEach(async () => {
    const queue = await loadQueue();
    queue.__resetBwrbRunnerForTests();
  });

  test("discovers queued agent-task notes nested under orchestration/tasks/**", async () => {
    dataset = [
      createMockTask({ _path: "orchestration/tasks/Foo/bar.md", _name: "bar", status: "queued" }),
      createMockTask({ _path: "orchestration/tasks/root-task.md", _name: "root-task", status: "queued" }),
      createMockTask({ _path: "orchestration/tasks/Baz/qux.md", _name: "qux", status: "done" }),
    ];

    const { getQueuedTasks } = await loadQueue();
    const tasks = await getQueuedTasks();

    expect(lastCommand).toContain("bwrb list");
    expect(lastCommand).toContain("--path orchestration/tasks/**");
    expect(lastCommand).toContain("type == 'agent-task'");
    expect(lastCommand).toContain("status == 'queued'");

    expect(tasks.map((t) => t._path).sort()).toEqual(
      ["orchestration/tasks/Foo/bar.md", "orchestration/tasks/root-task.md"].sort()
    );
  });

  test("queries status using bwrb --where instead of JS filtering", async () => {
    dataset = [
      createMockTask({ _path: "orchestration/tasks/a.md", _name: "a", status: "in-progress" }),
      createMockTask({ _path: "orchestration/tasks/b.md", _name: "b", status: "queued" }),
    ];

    const { getTasksByStatus } = await loadQueue();
    const tasks = await getTasksByStatus("in-progress");

    expect(lastCommand).toContain("status == 'in-progress'");
    expect(tasks.map((t) => t._path)).toEqual(["orchestration/tasks/a.md"]);
  });
});
