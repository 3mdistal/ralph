import { watch } from "fs";
import { join } from "path";
import { $ } from "bun";
import { loadConfig } from "./config";
import { shouldLog } from "./logging";

export interface AgentTask {
  _path: string;
  _name: string;
  type: "agent-task";
  "creation-date": string;
  scope: string;
  issue: string;
  repo: string;
  status: "queued" | "in-progress" | "blocked" | "escalated" | "done";
  priority?: string;
  name: string;
  run?: string;
  "assigned-at"?: string;
  "completed-at"?: string;
  /** OpenCode session ID used to resume after restarts */
  "session-id"?: string;
  /** Git worktree path for this task (for per-repo concurrency + resume) */
  "worktree-path"?: string;
  /** Watchdog recovery attempts (string in frontmatter) */
  "watchdog-retries"?: string;
}

export type QueueChangeHandler = (tasks: AgentTask[]) => void;

let watcher: ReturnType<typeof watch> | null = null;
let changeHandlers: QueueChangeHandler[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getTaskQuery(task: Pick<AgentTask, "_path" | "name"> | string): string {
  if (typeof task === "string") return task;
  return task._path || task.name;
}

/**
 * Get all queued tasks from bwrb
 */
export async function getQueuedTasks(): Promise<AgentTask[]> {
  const config = loadConfig();

  try {
    const result = await $`bwrb list agent-task --where "status == 'queued'" --output json`
      .cwd(config.bwrbVault)
      .quiet();
    return JSON.parse(result.stdout.toString());
  } catch (e) {
    console.error("[ralph:queue] Failed to get queued tasks:", e);
    return [];
  }
}

/**
 * Get tasks by status
 */
export async function getTasksByStatus(status: AgentTask["status"]): Promise<AgentTask[]> {
  const config = loadConfig();

  try {
    const result = await $`bwrb list agent-task --where "status == '${status}'" --output json`
      .cwd(config.bwrbVault)
      .quiet();
    return JSON.parse(result.stdout.toString());
  } catch (e) {
    console.error(`[ralph:queue] Failed to get ${status} tasks:`, e);
    return [];
  }
}

/**
 * Fetch a task by its exact bwrb `_path`.
 */
export async function getTaskByPath(taskPath: string): Promise<AgentTask | null> {
  const config = loadConfig();

  try {
    const result = await $`bwrb list agent-task --where "_path == '${taskPath}'" --output json`
      .cwd(config.bwrbVault)
      .quiet();
    const parsed = JSON.parse(result.stdout.toString());
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed[0] as AgentTask) : null;
  } catch (e) {
    console.error(`[ralph:queue] Failed to get task by path ${taskPath}:`, e);
    return null;
  }
}

/**
 * Update a task's status.
 *
 * IMPORTANT: task titles are not globally unique in the vault.
 * Prefer passing the task object with `_path` for exact matching.
 */
export async function updateTaskStatus(
  task: Pick<AgentTask, "_path" | "name"> | string,
  status: AgentTask["status"],
  extraFields?: Record<string, string>
): Promise<boolean> {
  const config = loadConfig();
  const json = JSON.stringify({ status, ...extraFields });

  // If we have the exact path, use it directly (most reliable)
  const exactPath = typeof task === "object" ? task._path : null;

  try {
    if (exactPath) {
      // Use --path for exact file match - no ambiguity
      await $`bwrb edit --path ${exactPath} --json ${json}`
        .cwd(config.bwrbVault)
        .quiet();
    } else {
      // Fallback to name search (less reliable)
      const query = typeof task === "string" ? task : task.name;
      await $`bwrb edit --picker none -t agent-task --path "orchestration/tasks/**" ${query} --json ${json}`
        .cwd(config.bwrbVault)
        .quiet();
    }

    return true;
  } catch (e) {
    const identifier = exactPath || (typeof task === "string" ? task : task.name);
    console.error(`[ralph:queue] Failed to update task ${identifier}:`, e);
    return false;
  }
}

/**
 * Group tasks by repo for parallel processing
 */
export function groupByRepo(tasks: AgentTask[]): Map<string, AgentTask[]> {
  const grouped = new Map<string, AgentTask[]>();

  for (const task of tasks) {
    const repo = task.repo;
    if (!grouped.has(repo)) grouped.set(repo, []);
    grouped.get(repo)!.push(task);
  }

  for (const [repo, repoTasks] of grouped) {
    repoTasks.sort((a, b) => {
      const priorityOrder = ["p0-critical", "p1-high", "p2-medium", "p3-low", "p4-backlog"];
      const aIdx = priorityOrder.indexOf(a.priority ?? "p2-medium");
      const bIdx = priorityOrder.indexOf(b.priority ?? "p2-medium");
      return aIdx - bIdx;
    });

    grouped.set(repo, repoTasks);
  }

  return grouped;
}

/**
 * Start watching the queue directory for changes
 */
export function startWatching(onChange: QueueChangeHandler): void {
  changeHandlers.push(onChange);
  if (watcher) return;

  const config = loadConfig();
  const tasksDir = join(config.bwrbVault, "orchestration/tasks");

  console.log(`[ralph:queue] Watching ${tasksDir} for changes`);

  watcher = watch(tasksDir, { recursive: true }, async (eventType: string, filename: string | null) => {
    if (!filename || !filename.endsWith(".md")) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (shouldLog("queue:change", 2_000)) {
        console.log(`[ralph:queue] Change detected: ${eventType} ${filename}`);
      }
      const tasks = await getQueuedTasks();
      for (const handler of changeHandlers) handler(tasks);
    }, 500);
  });
}

/**
 * Stop watching
 */
export function stopWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  changeHandlers = [];

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Do an initial poll (for daemon startup)
 */
export async function initialPoll(): Promise<AgentTask[]> {
  console.log("[ralph:queue] Initial poll...");
  return await getQueuedTasks();
}
