#!/usr/bin/env bun
/**
 * Ralph Loop - Autonomous Coding Task Orchestrator
 * 
 * Watches the bwrb queue for agent-tasks and dispatches them to OpenCode agents.
 * Processes tasks in parallel across repos, sequentially within each repo.
 * Creates rollup PRs after N successful merges for batch review.
 */

import { loadConfig } from "./config";
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
import { getRepoPath } from "./config";
import { DrainMonitor, isDraining, type DaemonMode } from "./drain";

// --- State ---

const workers = new Map<string, RepoWorker>();
let rollupMonitor: RollupMonitor;
let isShuttingDown = false;
let drainMonitor: DrainMonitor | null = null;

function getDaemonMode(): DaemonMode {
  if (drainMonitor) return drainMonitor.getMode();
  return isDraining() ? "draining" : "running";
}

function getTaskKey(task: Pick<AgentTask, "_path" | "name">): string {
  return task._path || task.name;
}

// Track in-flight tasks to avoid double-processing
const inFlightTasks = new Set<string>();

// --- Main Logic ---

async function processNewTasks(tasks: AgentTask[]): Promise<void> {
  if (getDaemonMode() === "draining") {
    return;
  }

  if (tasks.length === 0) {
    console.log("[ralph] No queued tasks");
    return;
  }
  
  // Filter out tasks already being processed
  const newTasks = tasks.filter(t => !inFlightTasks.has(getTaskKey(t)));
  if (newTasks.length === 0) {
    console.log("[ralph] All queued tasks already in flight");
    return;
  }
  
  console.log(`[ralph] Processing ${newTasks.length} new task(s)...`);
  
  const byRepo = groupByRepo(newTasks);
  const promises: Promise<void>[] = [];
  
  // Process in parallel across repos
  for (const [repo, repoTasks] of byRepo) {
    // Get or create worker for this repo
    let worker = workers.get(repo);
    if (!worker) {
      const repoPath = getRepoPath(repo);
      worker = new RepoWorker(repo, repoPath);
      workers.set(repo, worker);
      console.log(`[ralph] Created worker for ${repo} -> ${repoPath}`);
    }
    
    // Skip if worker is busy
    if (worker.busy) {
      console.log(`[ralph] Worker for ${repo} is busy, skipping`);
      continue;
    }
    
    // Process first task (highest priority due to sorting)
    const task = repoTasks[0];
    inFlightTasks.add(getTaskKey(task));
    
    promises.push(
      worker.processTask(task)
        .then(async (run: AgentRun) => {
          // Record successful merges for rollup
          if (run.outcome === "success" && run.pr) {
            await rollupMonitor.recordMerge(repo, run.pr);
          }
          
          // After completing a task, check if there are more queued tasks
          if (!isShuttingDown) {
            const moreTasks = await getQueuedTasks();
            const repoTasksRemaining = moreTasks.filter(t => t.repo === repo);
            if (repoTasksRemaining.length > 0) {
              console.log(`[ralph] ${repoTasksRemaining.length} more task(s) queued for ${repo}`);
              // Process will be picked up on next queue change or poll
            }
          }
        })
        .catch((e) => {
          console.error(`[ralph] Error processing task ${task.name}:`, e);
        })
        .finally(() => {
          inFlightTasks.delete(getTaskKey(task));
        })
    );
  }
  
  // Wait for all tasks to start (not complete - they run in background)
  await Promise.allSettled(promises);
}

async function resumeTasksOnStartup(): Promise<void> {
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

  const byRepo = groupByRepo(withSession);
  const promises: Promise<void>[] = [];

  for (const [repo, repoTasks] of byRepo) {
    const task = repoTasks[0];

    // If multiple tasks are marked in-progress for the same repo, only resume one.
    for (const extra of repoTasks.slice(1)) {
      console.warn(`[ralph] Multiple in-progress tasks for ${repo}; resetting to queued: ${extra.name}`);
      await updateTaskStatus(extra, "queued", { "session-id": "" });
    }


    let worker = workers.get(repo);
    if (!worker) {
      const repoPath = getRepoPath(repo);
      worker = new RepoWorker(repo, repoPath);
      workers.set(repo, worker);
      console.log(`[ralph] Created worker for ${repo} -> ${repoPath}`);
    }

    if (worker.busy) {
      console.log(`[ralph] Worker for ${repo} is busy, skipping resume`);
      continue;
    }

    inFlightTasks.add(getTaskKey(task));

    promises.push(
      worker
        .resumeTask(task)
        .then(() => {
          // resumeTask returns an AgentRun; ignore it here
        })
        .catch((e: any) => {
          console.error(`[ralph] Error resuming task ${task.name}:`, e);
        })
        .finally(() => {
          inFlightTasks.delete(getTaskKey(task));
        })
    );

  }

  await Promise.allSettled(promises);
}

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║         Ralph Loop Orchestrator            ║");
  console.log("║     Autonomous Coding Task Processor       ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log("");

  // Load config
  const config = loadConfig();
  console.log("[ralph] Configuration:");
  console.log(`        Vault: ${config.bwrbVault}`);
  console.log(`        Batch size: ${config.batchSize} PRs before rollup`);
  console.log(`        Dev directory: ${config.devDir}`);
  console.log("");

  // Start drain monitor (operator control file)
  drainMonitor = new DrainMonitor({ log: (message) => console.log(message) });
  drainMonitor.start();

  // Initialize rollup monitor
  rollupMonitor = new RollupMonitor(config.batchSize);

  // Resume orphaned tasks from previous daemon runs
  await resumeTasksOnStartup();

  // Do initial poll on startup
  console.log("[ralph] Running initial poll...");
  const initialTasks = await initialPoll();
  console.log(`[ralph] Found ${initialTasks.length} queued task(s)`);

  if (initialTasks.length > 0 && getDaemonMode() !== "draining") {
    await processNewTasks(initialTasks);
  }

  // Start file watching (no polling - watcher is reliable)
  console.log("[ralph] Starting queue watcher...");
  startWatching(async (tasks) => {
    if (!isShuttingDown && getDaemonMode() !== "draining") {
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
    drainMonitor?.stop();
    
    // Wait for in-flight tasks
    if (inFlightTasks.size > 0) {
      console.log(`[ralph] Waiting for ${inFlightTasks.size} in-flight task(s)...`);
      
      // Give tasks up to 60 seconds to complete
      const deadline = Date.now() + 60000;
      while (inFlightTasks.size > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (inFlightTasks.size > 0) {
        console.log(`[ralph] ${inFlightTasks.size} task(s) still running after timeout`);
      }
    }
    
    // Check if any repos need a forced rollup
    const status = rollupMonitor.getStatus();
    for (const [repo, { count }] of status) {
      if (count > 0) {
        console.log(`[ralph] ${count} unrolled PR(s) for ${repo}`);
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
  await resumeTasksOnStartup();
  process.exit(0);
}

if (args[0] === "status") {
  // Quick status check
  const mode: DaemonMode = isDraining() ? "draining" : "running";
  console.log(`Mode: ${mode}`);

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

  const monitor = new RollupMonitor();
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

