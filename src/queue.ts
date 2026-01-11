import { watch } from "fs";
import { join } from "path";
import { $ } from "bun";
import crypto from "crypto";
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

function escapeWhereValue(value: string): string {
  // bwrb where clauses use single quotes in our usage.
  return value.replace(/'/g, "\\'");
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
    const parsed = JSON.parse(result.stdout.toString());
    return Array.isArray(parsed) ? parsed.map((t) => normalizeAgentTaskIdentity(t as AgentTask)) : [];
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
    const parsed = JSON.parse(result.stdout.toString());
    return Array.isArray(parsed) ? parsed.map((t) => normalizeAgentTaskIdentity(t as AgentTask)) : [];
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
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return normalizeAgentTaskIdentity(parsed[0] as AgentTask);
  } catch (e) {
    console.error(`[ralph:queue] Failed to get task by path ${taskPath}:`, e);
    return null;
  }
}

/**
 * Resolve an agent-task note by stable identifier.
 *
 * Per issue #18, treat the GitHub issue string (owner/repo#N) as stable.
 */
export async function resolveAgentTaskByIssue(issue: string, repo?: string): Promise<AgentTask | null> {
  const config = loadConfig();
  const issueValue = escapeWhereValue(issue);

  try {
    const result = await $`bwrb list agent-task --where "issue == '${issueValue}'" --output json`
      .cwd(config.bwrbVault)
      .quiet();

    const parsed = JSON.parse(result.stdout.toString());
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const tasks = parsed.map((t) => normalizeAgentTaskIdentity(t as AgentTask));
    if (repo) {
      const exactRepo = tasks.find((t) => t.repo === repo);
      if (exactRepo) return exactRepo;
    }

    tasks.sort((a, b) => a._path.localeCompare(b._path));
    return tasks[0] ?? null;
  } catch (e) {
    console.error(`[ralph:queue] Failed to resolve task by issue ${issue}:`, e);
    return null;
  }
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
      const result = await $`bwrb new agent-task --json ${json}`.cwd(config.bwrbVault).quiet();
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
    await $`bwrb edit --path ${path} --json ${json}`.cwd(config.bwrbVault).quiet();
  };

  try {
    if (exactPath) {
      await editByPath(exactPath);
      return true;
    }

    // Fallback to name search (less reliable)
    const query = typeof task === "string" ? task : (task as any).name;
    await $`bwrb edit --picker none -t agent-task --path "orchestration/tasks/**" ${query} --json ${json}`
      .cwd(config.bwrbVault)
      .quiet();

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
        } catch (e2) {
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
