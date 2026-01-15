export type RalphEventLevel = "debug" | "info" | "warn" | "error";

export type RalphEventType =
  | "daemon.started"
  | "daemon.stopped"
  | "worker.created"
  | "worker.became_busy"
  | "worker.became_idle"
  | "task.assigned"
  | "task.status_changed"
  | "task.completed"
  | "task.escalated"
  | "task.blocked"
  | "worker.checkpoint.reached"
  | "worker.pause.requested"
  | "worker.pause.reached"
  | "worker.pause.cleared"
  | "worker.activity.updated"
  | "worker.anomaly.updated"
  | "worker.summary.updated"
  | "log.ralph"
  | "log.worker"
  | "log.opencode.event"
  | "log.opencode.text"
  | "error";

export type RalphCheckpoint =
  | "planned"
  | "routed"
  | "implementation_step_complete"
  | "pr_ready"
  | "merge_step_complete"
  | "survey_complete"
  | "recorded";

export type RalphEventEnvelope<TType extends RalphEventType, TData extends object> = {
  ts: string;
  type: TType;
  level: RalphEventLevel;
  workerId?: string;
  repo?: string;
  taskId?: string;
  sessionId?: string;
  data: TData;
};

export type RalphEvent =
  | RalphEventEnvelope<"daemon.started", { version?: string }>
  | RalphEventEnvelope<"daemon.stopped", { reason?: string; code?: number }>
  | RalphEventEnvelope<"worker.created", { worktreePath?: string; repoSlot?: number }>
  | RalphEventEnvelope<"worker.became_busy", { taskName?: string; issue?: string }>
  | RalphEventEnvelope<"worker.became_idle", { reason?: string }>
  | RalphEventEnvelope<"task.assigned", { taskName?: string; issue?: string }>
  | RalphEventEnvelope<"task.status_changed", { from?: string; to?: string }>
  | RalphEventEnvelope<"task.completed", { prUrl?: string }>
  | RalphEventEnvelope<"task.escalated", { reason?: string }>
  | RalphEventEnvelope<"task.blocked", { reason?: string }>
  | RalphEventEnvelope<"worker.checkpoint.reached", { checkpoint: RalphCheckpoint }>
  | RalphEventEnvelope<"worker.pause.requested", { reason?: string }>
  | RalphEventEnvelope<"worker.pause.reached", { checkpoint?: RalphCheckpoint }>
  | RalphEventEnvelope<"worker.pause.cleared", {}>
  | RalphEventEnvelope<"worker.activity.updated", { activity: string }>
  | RalphEventEnvelope<"worker.anomaly.updated", { total?: number; recentBurst?: boolean }>
  | RalphEventEnvelope<"worker.summary.updated", { text: string; confidence?: number; top_activities?: string[] }>
  | RalphEventEnvelope<"log.ralph", { message: string }>
  | RalphEventEnvelope<"log.worker", { message: string }>
  | RalphEventEnvelope<"log.opencode.event", { event: unknown }>
  | RalphEventEnvelope<"log.opencode.text", { text: string }>
  | RalphEventEnvelope<"error", { message: string; stack?: string; code?: string }>; 

const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "daemon.started",
  "daemon.stopped",
  "worker.created",
  "worker.became_busy",
  "worker.became_idle",
  "task.assigned",
  "task.status_changed",
  "task.completed",
  "task.escalated",
  "task.blocked",
  "worker.checkpoint.reached",
  "worker.pause.requested",
  "worker.pause.reached",
  "worker.pause.cleared",
  "worker.activity.updated",
  "worker.anomaly.updated",
  "worker.summary.updated",
  "log.ralph",
  "log.worker",
  "log.opencode.event",
  "log.opencode.text",
  "error",
]);

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringOrUndefined(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isCheckpoint(value: unknown): value is RalphCheckpoint {
  return (
    value === "planned" ||
    value === "routed" ||
    value === "implementation_step_complete" ||
    value === "pr_ready" ||
    value === "merge_step_complete" ||
    value === "survey_complete" ||
    value === "recorded"
  );
}

export function isRalphEvent(value: unknown): value is RalphEvent {
  if (!isObject(value)) return false;

  const ts = value.ts;
  const type = value.type;
  const level = value.level;
  const data = value.data;

  if (typeof ts !== "string" || !ts) return false;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return false;
  if (typeof level !== "string" || !LEVELS.has(level)) return false;

  if (!isStringOrUndefined(value.workerId)) return false;
  if (!isStringOrUndefined(value.repo)) return false;
  if (!isStringOrUndefined(value.taskId)) return false;
  if (!isStringOrUndefined(value.sessionId)) return false;

  if (!isObject(data)) return false;

  if (type === "worker.checkpoint.reached") {
    return isCheckpoint((data as any).checkpoint);
  }

  if (type === "worker.pause.reached") {
    const checkpoint = (data as any).checkpoint;
    return checkpoint === undefined || isCheckpoint(checkpoint);
  }

  if (type === "log.ralph" || type === "log.worker") {
    return typeof (data as any).message === "string";
  }

  if (type === "log.opencode.text") {
    return typeof (data as any).text === "string";
  }

  if (type === "worker.activity.updated") {
    return typeof (data as any).activity === "string";
  }

  if (type === "worker.summary.updated") {
    const text = (data as any).text;
    const confidence = (data as any).confidence;
    const topActivities = (data as any).top_activities;
    const confidenceOk = confidence === undefined || typeof confidence === "number";
    const topActivitiesOk =
      topActivities === undefined ||
      (Array.isArray(topActivities) && topActivities.every((entry) => typeof entry === "string"));

    return typeof text === "string" && confidenceOk && topActivitiesOk;
  }

  if (type === "error") {
    return typeof (data as any).message === "string";
  }

  return true;
}

export function assertRalphEvent(value: unknown, context = "value"): asserts value is RalphEvent {
  if (!isRalphEvent(value)) {
    throw new Error(`Invalid RalphEvent: ${context}`);
  }
}

export function buildRalphEvent<T extends RalphEvent>(
  event: Omit<T, "ts"> & { ts?: string }
): T {
  return {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
  } as T;
}

export function safeJsonStringifyRalphEvent(event: RalphEvent): string {
  return JSON.stringify(event);
}
