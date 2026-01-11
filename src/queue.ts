import { watch } from "fs";
import { join } from "path";
import { $ } from "bun";
import { loadConfig } from "./config";
import { shouldLog } from "./logging";

type BwrbCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type BwrbProcess = {
  cwd: (path: string) => BwrbProcess;
  quiet: () => Promise<BwrbCommandResult>;
};

type BwrbRunner = (strings: TemplateStringsArray, ...values: unknown[]) => BwrbProcess;

let bwrb: BwrbRunner = $ as unknown as BwrbRunner;

export function __setBwrbRunnerForTests(runner: BwrbRunner): void {
  bwrb = runner;
}

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

const TASKS_GLOB_PATH = "orchestration/tasks/**";

function warnIfNestedTaskPaths(tasks: AgentTask[]): void {
  const nested = tasks
    .map((t) => t._path)
    .filter((p) => p.startsWith("orchestration/tasks/") && p.slice("orchestration/tasks/".length).includes("/"));

  if (nested.length === 0) return;

  if (shouldLog("queue:nested-tasks", 60_000)) {
    const examples = nested.slice(0, 3).join(", ");
    console.warn(
      `[ralph:queue] Detected ${nested.length} nested agent-task path(s) under ${TASKS_GLOB_PATH} (likely due to '/' in the note name). These are supported. Examples: ${examples}`
    );
  }
}

const VALID_TASK_STATUSES = new Set<AgentTask["status"]>([
  "queued",
  "in-progress",
  "blocked",
  "escalated",
  "done",
]);

async function listTasksInQueueDir(status?: AgentTask["status"]): Promise<AgentTask[]> {
  const config = loadConfig();

  const where = status
    ? `type == 'agent-task' && status == '${status}'`
    : "type == 'agent-task'";

  try {
    const result = await bwrb`bwrb list --path ${TASKS_GLOB_PATH} --where ${where} --output json`
      .cwd(config.bwrbVault)
      .quiet();

    const parsed = JSON.parse(result.stdout.toString());
    const rows = Array.isArray(parsed) ? parsed : [];

    const tasks = rows.filter((row): row is AgentTask => {
      return (
        typeof row === "object" &&
        row !== null &&
        (row as { type?: unknown }).type === "agent-task" &&
        typeof (row as { _path?: unknown })._path === "string"
      );
    });

    warnIfNestedTaskPaths(tasks);
    return tasks;
  } catch (e) {
    console.error(`[ralph:queue] Failed to list tasks under ${TASKS_GLOB_PATH}:`, e);
    return [];
  }
}

function getTaskQuery(task: Pick<AgentTask, "_path" | "name"> | string): string {
  if (typeof task === "string") return task;
  return task._path || task.name;
}

/**
 * Get all queued tasks from bwrb
 */
export async function getQueuedTasks(): Promise<AgentTask[]> {
  return await listTasksInQueueDir("queued");
}

/**
 * Get tasks by status
 */
export async function getTasksByStatus(status: AgentTask["status"]): Promise<AgentTask[]> {
  if (!VALID_TASK_STATUSES.has(status)) {
    console.error(`[ralph:queue] Invalid task status: ${String(status)}`);
    return [];
  }

  return await listTasksInQueueDir(status);
}

/**
 * Fetch a task by its exact bwrb `_path`.
 */
export async function getTaskByPath(taskPath: string): Promise<AgentTask | null> {
  const tasks = await listTasksInQueueDir();
  return tasks.find((t) => t._path === taskPath) ?? null;
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
      await bwrb`bwrb edit --path ${exactPath} --json ${json}`
        .cwd(config.bwrbVault)
        .quiet();
    } else {
      // Fallback to name search (less reliable)
      const query = typeof task === "string" ? task : task.name;
      await bwrb`bwrb edit --picker none -t agent-task --path "orchestration/tasks/**" ${query} --json ${json}`
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
