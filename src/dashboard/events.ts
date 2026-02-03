export type RalphEventLevel = "debug" | "info" | "warn" | "error";

export type RalphEventType =
  | "daemon.started"
  | "daemon.stopped"
  | "github.request"
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
  | "worker.context_compact.triggered"
  | "message.queued"
  | "message.detected"
  | "message.delivery.attempted"
  | "message.delivery.deferred"
  | "message.delivery.blocked"
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
  runId?: string;
  workerId?: string;
  repo?: string;
  taskId?: string;
  sessionId?: string;
  data: TData;
};

export type RalphEvent =
  | RalphEventEnvelope<"daemon.started", { version?: string }>
  | RalphEventEnvelope<"daemon.stopped", { reason?: string; code?: number }>
  | RalphEventEnvelope<
      "github.request",
      {
        method: string;
        path: string;
        status: number;
        ok: boolean;
        write: boolean;
        durationMs: number;
        attempt: number;
        requestId?: string | null;
        allowNotFound?: boolean;
        graphqlOperation?: "query" | "mutation" | null;
        backoffWaitMs?: number;
        backoffResumeAtTs?: number | null;
        backoffSetUntilTs?: number | null;
        rateLimited?: boolean;
        secondaryRateLimited?: boolean;
        installationId?: string | null;
        retryAfterMs?: number | null;
        willRetry?: boolean;
        rateLimit?: {
          limit?: number | null;
          remaining?: number | null;
          used?: number | null;
          resetAtTs?: number | null;
          resource?: string | null;
        };
        errorCode?: string;
      }
    >
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
  | RalphEventEnvelope<"worker.context_compact.triggered", { stepTitle?: string; attempt?: number }>
  | RalphEventEnvelope<"message.queued", { id: string; len: number; preview: string }>
  | RalphEventEnvelope<"message.detected", { count: number; blocked?: boolean }>
  | RalphEventEnvelope<"message.delivery.attempted", { id: string; len: number; preview: string; success: boolean; error?: string }>
  | RalphEventEnvelope<"message.delivery.deferred", { id?: string; reason: string }>
  | RalphEventEnvelope<"message.delivery.blocked", { id: string; failedAttempts: number; maxAttempts: number }>
  | RalphEventEnvelope<"log.ralph", { message: string }>
  | RalphEventEnvelope<"log.worker", { message: string }>
  | RalphEventEnvelope<"log.opencode.event", { event: unknown }>
  | RalphEventEnvelope<"log.opencode.text", { text: string }>
  | RalphEventEnvelope<"error", { message: string; stack?: string; code?: string }>; 

const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "daemon.started",
  "daemon.stopped",
  "github.request",
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
  "worker.context_compact.triggered",
  "message.queued",
  "message.detected",
  "message.delivery.attempted",
  "message.delivery.deferred",
  "message.delivery.blocked",
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

function isBooleanOrUndefined(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isMessagePreview(value: unknown): value is { id: string; len: number; preview: string } {
  if (!isObject(value)) return false;
  return typeof value.id === "string" && typeof value.len === "number" && typeof value.preview === "string";
}

export function isRalphCheckpoint(value: unknown): value is RalphCheckpoint {
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

  if (!isStringOrUndefined(value.runId)) return false;
  if (!isStringOrUndefined(value.workerId)) return false;
  if (!isStringOrUndefined(value.repo)) return false;
  if (!isStringOrUndefined(value.taskId)) return false;
  if (!isStringOrUndefined(value.sessionId)) return false;

  if (!isObject(data)) return false;

  if (type === "worker.checkpoint.reached") {
    return isRalphCheckpoint((data as any).checkpoint);
  }

  if (type === "github.request") {
    const method = (data as any).method;
    const path = (data as any).path;
    const status = (data as any).status;
    const ok = (data as any).ok;
    const write = (data as any).write;
    const durationMs = (data as any).durationMs;
    const attempt = (data as any).attempt;

    if (typeof method !== "string" || !method.trim()) return false;
    if (typeof path !== "string" || !path.trim()) return false;
    if (typeof status !== "number" || !Number.isFinite(status)) return false;
    if (typeof ok !== "boolean") return false;
    if (typeof write !== "boolean") return false;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return false;
    if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt < 1) return false;

    const graphqlOperation = (data as any).graphqlOperation;
    if (
      graphqlOperation !== undefined &&
      graphqlOperation !== null &&
      graphqlOperation !== "query" &&
      graphqlOperation !== "mutation"
    ) {
      return false;
    }

    const rateLimit = (data as any).rateLimit;
    if (rateLimit !== undefined && rateLimit !== null && !isObject(rateLimit)) return false;

    return true;
  }

  if (type === "worker.pause.reached") {
    const checkpoint = (data as any).checkpoint;
    return checkpoint === undefined || isRalphCheckpoint(checkpoint);
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

  if (type === "message.queued") {
    return isMessagePreview(data);
  }

  if (type === "message.detected") {
    return typeof (data as any).count === "number" && isBooleanOrUndefined((data as any).blocked);
  }

  if (type === "message.delivery.attempted") {
    if (!isMessagePreview(data)) return false;
    const success = (data as any).success;
    const error = (data as any).error;
    return typeof success === "boolean" && isStringOrUndefined(error);
  }

  if (type === "message.delivery.deferred") {
    const reason = (data as any).reason;
    const id = (data as any).id;
    return typeof reason === "string" && isStringOrUndefined(id);
  }

  if (type === "message.delivery.blocked") {
    const id = (data as any).id;
    const failedAttempts = (data as any).failedAttempts;
    const maxAttempts = (data as any).maxAttempts;
    return typeof id === "string" && typeof failedAttempts === "number" && typeof maxAttempts === "number";
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
  return safeJsonStringify(event);
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString();
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}
