import { describe, expect, mock, test } from "bun:test";

import { Semaphore } from "../semaphore";
import { createSchedulerController, startQueuedTasks } from "../scheduler";
import { attemptResumeResolvedEscalations } from "../escalation-resume-scheduler";
import type { AgentTask } from "../queue";

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
  test("drain gates new queued starts", () => {
    const started: TestTask[] = [];

    const startedCount = startQueuedTasks<TestTask>({
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
      startTask: ({ task }) => started.push(task),
    });

    expect(startedCount).toBe(0);
    expect(started.length).toBe(0);
  });

  test("drain allows resume scheduling without dequeues", () => {
    const pendingResumes: TestTask[] = [{ repo: "a", _path: "t1", name: "resume" }];
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
      },
      timers: {
        setTimeout: (fn: (...args: any[]) => void) => {
          fn();
          return 1 as any;
        },
        clearTimeout: () => {},
      },
    });

    controller.scheduleQueuedTasksSoon();
    controller.scheduleResumeTasksSoon();

    expect(runnableCalls.length).toBe(0);
    expect(resumed).toEqual(pendingResumes);

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
      },
    });

    runningController.scheduleQueuedTasksSoon();
    expect(runnableCalls.length).toBe(1);
  });

  test("no duplicate scheduling when watcher double-fires", () => {
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
    };

    const tasks = [{ repo: "a", _path: "orchestration/tasks/t1.md", name: "t1" }];

    const first = startQueuedTasks<TestTask>({
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

    const second = startQueuedTasks<TestTask>({
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

  test("no duplicate scheduling when watcher double-fires", () => {
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
    };

    const tasks = [{ repo: "a", _path: "orchestration/tasks/t1.md", name: "t1" }];

    const first = startQueuedTasks<TestTask>({
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

    const second = startQueuedTasks<TestTask>({
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

  test("priority resumes do not block queued starts", () => {
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
    });

    const startTask = mock(({ task }: { task: TestTask }) => {
      started.push(`queued:${task._path}`);
    });

    const startedCount = startQueuedTasks<TestTask>({
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

  test("resume still runs under drain (resolved escalations)", async () => {
    const resumeTask = mock(async () => ({ taskName: "", repo: "", outcome: "success" } as any));

    const resumeAttemptedThisRun = new Set<string>();
    let resumeDisabledUntil = 0;

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

    const inFlightTasks = new Set<string>();

    const escalation = {
      _path: "orchestration/escalations/e1.md",
      _name: "e1",
      type: "agent-escalation",
      status: "resolved",
      repo: "3mdistal/ralph",
      "task-path": "orchestration/tasks/test-task.md",
      "session-id": "ses_123",
      "resume-attempted-at": "",
      "resume-status": "",
    } as any;

    const task = {
      _path: "orchestration/tasks/test-task.md",
      _name: "test-task",
      type: "agent-task",
      "creation-date": "2026-01-10",
      scope: "builder",
      issue: "3mdistal/ralph#91",
      repo: "3mdistal/ralph",
      status: "in-progress",
      name: "Scheduler Test Task",
    } as AgentTask;

    const updateTaskStatus = mock(async () => true);

    await attemptResumeResolvedEscalations({
      isShuttingDown: () => false,
      now: () => Date.now(),

      resumeAttemptedThisRun,
      getResumeDisabledUntil: () => resumeDisabledUntil,
      setResumeDisabledUntil: (ts) => {
        resumeDisabledUntil = ts;
      },
      resumeDisableMs: 60_000,
      getVaultPathForLogs: () => "/tmp/vault",

      ensureSemaphores: () => {},
      getGlobalSemaphore: () => globalSemaphore,
      getRepoSemaphore,

      getTaskKey: (t) => t._path || t.name,
      inFlightTasks,

      getEscalationsByStatus: async () => [escalation],
      editEscalation: async () => ({ ok: true }),
      readResolutionMessage: async () => "Do the thing",

      getTaskByPath: async () => task,
      updateTaskStatus,

      shouldDeferWaitingResolutionCheck: () => false,
      buildWaitingResolutionUpdate: () => ({}),
      resolutionRecheckIntervalMs: 1,

      getOrCreateWorker: () => ({ resumeTask } as any),
      recordMerge: async () => {},
      scheduleQueuedTasksSoon: () => {},
    });

    expect(resumeTask).toHaveBeenCalledTimes(1);
    expect(updateTaskStatus).toHaveBeenCalledWith(task, "in-progress", expect.any(Object));
  });

  test("no duplicate resume per task key (resolved escalations)", async () => {
    const resumeTask = mock(async () => ({ taskName: "", repo: "", outcome: "success" } as any));

    const resumeAttemptedThisRun = new Set<string>();
    let resumeDisabledUntil = 0;

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

    const inFlightTasks = new Set<string>();

    const taskPath = "orchestration/tasks/test-task.md";

    const escalations = [
      {
        _path: "orchestration/escalations/e1.md",
        _name: "e1",
        type: "agent-escalation",
        status: "resolved",
        repo: "3mdistal/ralph",
        "task-path": taskPath,
        "session-id": "ses_123",
        "resume-attempted-at": "",
        "resume-status": "",
      },
      {
        _path: "orchestration/escalations/e2.md",
        _name: "e2",
        type: "agent-escalation",
        status: "resolved",
        repo: "3mdistal/ralph",
        "task-path": taskPath,
        "session-id": "ses_123",
        "resume-attempted-at": "",
        "resume-status": "",
      },
    ] as any[];

    const task = {
      _path: taskPath,
      _name: "test-task",
      type: "agent-task",
      "creation-date": "2026-01-10",
      scope: "builder",
      issue: "3mdistal/ralph#91",
      repo: "3mdistal/ralph",
      status: "in-progress",
      name: "Scheduler Test Task",
    } as AgentTask;

    await attemptResumeResolvedEscalations({
      isShuttingDown: () => false,
      now: () => Date.now(),

      resumeAttemptedThisRun,
      getResumeDisabledUntil: () => resumeDisabledUntil,
      setResumeDisabledUntil: (ts) => {
        resumeDisabledUntil = ts;
      },
      resumeDisableMs: 60_000,
      getVaultPathForLogs: () => "/tmp/vault",

      ensureSemaphores: () => {},
      getGlobalSemaphore: () => globalSemaphore,
      getRepoSemaphore,

      getTaskKey: (t) => t._path || t.name,
      inFlightTasks,

      getEscalationsByStatus: async () => escalations,
      editEscalation: async () => ({ ok: true }),
      readResolutionMessage: async () => "Proceed",

      getTaskByPath: async () => task,
      updateTaskStatus: async () => true,

      shouldDeferWaitingResolutionCheck: () => false,
      buildWaitingResolutionUpdate: () => ({}),
      resolutionRecheckIntervalMs: 1,

      getOrCreateWorker: () => ({ resumeTask } as any),
      recordMerge: async () => {},
      scheduleQueuedTasksSoon: () => {},
    });

    expect(resumeTask).toHaveBeenCalledTimes(1);
  });
});
