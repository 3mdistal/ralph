import { watch } from "fs";
import { join } from "path";
import { $ } from "bun";
import crypto from "crypto";
import { loadConfig } from "./config";
import { shouldLog } from "./logging";

type BwrbCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type BwrbProcess = {
  cwd: (path: string) => BwrbProcess;
  quiet: () => Promise<BwrbCommandResult>;
};

type BwrbRunner = (strings: TemplateStringsArray, ...values: unknown[]) => BwrbProcess;

const DEFAULT_BWRB_RUNNER: BwrbRunner = $ as unknown as BwrbRunner;

let bwrb: BwrbRunner = DEFAULT_BWRB_RUNNER;

export function __setBwrbRunnerForTests(runner: BwrbRunner): void {
  bwrb = runner;
}

export function __resetBwrbRunnerForTests(): void {
  bwrb = DEFAULT_BWRB_RUNNER;
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

export function normalizeBwrbNoteRef(value: string): string {
  // Defensive normalization: bwrb identifiers can include accidental whitespace/newlines.
  // Per issue #18, treat these as non-semantic.
  return value.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim();
}

function normalizeAgentTaskIdentity(task: AgentTask): AgentTask {
  const normalizedPath = normalizeBwrbNoteRef(task._path);
  const normalizedName = normalizeBwrbNoteRef(task._name);

  if (normalizedPath !== task._path || normalizedName !== task._name) {
    console.debug(
      `[ralph:queue] Normalized task identifiers (path ${task._path.length}->${normalizedPath.length}, name ${task._name.length}->${normalizedName.length})`
    );
  }

  return {
    ...task,
    _path: normalizedPath,
    _name: normalizedName,
  };
}

function extractBwrbErrorText(e: any): string {
  const parts: string[] = [];
  if (typeof e?.stdout?.toString === "function") parts.push(e.stdout.toString());
  if (typeof e?.stderr?.toString === "function") parts.push(e.stderr.toString());
  if (typeof e?.message === "string") parts.push(e.message);
  return parts.filter(Boolean).join("\n");
}

function tryParseBwrbJson(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

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
        typeof (row as { _path?: unknown })._path === "string" &&
        typeof (row as { _name?: unknown })._name === "string"
      );
    });

    const normalized = tasks.map((t) => normalizeAgentTaskIdentity(t));
    warnIfNestedTaskPaths(normalized);
    return normalized;
  } catch (e) {
    console.error(`[ralph:queue] Failed to list tasks under ${TASKS_GLOB_PATH}:`, e);
    return [];
  }
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
 * Fetch a task by its file path in the vault.
 */
export async function getTaskByPath(taskPath: string): Promise<AgentTask | null> {
  const normalizedPath = normalizeBwrbNoteRef(taskPath);
  const tasks = await listTasksInQueueDir();
  return tasks.find((t) => t._path === normalizedPath) ?? null;
}

/**
 * Resolve an agent-task note by stable identifier.
 *
 * Per issue #18, treat the GitHub issue string (owner/repo#N) as stable.
 */
export async function resolveAgentTaskByIssue(issue: string, repo?: string): Promise<AgentTask | null> {
  const normalizedIssue = issue.trim();
  const tasks = await listTasksInQueueDir();
  const matches = tasks.filter((t) => t.issue === normalizedIssue);
  if (matches.length === 0) return null;

  if (repo) {
    const exactRepo = matches.find((t) => t.repo === repo);
    if (exactRepo) return exactRepo;
  }

  matches.sort((a, b) => a._path.localeCompare(b._path));
  return matches[0] ?? null;
}

