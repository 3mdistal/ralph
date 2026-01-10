#!/usr/bin/env bun
/**
 * Ralph Loop - Autonomous Coding Task Orchestrator
 *
 * Watches the bwrb queue for agent-tasks and dispatches them to OpenCode agents.
 * Processes tasks in parallel across repos, and within a repo when configured.
 * Creates rollup PRs after N successful merges for batch review.
 */

import { getRepoMaxWorkers, getRepoPath, loadConfig } from "./config";
import {
  initialPoll,
  startWatching,
  stopWatching,
  groupByRepo,
  getQueuedTasks,
  getTasksByStatus,
  updateTaskStatus,
  type AgentTask,
} from "./queue";
import { RepoWorker, type AgentRun } from "./worker";
import { RollupMonitor } from "./rollup";
import { Semaphore } from "./semaphore";

// --- State ---

const workers = new Map<string, RepoWorker>();
let rollupMonitor: RollupMonitor | null = null;
let isShuttingDown = false;

let globalSemaphore: Semaphore | null = null;
const repoSemaphores = new Map<string, Semaphore>();

let rrCursor = 0;

function ensureSemaphores(): void {
  if (globalSemaphore) return;
  const config = loadConfig();
  globalSemaphore = new Semaphore(config.maxWorkers);
}

function getRepoSemaphore(repo: string): Semaphore {
  let sem = repoSemaphores.get(repo);
  if (!sem) {
    sem = new Semaphore(getRepoMaxWorkers(repo));
    repoSemaphores.set(repo, sem);
  }
  return sem;
}

function getOrCreateWorker(repo: string): RepoWorker {
  let worker = workers.get(repo);
  if (worker) return worker;

  const repoPath = getRepoPath(repo);
  worker = new RepoWorker(repo, repoPath);
  workers.set(repo, worker);
  console.log(`[ralph] Created worker for ${repo} -> ${repoPath}`);
  return worker;
}

let scheduleQueuedTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleQueuedTasksSoon(): void {
  if (scheduleQueuedTimer) return;
  scheduleQueuedTimer = setTimeout(async () => {
    scheduleQueuedTimer = null;
    if (isShuttingDown) return;
    const tasks = await getQueuedTasks();
    await processNewTasks(tasks);
  }, 250);
}

function getTaskKey(task: Pick<AgentTask, "_path" | "name">): string {
  return task._path || task.name;
}

// Track in-flight tasks to avoid double-processing
const inFlightTasks = new Set<string>();

function startTask(opts: {
  repo: string;
  task: AgentTask;
  releaseGlobal: () => void;
  releaseRepo: () => void;
}): void {
  const { repo, task, releaseGlobal, releaseRepo } = opts;
  const key = getTaskKey(task);

  inFlightTasks.add(key);

  void getOrCreateWorker(repo)
    .processTask(task)
    .then(async (run: AgentRun) => {
      if (run.outcome === "success" && run.pr && rollupMonitor) {
        await rollupMonitor.recordMerge(repo, run.pr);
      }
    })
    .catch((e) => {
      console.error(`[ralph] Error processing task ${task.name}:`, e);
    })
    .finally(() => {
      inFlightTasks.delete(key);
      releaseGlobal();
      releaseRepo();
      if (!isShuttingDown) scheduleQueuedTasksSoon();
    });
}

async function processNewTasks(tasks: AgentTask[]): Promise<void> {
  ensureSemaphores();
  if (!globalSemaphore) return;

  // Filter out tasks already being processed
  const newTasks = tasks.filter((t) => !inFlightTasks.has(getTaskKey(t)));
  if (newTasks.length === 0) return;

  const byRepo = groupByRepo(newTasks);
  const repos = Array.from(byRepo.keys());
  if (repos.length === 0) return;

  let startedCount = 0;

  // Round-robin across repos while global capacity remains.
  while (globalSemaphore.available() > 0) {
    let startedThisRound = false;

    for (let i = 0; i < repos.length; i++) {
      const idx = (rrCursor + i) % repos.length;
      const repo = repos[idx];
      const repoTasks = byRepo.get(repo);
      if (!repoTasks || repoTasks.length === 0) continue;

      const repoSemaphore = getRepoSemaphore(repo);
      const releaseRepo = repoSemaphore.tryAcquire();
      if (!releaseRepo) continue;

      const releaseGlobal = globalSemaphore.tryAcquire();
      if (!releaseGlobal) {
        releaseRepo();
        return;
      }

      const task = repoTasks.shift()!;
      rrCursor = (idx + 1) % repos.length;

      startedCount++;
      startedThisRound = true;
      startTask({ repo, task, releaseGlobal, releaseRepo });
      break;
    }

    if (!startedThisRound) break;
  }

  if (startedCount > 0) {
    console.log(`[ralph] Started ${startedCount} task(s)`);
  }
}

