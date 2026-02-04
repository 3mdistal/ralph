import type { AgentTask } from "../queue-backend";
import { ralphEventBus } from "../dashboard/bus";
import type { RalphEvent } from "../dashboard/events";
import { publishDashboardEvent as publishDashboardEventCore, type DashboardEventContext } from "../dashboard/publisher";

import { buildDashboardContext, resolveDashboardContext } from "./dashboard-context";

export type WorkerDashboardEventInput = Omit<RalphEvent, "ts"> & { ts?: string };

export class CheckpointEventDeduper {
  #seen = new Set<string>();
  #order: string[] = [];
  #limit: number;

  constructor(limit = 5000) {
    this.#limit = Math.max(0, Math.floor(limit));
  }

  hasEmitted(key: string): boolean {
    return this.#seen.has(key);
  }

  emit(event: RalphEvent, key: string): void {
    if (this.#seen.has(key)) return;
    ralphEventBus.publish(event);
    if (this.#limit === 0) return;
    this.#seen.add(key);
    this.#order.push(key);
    if (this.#order.length > this.#limit) {
      const oldest = this.#order.shift();
      if (oldest) this.#seen.delete(oldest);
    }
  }
}

export function buildWorkerDashboardContext(params: { repo: string }, task: AgentTask, runId?: string | null): DashboardEventContext {
  return buildDashboardContext({ task, repo: params.repo, runId });
}

export function publishWorkerDashboardEvent(
  params: { activeDashboardContext: DashboardEventContext | null },
  event: WorkerDashboardEventInput,
  overrides?: Partial<DashboardEventContext>
): void {
  const context = resolveDashboardContext(params.activeDashboardContext, overrides);
  publishDashboardEventCore(event, context);
}
