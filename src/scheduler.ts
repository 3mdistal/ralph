import { Semaphore } from "./semaphore";
import type { DaemonMode } from "./drain";
import type { AgentTask } from "./queue";
import type { AgentRun } from "./worker";

export function getTaskKey(task: Pick<AgentTask, "_path" | "name">): string {
  return task._path || task.name;
}

export type Timers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export type RepoWorkerLike = {
  processTask: (task: AgentTask) => Promise<AgentRun>;
  resumeTask: (task: AgentTask, opts?: { resumeMessage?: string }) => Promise<AgentRun>;
};

export type SchedulerDeps = {
  timers: Timers;

  getDaemonMode: () => DaemonMode;
  isShuttingDown: () => boolean;

  concurrency: {
    getGlobalLimit: () => number;
    getRepoLimit: (repo: string) => number;
  };

  queue: {
    getQueuedTasks: () => Promise<AgentTask[]>;
    getTasksByStatus: (status: AgentTask["status"]) => Promise<AgentTask[]>;
    getTaskByPath: (taskPath: string) => Promise<AgentTask | null>;
    updateTaskStatus: (
      task: AgentTask,
      status: AgentTask["status"],
      fields?: Record<string, string>
    ) => Promise<boolean>;
    groupByRepo: (tasks: AgentTask[]) => Map<string, AgentTask[]>;
  };

  workers: {
    getOrCreateWorker: (repo: string) => RepoWorkerLike;
  };

  rollup: {
    recordMerge: (repo: string, prUrl: string) => Promise<void>;
  };

  escalations: {
    getEscalationsByStatus: (status: string) => Promise<any[]>;
    editEscalation: (path: string, fields: Record<string, string>) => Promise<void>;
    readResolutionMessage: (path: string) => Promise<string | null>;

    buildWaitingResolutionUpdate: (nowIso: string, reason: string) => Record<string, string>;
    shouldDeferWaitingResolutionCheck: (escalation: any, nowMs: number, intervalMs: number) => boolean;
    resolutionRecheckIntervalMs: number;
  };

  logging: {
    shouldLog: (key: string, intervalMs: number) => boolean;
  };
};

export class Scheduler {
  private readonly deps: SchedulerDeps;

  private scheduleQueuedTimer: ReturnType<typeof setTimeout> | null = null;

  private globalSemaphore: Semaphore | null = null;
  private readonly repoSemaphores = new Map<string, Semaphore>();
  private rrCursor = 0;

  private readonly inFlightTasks = new Set<string>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  getInFlightSize(): number {
    return this.inFlightTasks.size;
  }

  private ensureSemaphores(): void {
    if (this.globalSemaphore) return;
    this.globalSemaphore = new Semaphore(this.deps.concurrency.getGlobalLimit());
  }

  private getRepoSemaphore(repo: string): Semaphore {
    let sem = this.repoSemaphores.get(repo);
    if (!sem) {
      sem = new Semaphore(this.deps.concurrency.getRepoLimit(repo));
      this.repoSemaphores.set(repo, sem);
    }
    return sem;
  }

  scheduleQueuedTasksSoon(): void {
    if (this.scheduleQueuedTimer) return;

    this.scheduleQueuedTimer = this.deps.timers.setTimeout(() => {
      this.scheduleQueuedTimer = null;
      if (this.deps.isShuttingDown()) return;
      if (this.deps.getDaemonMode() === "draining") return;

      void this.deps.queue.getQueuedTasks().then((tasks) => this.processNewTasks(tasks));
    }, 250);
  }