async function resumeTasksOnStartup(opts: { awaitCompletion: boolean }): Promise<void> {
  ensureSemaphores();
  if (!globalSemaphore) return;

  const inProgress = await getTasksByStatus("in-progress");
  if (inProgress.length === 0) return;

  console.log(`[ralph] Found ${inProgress.length} in-progress task(s) on startup`);

  const withoutSession = inProgress.filter((t) => !(t["session-id"]?.trim()));
  for (const task of withoutSession) {
    console.warn(`[ralph] In-progress task has no session ID, resetting to queued: ${task.name}`);
    await updateTaskStatus(task, "queued", { "session-id": "" });
  }

  const withSession = inProgress.filter((t) => t["session-id"]?.trim());
  if (withSession.length === 0) return;

  const config = loadConfig();
  const globalLimit = config.maxWorkers;

  const byRepo = groupByRepo(withSession);
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

      const limit = getRepoMaxWorkers(repo);
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
    await updateTaskStatus(task, "queued", { "session-id": "" });
  }

  if (toResume.length === 0) return;

  const promises: Promise<void>[] = [];

  for (const task of toResume) {
    const repo = task.repo;
    const repoSemaphore = getRepoSemaphore(repo);
    const releaseRepo = repoSemaphore.tryAcquire();
    if (!releaseRepo) {
      console.warn(`[ralph] Repo concurrency limit reached unexpectedly; skipping resume: ${task.name}`);
      continue;
    }

    const releaseGlobal = globalSemaphore.tryAcquire();
    if (!releaseGlobal) {
      releaseRepo();
      console.warn(`[ralph] Global concurrency limit reached unexpectedly; skipping resume: ${task.name}`);
      continue;
    }

    const key = getTaskKey(task);
    inFlightTasks.add(key);

    const promise = getOrCreateWorker(repo)
      .resumeTask(task)
      .then(() => {
        // resumeTask returns an AgentRun; ignore it here
      })
      .catch((e: any) => {
        console.error(`[ralph] Error resuming task ${task.name}:`, e);
      })
      .finally(() => {
        inFlightTasks.delete(key);
        releaseGlobal();
        releaseRepo();
        if (!isShuttingDown) scheduleQueuedTasksSoon();
      });

    promises.push(promise);
  }

  if (opts.awaitCompletion) {
    await Promise.allSettled(promises);
  }
}

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║         Ralph Loop Orchestrator            ║");
  console.log("║     Autonomous Coding Task Processor       ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log("");

  // Load config
  const config = loadConfig();
  ensureSemaphores();

  console.log("[ralph] Configuration:");
  console.log(`        Vault: ${config.bwrbVault}`);
  console.log(`        Max workers: ${config.maxWorkers}`);
  console.log(`        Batch size: ${config.batchSize} PRs before rollup`);
  console.log(`        Dev directory: ${config.devDir}`);
  console.log("");

  // Initialize rollup monitor
  rollupMonitor = new RollupMonitor(config.batchSize);

  // Resume orphaned tasks from previous daemon runs
  await resumeTasksOnStartup({ awaitCompletion: false });

  // Do initial poll on startup
  console.log("[ralph] Running initial poll...");
  const initialTasks = await initialPoll();
  console.log(`[ralph] Found ${initialTasks.length} queued task(s)`);

  if (initialTasks.length > 0) {
    await processNewTasks(initialTasks);
  }

  // Start file watching (no polling - watcher is reliable)
  console.log("[ralph] Starting queue watcher...");
  startWatching(async (tasks) => {
    if (!isShuttingDown) {
      await processNewTasks(tasks);
    }
  });

  console.log("");
  console.log("[ralph] Daemon running. Watching for queue changes...");
  console.log("[ralph] Press Ctrl+C to stop.");
  console.log("");

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("");
    console.log(`[ralph] Received ${signal}, shutting down...`);

    // Stop accepting new tasks
    stopWatching();

    // Wait for in-flight tasks
    if (inFlightTasks.size > 0) {
      console.log(`[ralph] Waiting for ${inFlightTasks.size} in-flight task(s)...`);

      // Give tasks up to 60 seconds to complete
      const deadline = Date.now() + 60000;
      while (inFlightTasks.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (inFlightTasks.size > 0) {
        console.log(`[ralph] ${inFlightTasks.size} task(s) still running after timeout`);
      }
    }

    if (rollupMonitor) {
      const status = rollupMonitor.getStatus();
      for (const [repo, { count }] of status) {
        if (count > 0) {
          console.log(`[ralph] ${count} unrolled PR(s) for ${repo}`);
        }
      }
    }

    console.log("[ralph] Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// --- CLI Commands ---

const args = process.argv.slice(2);

if (args[0] === "resume") {
  // Resume any orphaned in-progress tasks and exit
  await resumeTasksOnStartup({ awaitCompletion: true });
  process.exit(0);
}

if (args[0] === "status") {
  // Quick status check
  const tasks = await getQueuedTasks();
  console.log(`Queued tasks: ${tasks.length}`);
  for (const task of tasks) {
    console.log(`  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}]`);
  }
  process.exit(0);
}

if (args[0] === "rollup") {
  // Force rollup for a repo
  const repo = args[1];
  if (!repo) {
    console.error("Usage: ralph rollup <repo>");
    process.exit(1);
  }

  // Note: This won't work well since we don't persist merge counts
  // For now, just create a PR from current bot/integration state
  console.log(`Force rollup not yet implemented. Use 'gh pr create --base main --head bot/integration' manually.`);
  process.exit(0);
}

// Default: run daemon
main().catch((e) => {
  console.error("[ralph] Fatal error:", e);
  process.exit(1);
});
