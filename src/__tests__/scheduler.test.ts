import { describe, expect, mock, test } from "bun:test";

import { Scheduler, type Timers } from "../scheduler";
import type { AgentTask } from "../queue";
import type { DaemonMode } from "../drain";

function createMockTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/ralph#91",
    repo: "3mdistal/ralph",
    status: "queued",
    priority: "p1-high",
    name: "Scheduler Test Task",
    ...overrides,
  };
}

function createManualTimers(): Timers & { runAll: () => void } {
  let nextId = 1;
  const pending = new Map<number, () => void>();

  return {
    setTimeout: ((fn: any) => {
      const id = nextId++;
      pending.set(id, () => fn());
      return id as any;
    }) as any,
    clearTimeout: ((id: any) => {
      pending.delete(Number(id));
    }) as any,
    runAll: () => {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Scheduler (DI boundary)", () => {
  test("drain gates new dequeues (scheduleQueuedTasksSoon)", async () => {
    const timers = createManualTimers();
    let mode: DaemonMode = "draining";

    const getQueuedTasks = mock(async () => [] as AgentTask[]);

    const scheduler = new Scheduler({
      timers,
      getDaemonMode: () => mode,
      isShuttingDown: () => false,
      concurrency: { getGlobalLimit: () => 4, getRepoLimit: () => 4 },
      queue: {
        getQueuedTasks,
        getTasksByStatus: async () => [],
        getTaskByPath: async () => null,
        updateTaskStatus: async () => true,
        groupByRepo: () => new Map(),
      },
      workers: {
        getOrCreateWorker: () => ({
          processTask: async () => ({ taskName: "", repo: "", outcome: "success" } as any),
          resumeTask: async () => ({ taskName: "", repo: "", outcome: "success" } as any),
        }),
      },
      rollup: { recordMerge: async () => {} },
      escalations: {
        getEscalationsByStatus: async () => [],
        editEscalation: async () => {},
        readResolutionMessage: async () => null,
        buildWaitingResolutionUpdate: () => ({}),
        shouldDeferWaitingResolutionCheck: () => false,
        resolutionRecheckIntervalMs: 1,
      },
      logging: { shouldLog: () => false },
    });

    scheduler.scheduleQueuedTasksSoon();
    scheduler.scheduleQueuedTasksSoon();
    timers.runAll();

    expect(getQueuedTasks).not.toHaveBeenCalled();

    mode = "running";
    scheduler.scheduleQueuedTasksSoon();
    timers.runAll();

    expect(getQueuedTasks).toHaveBeenCalledTimes(1);
  });

  test("resume still runs under drain (resolved escalations)", async () => {
    const timers = createManualTimers();
    const mode: DaemonMode = "draining";

    const resumeTask = mock(async () => ({ taskName: "", repo: "", outcome: "success" } as any));
    const processTask = mock(async () => ({ taskName: "", repo: "", outcome: "success" } as any));

    const escalation = {
      _path: "orchestration/escalations/e1.md",
      repo: "3mdistal/ralph",
      "task-path": "orchestration/tasks/test-task.md",
      "session-id": "ses_123",
      "resume-attempted-at": "",
    };

    const scheduler = new Scheduler({
      timers,
      getDaemonMode: () => mode,
      isShuttingDown: () => false,
      concurrency: { getGlobalLimit: () => 4, getRepoLimit: () => 4 },
      queue: {
        getQueuedTasks: async () => [],
        getTasksByStatus: async () => [],
        getTaskByPath: async () => createMockTask({ status: "in-progress" }),
        updateTaskStatus: async () => true,
        groupByRepo: () => new Map(),
      },
      workers: {
        getOrCreateWorker: () => ({ processTask, resumeTask }),
      },
      rollup: { recordMerge: async () => {} },
      escalations: {
        getEscalationsByStatus: async () => [escalation],
        editEscalation: async () => {},
        readResolutionMessage: async () => "Do the thing",
        buildWaitingResolutionUpdate: () => ({}),
        shouldDeferWaitingResolutionCheck: () => false,
        resolutionRecheckIntervalMs: 1,
      },
      logging: { shouldLog: () => false },
    });

    await scheduler.attemptResumeResolvedEscalations();

    expect(resumeTask).toHaveBeenCalledTimes(1);
    expect(processTask).toHaveBeenCalledTimes(0);
  });

  test("no duplicate scheduling when watcher double-fires (processNewTasks)", async () => {
    const timers = createManualTimers();
    let mode: DaemonMode = "running";

    const run = deferred<any>();
    const processTask = mock(async () => run.promise);

    const scheduler = new Scheduler({
      timers,
      getDaemonMode: () => mode,
      isShuttingDown: () => false,
      concurrency: { getGlobalLimit: () => 4, getRepoLimit: () => 4 },
      queue: {
        getQueuedTasks: async () => [],
        getTasksByStatus: async () => [],
        getTaskByPath: async () => null,
        updateTaskStatus: async () => true,
        groupByRepo: (tasks) => {
          const map = new Map<string, AgentTask[]>();
          for (const t of tasks) {
            const arr = map.get(t.repo) ?? [];
            arr.push(t);
            map.set(t.repo, arr);
          }
          return map;
        },
      },
      workers: {
        getOrCreateWorker: () => ({
          processTask,
          resumeTask: async () => ({ taskName: "", repo: "", outcome: "success" } as any),
        }),
      },
      rollup: { recordMerge: async () => {} },
      escalations: {
        getEscalationsByStatus: async () => [],
        editEscalation: async () => {},
        readResolutionMessage: async () => null,
        buildWaitingResolutionUpdate: () => ({}),
        shouldDeferWaitingResolutionCheck: () => false,
        resolutionRecheckIntervalMs: 1,
      },
      logging: { shouldLog: () => false },
    });

    const task = createMockTask();

    await scheduler.processNewTasks([task]);
    await scheduler.processNewTasks([task]);

    expect(processTask).toHaveBeenCalledTimes(1);

    run.resolve({ taskName: "", repo: "", outcome: "success" });

    mode = "draining";
    await scheduler.processNewTasks([createMockTask({ _path: "orchestration/tasks/other.md" })]);
    expect(processTask).toHaveBeenCalledTimes(1);
  });

  test("no duplicate resume per task key (resolved escalations)", async () => {
    const timers = createManualTimers();

    const run = deferred<any>();
    const resumeTask = mock(async () => run.promise);

    const sharedTask = createMockTask({ status: "in-progress" });

    const escalations = [
      {
        _path: "orchestration/escalations/e1.md",
        repo: "3mdistal/ralph",
        "task-path": sharedTask._path,
        "session-id": "ses_123",
        "resume-attempted-at": "",
      },
      {
        _path: "orchestration/escalations/e2.md",
        repo: "3mdistal/ralph",
        "task-path": sharedTask._path,
        "session-id": "ses_123",
        "resume-attempted-at": "",
      },
    ];

    const scheduler = new Scheduler({
      timers,
      getDaemonMode: () => "running",
      isShuttingDown: () => false,
      concurrency: { getGlobalLimit: () => 4, getRepoLimit: () => 4 },
      queue: {
        getQueuedTasks: async () => [],
        getTasksByStatus: async () => [],
        getTaskByPath: async () => sharedTask,
        updateTaskStatus: async () => true,
        groupByRepo: () => new Map(),
      },
      workers: {
        getOrCreateWorker: () => ({
          processTask: async () => ({ taskName: "", repo: "", outcome: "success" } as any),
          resumeTask,
        }),
      },
      rollup: { recordMerge: async () => {} },
      escalations: {
        getEscalationsByStatus: async () => escalations,
        editEscalation: async () => {},
        readResolutionMessage: async () => "Proceed",
        buildWaitingResolutionUpdate: () => ({}),
        shouldDeferWaitingResolutionCheck: () => false,
        resolutionRecheckIntervalMs: 1,
      },
      logging: { shouldLog: () => false },
    });

    await scheduler.attemptResumeResolvedEscalations();

    expect(resumeTask).toHaveBeenCalledTimes(1);

    run.resolve({ taskName: "", repo: "", outcome: "success" });
  });
});