  async attemptResumeResolvedEscalations(): Promise<void> {
    if (this.deps.isShuttingDown()) return;

    this.ensureSemaphores();
    if (!this.globalSemaphore) return;

    const resolved = await this.deps.escalations.getEscalationsByStatus("resolved");
    if (resolved.length === 0) return;

    const pending = resolved.filter((e) => !(e["resume-attempted-at"]?.trim()));
    if (pending.length === 0) return;

    for (const escalation of pending) {
      if (this.deps.isShuttingDown()) return;

      const taskPath = escalation["task-path"]?.trim() ?? "";
      const sessionId = escalation["session-id"]?.trim() ?? "";
      const repo = escalation.repo?.trim() ?? "";

      if (!taskPath || !sessionId || !repo) {
        const reason = `Missing required fields (task-path='${taskPath}', session-id='${sessionId}', repo='${repo}')`;
        console.warn(`[ralph:escalations] Resolved escalation invalid; ${reason}: ${escalation._path}`);

        await this.deps.escalations.editEscalation(escalation._path, {
          "resume-status": "failed",
          "resume-attempted-at": new Date().toISOString(),
          "resume-error": reason,
        });

        continue;
      }

      const worker = this.deps.workers.getOrCreateWorker(repo);

      const task = await this.deps.queue.getTaskByPath(taskPath);
      if (!task) {
        console.warn(`[ralph:escalations] Resolved escalation references missing task; skipping: ${taskPath}`);
        await this.deps.escalations.editEscalation(escalation._path, {
          "resume-status": "failed",
          "resume-attempted-at": new Date().toISOString(),
          "resume-error": `Task not found: ${taskPath}`,
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      if (
        this.deps.escalations.shouldDeferWaitingResolutionCheck(
          escalation,
          Date.now(),
          this.deps.escalations.resolutionRecheckIntervalMs
        )
      ) {
        continue;
      }

      const resolution = await this.deps.escalations.readResolutionMessage(escalation._path);
      if (!resolution) {
        const reason = "Resolved escalation has empty/missing ## Resolution text";
        console.warn(`[ralph:escalations] ${reason}; skipping: ${escalation._path}`);

        await this.deps.escalations.editEscalation(
          escalation._path,
          this.deps.escalations.buildWaitingResolutionUpdate(nowIso, reason)
        );

        continue;
      }

      const taskKey = getTaskKey(task);
      if (this.inFlightTasks.has(taskKey)) continue;

      const releaseGlobal = this.globalSemaphore.tryAcquire();
      if (!releaseGlobal) {
        if (escalation["resume-status"]?.trim() !== "deferred") {
          await this.deps.escalations.editEscalation(escalation._path, {
            "resume-status": "deferred",
            "resume-deferred-at": new Date().toISOString(),
            "resume-error": "Global concurrency limit reached; will retry",
          });
        }
        continue;
      }

      const releaseRepo = this.getRepoSemaphore(repo).tryAcquire();
      if (!releaseRepo) {
        releaseGlobal();
        if (escalation["resume-status"]?.trim() !== "deferred") {
          await this.deps.escalations.editEscalation(escalation._path, {
            "resume-status": "deferred",
            "resume-deferred-at": new Date().toISOString(),
            "resume-error": "Repo concurrency limit reached; will retry",
          });
        }
        continue;
      }

      // Ensure the task is resumable and marked in-progress.
      await this.deps.queue.updateTaskStatus(task, "in-progress", {
        "assigned-at": new Date().toISOString().split("T")[0],
        "session-id": sessionId,
      });

      const resumeMessage = [
        "Escalation resolved. Resume the existing OpenCode session from where you left off.",
        "Apply the human guidance below. Do NOT restart from scratch unless strictly necessary.",
        "",
        "Human guidance:",
        resolution,
      ].join("\n");

      // Mark as attempted before resuming to avoid duplicate resumes.
      await this.deps.escalations.editEscalation(escalation._path, {
        "resume-status": "attempting",
        "resume-attempted-at": new Date().toISOString(),
        "resume-error": "",
      });

      this.inFlightTasks.add(taskKey);

      worker
        .resumeTask(task, { resumeMessage })
        .then(async (run) => {
          if (run.outcome === "success") {
            if (run.pr) {
              await this.deps.rollup.recordMerge(repo, run.pr);
            }

            await this.deps.escalations.editEscalation(escalation._path, {
              "resume-status": "succeeded",
              "resume-error": "",
            });

            return;
          }

          const reason =
            run.escalationReason ?? (run.outcome === "escalated" ? "Resumed session escalated" : "Resume failed");

          await this.deps.escalations.editEscalation(escalation._path, {
            "resume-status": "failed",
            "resume-error": reason,
          });
        })
        .catch(async (e: any) => {
          await this.deps.escalations.editEscalation(escalation._path, {
            "resume-status": "failed",
            "resume-error": e?.message ?? String(e),
          });
        })
        .finally(() => {
          this.inFlightTasks.delete(taskKey);
          releaseGlobal();
          releaseRepo();
          if (!this.deps.isShuttingDown()) this.scheduleQueuedTasksSoon();
        });
    }
  }

  private startTask(opts: {
    repo: string;
    task: AgentTask;
    releaseGlobal: () => void;
    releaseRepo: () => void;
  }): void {
    const { repo, task, releaseGlobal, releaseRepo } = opts;
    const key = getTaskKey(task);

    this.inFlightTasks.add(key);

    void this.deps.workers
      .getOrCreateWorker(repo)
      .processTask(task)
      .then(async (run: AgentRun) => {
        if (run.outcome === "success" && run.pr) {
          await this.deps.rollup.recordMerge(repo, run.pr);
        }
      })
      .catch((e) => {
        console.error(`[ralph] Error processing task ${task.name}:`, e);
      })
      .finally(() => {
        this.inFlightTasks.delete(key);
        releaseGlobal();
        releaseRepo();
        if (!this.deps.isShuttingDown()) this.scheduleQueuedTasksSoon();
      });
  }

  async processNewTasks(tasks: AgentTask[]): Promise<void> {
    this.ensureSemaphores();
    if (!this.globalSemaphore) return;

    if (this.deps.getDaemonMode() === "draining") return;

    if (tasks.length === 0) {
      if (this.deps.logging.shouldLog("daemon:no-queued", 30_000)) {
        console.log("[ralph] No queued tasks");
      }
      return;
    }

    const newTasks = tasks.filter((t) => !this.inFlightTasks.has(getTaskKey(t)));
    if (newTasks.length === 0) {
      if (this.deps.logging.shouldLog("daemon:all-in-flight", 30_000)) {
        console.log("[ralph] All queued tasks already in flight");
      }
      return;
    }

    const byRepo = this.deps.queue.groupByRepo(newTasks);
    const repos = Array.from(byRepo.keys());
    if (repos.length === 0) return;

    let startedCount = 0;

    while (this.globalSemaphore.available() > 0) {
      let startedThisRound = false;

      for (let i = 0; i < repos.length; i++) {
        const idx = (this.rrCursor + i) % repos.length;
        const repo = repos[idx];
        const repoTasks = byRepo.get(repo);
        if (!repoTasks || repoTasks.length === 0) continue;

        const releaseGlobal = this.globalSemaphore.tryAcquire();
        if (!releaseGlobal) return;

        const releaseRepo = this.getRepoSemaphore(repo).tryAcquire();
        if (!releaseRepo) {
          releaseGlobal();
          continue;
        }

        const task = repoTasks.shift()!;
        this.rrCursor = (idx + 1) % repos.length;

        startedCount++;
        startedThisRound = true;
        this.startTask({ repo, task, releaseGlobal, releaseRepo });
        break;
      }

      if (!startedThisRound) break;
    }

    if (startedCount > 0) {
      console.log(`[ralph] Started ${startedCount} task(s)`);
    }
  }

  async resumeTasksOnStartup(opts?: { awaitCompletion?: boolean }): Promise<void> {
    this.ensureSemaphores();
    if (!this.globalSemaphore) return;

    const awaitCompletion = opts?.awaitCompletion ?? true;

    const inProgress = await this.deps.queue.getTasksByStatus("in-progress");
    if (inProgress.length === 0) return;

    console.log(`[ralph] Found ${inProgress.length} in-progress task(s) on startup`);

    const withoutSession = inProgress.filter((t) => !(t["session-id"]?.trim()));
    for (const task of withoutSession) {
      console.warn(`[ralph] In-progress task has no session ID, resetting to queued: ${task.name}`);
      await this.deps.queue.updateTaskStatus(task, "queued", { "session-id": "" });
    }

    const withSession = inProgress.filter((t) => t["session-id"]?.trim());
    if (withSession.length === 0) return;

    const globalLimit = this.deps.concurrency.getGlobalLimit();

    const byRepo = this.deps.queue.groupByRepo(withSession);
    const repos = Array.from(byRepo.keys());
    const perRepoResumed = new Map<string, number>();

    const toResume: AgentTask[] = [];
    let cursor = 0;

    while (toResume.length < globalLimit) {
      let progressed = false;

      for (let i = 0; i < repos.length; i++) {
        const idx = (cursor + i) % repos.length;
        const repo = repos[idx];
        const repoTasks = byRepo.get(repo);
        if (!repoTasks || repoTasks.length === 0) continue;

        const limit = this.deps.concurrency.getRepoLimit(repo);
        const already = perRepoResumed.get(repo) ?? 0;
        if (already >= limit) continue;

        const task = repoTasks.shift()!;
        toResume.push(task);
        perRepoResumed.set(repo, already + 1);
        cursor = (idx + 1) % repos.length;
        progressed = true;
        break;
      }

      if (!progressed) break;
    }

    const toRequeue: AgentTask[] = [];
    for (const repo of repos) {
      const remaining = byRepo.get(repo) ?? [];
      for (const task of remaining) toRequeue.push(task);
    }

    for (const task of toRequeue) {
      console.warn(
        `[ralph] Concurrency limits exceeded on startup; resetting in-progress task to queued: ${task.name} (${task.repo})`
      );
      await this.deps.queue.updateTaskStatus(task, "queued", { "session-id": "" });
    }

    if (toResume.length === 0) return;

    const promises: Promise<void>[] = [];

    for (const task of toResume) {
      const repo = task.repo;

      const releaseGlobal = this.globalSemaphore.tryAcquire();
      if (!releaseGlobal) {
        console.warn(`[ralph] Global concurrency limit reached unexpectedly; skipping resume: ${task.name}`);
        continue;
      }

      const releaseRepo = this.getRepoSemaphore(repo).tryAcquire();
      if (!releaseRepo) {
        releaseGlobal();
        console.warn(`[ralph] Repo concurrency limit reached unexpectedly; skipping resume: ${task.name}`);
        continue;
      }

      const key = getTaskKey(task);
      this.inFlightTasks.add(key);

      const promise = this.deps.workers
        .getOrCreateWorker(repo)
        .resumeTask(task)
        .then(() => {
          // ignore
        })
        .catch((e: any) => {
          console.error(`[ralph] Error resuming task ${task.name}:`, e);
        })
        .finally(() => {
          this.inFlightTasks.delete(key);
          releaseGlobal();
          releaseRepo();
          if (!this.deps.isShuttingDown()) this.scheduleQueuedTasksSoon();
        });

      promises.push(promise);
    }

    if (awaitCompletion) {
      await Promise.allSettled(promises);
    }
  }
}