export async function createAgentTask(opts: {
  name: string;
  issue: string;
  repo: string;
  scope: string;
  status: AgentTask["status"];
  priority?: string;
}): Promise<{ taskPath: string; taskFileName: string } | null> {
  const config = loadConfig();
  const today = new Date().toISOString().split("T")[0];

  const runNew = async (name: string): Promise<{ success: boolean; path?: string; error?: string }> => {
    const json = JSON.stringify({
      name,
      issue: opts.issue,
      repo: opts.repo,
      scope: opts.scope,
      status: opts.status,
      "creation-date": today,
      ...(opts.priority ? { priority: opts.priority } : {}),
    });

    try {
      const result = await bwrb`bwrb new agent-task --json ${json}`.cwd(config.bwrbVault).quiet();
      return JSON.parse(result.stdout.toString());
    } catch (e: any) {
      const stdout = e?.stdout?.toString?.() ?? "";
      const parsed = tryParseBwrbJson(stdout);
      if (parsed && typeof parsed.success === "boolean") return parsed;
      return { success: false, error: extractBwrbErrorText(e) || e?.message || "Unknown error" };
    }
  };

  let output = await runNew(opts.name);
  if (!output.success && typeof output.error === "string" && output.error.includes("File already exists")) {
    const suffix = crypto.randomUUID().slice(0, 8);
    output = await runNew(`${opts.name} [${suffix}]`);
  }

  if (output.success && typeof output.path === "string") {
    const taskPath = normalizeBwrbNoteRef(output.path);
    const taskFileName = normalizeBwrbNoteRef(taskPath.split("/").pop()?.replace(/\.md$/i, "") ?? "");
    if (!taskFileName) return null;

    return { taskPath, taskFileName };
  }

  console.error(`[ralph:queue] Failed to create agent-task for ${opts.issue}:`, output.error ?? "Unknown error");
  return null;
}

/**
 * Update a task's status.
 *
 * IMPORTANT: task titles are not globally unique in the vault.
 * Prefer passing the task object with `_path` for exact matching.
 */
export async function updateTaskStatus(
  task: AgentTask | Pick<AgentTask, "_path" | "_name" | "name" | "issue" | "repo"> | string,
  status: AgentTask["status"],
  extraFields?: Record<string, string>
): Promise<boolean> {
  if (!VALID_TASK_STATUSES.has(status)) {
    console.error(`[ralph:queue] Invalid task status: ${String(status)}`);
    return false;
  }

  const config = loadConfig();
  const json = JSON.stringify({ status, ...extraFields });

  const taskObj: any = typeof task === "object" ? task : null;

  if (taskObj && typeof taskObj._path === "string") {
    taskObj._path = normalizeBwrbNoteRef(taskObj._path);
  }
  if (taskObj && typeof taskObj._name === "string") {
    taskObj._name = normalizeBwrbNoteRef(taskObj._name);
  }

  // If we have the exact path, use it directly (most reliable)
  const exactPath = taskObj && typeof taskObj._path === "string" ? (taskObj._path as string) : null;

  const editByPath = async (path: string) => {
    await bwrb`bwrb edit --path ${path} --json ${json}`.cwd(config.bwrbVault).quiet();
  };

  const editByQuery = async () => {
    const query = typeof task === "string" ? task : (task as any).name;
    await bwrb`bwrb edit --picker none -t agent-task --path ${TASKS_GLOB_PATH} ${query} --json ${json}`
      .cwd(config.bwrbVault)
      .quiet();
  };

  try {
    if (exactPath) {
      await editByPath(exactPath);
      return true;
    }

    await editByQuery();
    return true;
  } catch (e: any) {
    const identifier = exactPath || (typeof task === "string" ? task : (task as any).name);

    const stdout = e?.stdout?.toString?.() ?? "";
    const parsed = tryParseBwrbJson(stdout);
    const errorMessage: string =
      (typeof parsed?.error === "string" && parsed.error) ||
      extractBwrbErrorText(e) ||
      "Unknown error";

    const isNoNotesFound = /no notes found in vault/i.test(errorMessage);

    // Recovery: if the task note was renamed/moved, re-resolve by stable identifier and retry once.
    if (exactPath && isNoNotesFound && typeof taskObj?.issue === "string") {
      console.warn(
        `[ralph:queue] Task path missing in vault; re-resolving by issue (${taskObj.issue}) and retrying once...`
      );

      const resolved = await resolveAgentTaskByIssue(taskObj.issue, taskObj.repo);
      if (resolved) {
        const attemptedPath = exactPath;
        taskObj._path = resolved._path;
        taskObj._name = resolved._name;

        console.info(
          `[ralph:queue] Re-resolved task path for ${taskObj.issue}: ${attemptedPath} -> ${resolved._path}`
        );

        try {
          await editByPath(resolved._path);
          return true;
        } catch (e2: any) {
          const retryText = extractBwrbErrorText(e2);
          console.error(
            `[ralph:queue] Failed to update task after re-resolve (issue=${taskObj.issue}, path=${resolved._path}):`,
            retryText || e2
          );
          return false;
        }
      }

      console.error(
        `[ralph:queue] Failed to re-resolve task by issue (issue=${taskObj.issue}); cannot update status to ${status}`
      );
      return false;
    }

    console.error(`[ralph:queue] Failed to update task ${identifier}:`, errorMessage || e);
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
