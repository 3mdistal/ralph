import type { ReleaseFn } from "./semaphore";
import type { Semaphore } from "./semaphore";

export type SchedulerGate = "running" | "draining" | "soft-throttled";

export interface SchedulerDeps<Task> {
  gate: SchedulerGate;
  tasks: Task[];
  inFlightTasks: Set<string>;
  getTaskKey: (task: Task) => string;
  groupByRepo: (tasks: Task[]) => Map<string, Task[]>;
  globalSemaphore: Semaphore;
  getRepoSemaphore: (repo: string) => Semaphore;
  rrCursor: { value: number };
  shouldLog: (key: string, intervalMs: number) => boolean;
  log: (message: string) => void;
  startTask: (opts: { repo: string; task: Task; releaseGlobal: ReleaseFn; releaseRepo: ReleaseFn }) => void;
  priorityTasks?: Task[];
  startPriorityTask?: (opts: { repo: string; task: Task; releaseGlobal: ReleaseFn; releaseRepo: ReleaseFn }) => void;
}

export function startQueuedTasks<Task extends { repo: string }>(deps: SchedulerDeps<Task>): number {
  if (deps.gate !== "running") return 0;

  const tasks = deps.tasks;
  const priorityTasks = deps.priorityTasks ?? [];

  if (tasks.length === 0 && priorityTasks.length === 0) {
    if (deps.shouldLog("daemon:no-queued", 30_000)) {
      deps.log("[ralph] No queued tasks");
    }
    return 0;
  }

  const newTasks = tasks.filter((t) => !deps.inFlightTasks.has(deps.getTaskKey(t)));
  const newPriorityTasks = priorityTasks.filter((t) => !deps.inFlightTasks.has(deps.getTaskKey(t)));

  if (newTasks.length === 0 && newPriorityTasks.length === 0) {
    if (deps.shouldLog("daemon:all-in-flight", 30_000)) {
      deps.log("[ralph] All queued tasks already in flight");
    }
    return 0;
  }

  const byRepo = deps.groupByRepo(newTasks);
  const priorityByRepo = deps.groupByRepo(newPriorityTasks);
  const repos = Array.from(new Set([...priorityByRepo.keys(), ...byRepo.keys()]));
  if (repos.length === 0) return 0;

  let startedCount = 0;

  while (deps.globalSemaphore.available() > 0) {
    let startedThisRound = false;

    for (let i = 0; i < repos.length; i++) {
      const idx = (deps.rrCursor.value + i) % repos.length;
      const repo = repos[idx];
      const priorityTasksForRepo = priorityByRepo.get(repo);
      const repoTasks = byRepo.get(repo);

      let task: Task | undefined;
      let isPriority = false;

      if (priorityTasksForRepo && priorityTasksForRepo.length > 0) {
        task = priorityTasksForRepo.shift();
        isPriority = true;
      } else if (repoTasks && repoTasks.length > 0) {
        task = repoTasks.shift();
      }

      if (!task) continue;

      const releaseGlobal = deps.globalSemaphore.tryAcquire();
      if (!releaseGlobal) return startedCount;

      const releaseRepo = deps.getRepoSemaphore(repo).tryAcquire();
      if (!releaseRepo) {
        releaseGlobal();
        continue;
      }

      deps.rrCursor.value = (idx + 1) % repos.length;

      startedCount++;
      startedThisRound = true;
      const startFn = isPriority ? deps.startPriorityTask ?? deps.startTask : deps.startTask;
      startFn({ repo, task, releaseGlobal, releaseRepo });
      break;
    }

    if (!startedThisRound) break;
  }

  return startedCount;
}

export type SchedulerTimers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export type SchedulerControllerDeps<Task> = {
  getDaemonMode: () => "running" | "draining";
  isShuttingDown: () => boolean;
  getRunnableTasks: () => Promise<Task[]>;
  onRunnableTasks: (tasks: Task[]) => Promise<void> | void;
  getPendingResumeTasks: () => Task[];
  onPendingResumeTasks: (tasks: Task[]) => void;
  timers?: SchedulerTimers;
  queuedDebounceMs?: number;
  resumeDebounceMs?: number;
};

export type SchedulerController = {
  scheduleQueuedTasksSoon: () => void;
  scheduleResumeTasksSoon: () => void;
  clearTimers: () => void;
};

export function createSchedulerController<Task>(deps: SchedulerControllerDeps<Task>): SchedulerController {
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const queuedDebounceMs = deps.queuedDebounceMs ?? 250;
  const resumeDebounceMs = deps.resumeDebounceMs ?? 250;

  let scheduleQueuedTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduleResumeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleQueuedTasksSoon = (): void => {
    if (scheduleQueuedTimer) return;
    scheduleQueuedTimer = timers.setTimeout(() => {
      scheduleQueuedTimer = null;
      if (deps.isShuttingDown()) return;
      if (deps.getDaemonMode() === "draining") return;
      void deps.getRunnableTasks().then((tasks) => deps.onRunnableTasks(tasks));
    }, queuedDebounceMs);
  };

  const scheduleResumeTasksSoon = (): void => {
    if (scheduleResumeTimer) return;
    scheduleResumeTimer = timers.setTimeout(() => {
      scheduleResumeTimer = null;
      if (deps.isShuttingDown()) return;
      const pending = deps.getPendingResumeTasks();
      if (pending.length === 0) return;
      deps.onPendingResumeTasks(pending);
    }, resumeDebounceMs);
  };

  const clearTimers = (): void => {
    if (scheduleQueuedTimer) {
      timers.clearTimeout(scheduleQueuedTimer);
      scheduleQueuedTimer = null;
    }
    if (scheduleResumeTimer) {
      timers.clearTimeout(scheduleResumeTimer);
      scheduleResumeTimer = null;
    }
  };

  return { scheduleQueuedTasksSoon, scheduleResumeTasksSoon, clearTimers };
}
