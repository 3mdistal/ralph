import type { AgentTask } from "../queue-backend";

export function applyTaskPatch(task: AgentTask, status: AgentTask["status"], patch: Record<string, string | number>): void {
  task.status = status;
  for (const [key, value] of Object.entries(patch)) {
    (task as unknown as Record<string, unknown>)[key] = typeof value === "number" ? String(value) : value;
  }
}
