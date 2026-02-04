import type { AgentTask } from "../queue-backend";
import type { DashboardEventContext } from "../dashboard/publisher";

export function buildDashboardContext(params: {
  task: AgentTask;
  repo: string;
  runId?: string | null;
}): DashboardEventContext {
  const taskId = params.task._path || params.task._name || params.task.name || undefined;
  const workerId = params.task["worker-id"]?.trim() || (taskId ? `${params.repo}#${taskId}` : undefined);
  const sessionId = params.task["session-id"]?.trim() || undefined;
  return {
    runId: params.runId ?? undefined,
    workerId,
    repo: params.repo,
    taskId,
    sessionId,
  };
}

export function resolveDashboardContext(
  active: DashboardEventContext | null | undefined,
  overrides?: Partial<DashboardEventContext>
): DashboardEventContext | Partial<DashboardEventContext> | undefined {
  return active ? { ...active, ...overrides } : overrides;
}
