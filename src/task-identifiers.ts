import type { AgentTask } from "./queue-backend";

type TaskIdentity = Pick<AgentTask, "_path" | "_name" | "name" | "issue" | "repo">;

export function deriveTaskId(task: TaskIdentity): string | null {
  const path = task._path?.trim();
  if (path) return path;

  const issue = task.issue?.trim();
  if (issue) {
    const match = issue.match(/#(\d+)$/);
    if (match) return `issue:${match[1]}`;
  }

  const fallback = task._name?.trim() || task.name?.trim();
  return fallback ? fallback : null;
}

export function deriveWorkerId(task: TaskIdentity, taskIdOverride?: string | null): string | null {
  const taskId = taskIdOverride?.trim() || deriveTaskId(task);
  if (!taskId) return null;
  const repo = task.repo?.trim();
  if (!repo) return null;
  return `${repo}#${taskId}`;
}
