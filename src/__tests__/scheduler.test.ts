import { describe, expect, mock, test } from "bun:test";

import { Semaphore } from "../semaphore";
import { createSchedulerController, startQueuedTasks } from "../scheduler";

type TestTask = { repo: string; _path: string; name: string };

function groupByRepo(tasks: TestTask[]): Map<string, TestTask[]> {
  const by = new Map<string, TestTask[]>();
  for (const t of tasks) {
    const existing = by.get(t.repo);
    if (existing) existing.push(t);
    else by.set(t.repo, [t]);
  }
  return by;
}

describe("Scheduler invariants", () => {
  test("drain gates new queued starts", async () => {
    const started: TestTask[] = [];

    const startedCount = await startQueuedTasks<TestTask>({
      gate: "draining",
      tasks: [{ repo: "a", _path: "t1", name: "t1" }],
      inFlightTasks: new Set<string>(),
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore: new Semaphore(10),
      getRepoSemaphore: () => new Semaphore(10),
      rrCursor: { value: 0 },
      shouldLog: () => false,
      log: () => {},
      startTask: ({ task }) => {
        started.push(task);
        return true;
      },
    });

    expect(startedCount).toBe(0);
    expect(started.length).toBe(0);
  });

  test("drain allows resume scheduling without dequeues", async () => {
    const pendingResumes: TestTask[] = [{ repo: "a", _path: "t1", name: "resume" }];
    const expectedResumes = [...pendingResumes];
    const runnableCalls: TestTask[][] = [];
    const resumed: TestTask[] = [];

    const controller = createSchedulerController<TestTask>({
      getDaemonMode: () => "draining",
      isShuttingDown: () => false,
      getRunnableTasks: async () => {
        runnableCalls.push([]);
        return [];
      },
      onRunnableTasks: async () => {},
      getPendingResumeTasks: () => pendingResumes,
      onPendingResumeTasks: (tasks) => {
        resumed.push(...tasks);
        pendingResumes.splice(0, pendingResumes.length);
      },
      timers: {
        setTimeout: (fn: (...args: any[]) => void) => {
          fn();
          return 1 as any;
        },
        clearTimeout: () => {},
      } as any,
    });

    controller.scheduleQueuedTasksSoon();
    controller.scheduleResumeTasksSoon();

    expect(runnableCalls.length).toBe(0);
    expect(resumed).toEqual(expectedResumes);

    const runningController = createSchedulerController<TestTask>({
      getDaemonMode: () => "running",
      isShuttingDown: () => false,
      getRunnableTasks: async () => {
        runnableCalls.push([]);
        return [];
      },
      onRunnableTasks: async () => {},
      getPendingResumeTasks: () => [],
      onPendingResumeTasks: () => {},
      timers: {
        setTimeout: (fn: (...args: any[]) => void) => {
          fn();
          return 1 as any;
        },
        clearTimeout: () => {},
      } as any,
    });

    runningController.scheduleQueuedTasksSoon();
    expect(runnableCalls.length).toBe(1);
  });

  test("startQueuedTasks skips in-flight tasks", async () => {
    const inFlightTasks = new Set<string>();
    const started: TestTask[] = [];

    const globalSemaphore = new Semaphore(10);

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(10);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const rrCursor = { value: 0 };

    const startTask = ({ repo, task }: { repo: string; task: TestTask }) => {
      inFlightTasks.add(task._path || task.name);
      started.push({ ...task, repo });
      return true;
    };

    const tasks = [{ repo: "a", _path: "orchestration/tasks/t1.md", name: "t1" }];

    const first = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks,
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor,
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
    });

    const second = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks,
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor,
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(started.length).toBe(1);
  });

  test("no duplicate scheduling when watcher double-fires", async () => {
    const inFlightTasks = new Set<string>();
    const started: TestTask[] = [];

    const globalSemaphore = new Semaphore(10);

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(10);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const rrCursor = { value: 0 };

    const startTask = ({ repo, task }: { repo: string; task: TestTask }) => {
      inFlightTasks.add(task._path || task.name);
      started.push({ ...task, repo });
      return true;
    };

    const tasks = [{ repo: "a", _path: "orchestration/tasks/t1.md", name: "t1" }];

    const first = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks,
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor,
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
    });

    const second = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks,
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor,
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(started.length).toBe(1);
  });

  test("priority resumes do not block queued starts", async () => {
    const inFlightTasks = new Set<string>();
    const started: string[] = [];

    const globalSemaphore = new Semaphore(2);

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(2);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const startPriorityTask = mock(({ task }: { task: TestTask }) => {
      started.push(`resume:${task._path}`);
      return true;
    });

    const startTask = mock(({ task }: { task: TestTask }) => {
      started.push(`queued:${task._path}`);
      return true;
    });

    const startedCount = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks: [{ repo: "a", _path: "t2", name: "queued" }],
      priorityTasks: [{ repo: "a", _path: "t1", name: "resume" }],
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor: { value: 0 },
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
      startPriorityTask: startPriorityTask as any,
    });

    expect(startedCount).toBe(2);
    expect(startPriorityTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(started[0]).toBe("resume:t1");
  });

  test("legacy order preserved when priorities are unset", async () => {
    const inFlightTasks = new Set<string>();
    const started: string[] = [];

    const globalSemaphore = new Semaphore(3);

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(1);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const startTask = ({ task }: { task: TestTask }) => {
      started.push(task.repo);
      return true;
    };

    const tasks = [
      { repo: "a", _path: "t-a", name: "t-a" },
      { repo: "b", _path: "t-b", name: "t-b" },
      { repo: "c", _path: "t-c", name: "t-c" },
    ];

    const startedCount = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks,
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor: { value: 0 },
      priorityEnabled: false,
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
    });

    expect(startedCount).toBe(3);
    expect(started).toEqual(["a", "b", "c"]);
  });

  test("resume scheduling does not block queued tasks", async () => {
    const inFlightTasks = new Set<string>();
    const started: string[] = [];

    const globalSemaphore = new Semaphore(2);

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(2);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const startPriorityTask = ({ task }: { task: TestTask }) => {
      started.push(`resume:${task._path}`);
      return true;
    };

    const startTask = ({ task }: { task: TestTask }) => {
      started.push(`queued:${task._path}`);
      return true;
    };

    const startedCount = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks: [{ repo: "repo-a", _path: "queued-1", name: "queued" }],
      priorityTasks: [{ repo: "repo-a", _path: "resume-1", name: "resume" }],
      inFlightTasks,
      getTaskKey: (t) => t._path || t.name,
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor: { value: 0 },
      shouldLog: () => false,
      log: () => {},
      startTask: startTask as any,
      startPriorityTask: startPriorityTask as any,
    });

    expect(startedCount).toBe(2);
    expect(started).toEqual(["resume:resume-1", "queued:queued-1"]);
  });

  test("queued tasks still schedule when resume tasks are pending", async () => {
    type ControllerTask = { repo: string; _path: string; name: string };
    const pendingResumes: ControllerTask[] = [{ repo: "repo-a", _path: "resume-1", name: "resume" }];
    const queuedTasks: ControllerTask[] = [{ repo: "repo-a", _path: "queued-1", name: "queued" }];
    const log: string[] = [];

    const globalSemaphore = new Semaphore(2);
    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(2);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const inFlightTasks = new Set<string>();
    const started: string[] = [];
    const rrCursor = { value: 0 };

    const controller = createSchedulerController<ControllerTask>({
      getDaemonMode: () => "running",
      isShuttingDown: () => false,
      getRunnableTasks: async () => queuedTasks,
      onRunnableTasks: async (tasks) => {
        const startedCount = await startQueuedTasks<ControllerTask>({
          gate: "running",
          tasks,
          priorityTasks: pendingResumes,
          inFlightTasks,
          getTaskKey: (t) => t._path || t.name,
          groupByRepo,
          globalSemaphore,
          getRepoSemaphore,
          rrCursor,
          shouldLog: () => false,
          log: (message) => log.push(message),
          startTask: ({ task }) => {
            started.push(`queued:${task._path}`);
            return true;
          },
          startPriorityTask: ({ task }) => {
            started.push(`resume:${task._path}`);
            return true;
          },
        });

        log.push(`started:${startedCount}`);
      },
      getPendingResumeTasks: () => pendingResumes,
      onPendingResumeTasks: () => {},
      timers: {
        setTimeout: (fn: (...args: any[]) => void) => {
          fn();
          return 1 as any;
        },
        clearTimeout: () => {},
      } as any,
    });

    controller.scheduleQueuedTasksSoon();
    controller.scheduleQueuedTasksSoon();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(["resume:resume-1", "queued:queued-1"]);
    expect(log).toContain("started:2");
  });

});
