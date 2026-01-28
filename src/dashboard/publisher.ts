import { ralphEventBus } from "./bus";
import {
  assertRalphEvent,
  buildRalphEvent,
  isRalphEvent,
  safeJsonStringifyRalphEvent,
  type RalphEvent,
  type RalphEventType,
} from "./events";
import { redactSensitiveText } from "../redaction";
import { getLatestRunIdForSession } from "../state";

export type DashboardEventContext = {
  runId?: string;
  workerId?: string;
  repo?: string;
  taskId?: string;
  sessionId?: string;
};

type PublishInput = Omit<RalphEvent, "ts"> & { ts?: string };

type RateLimitState = {
  windowStart: number;
  count: number;
};

const RUN_ID_REQUIRED_TYPES: ReadonlySet<RalphEventType> = new Set([
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
  "log.worker",
  "log.opencode.event",
  "log.opencode.text",
]);

const RUN_ID_CACHE_TTL_MS = 60_000;
const MAX_LOG_TEXT_CHARS = 4000;
const MAX_LOG_EVENT_CHARS = 8000;
const LOG_WINDOW_MS = 60_000;
const LOG_MAX_OPENCODE_EVENTS = 200;
const LOG_MAX_OPENCODE_TEXT = 500;

const runIdCache = new Map<string, { runId: string; expiresAt: number }>();
const logRateState = new Map<string, RateLimitState>();

function resolveRunIdForSession(sessionId?: string): string | undefined {
  const sid = sessionId?.trim();
  if (!sid) return undefined;

  const cached = runIdCache.get(sid);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.runId;

  try {
    const runId = getLatestRunIdForSession(sid);
    if (runId) {
      runIdCache.set(sid, { runId, expiresAt: now + RUN_ID_CACHE_TTL_MS });
      return runId;
    }
  } catch (error: any) {
    console.warn(`[dashboard] Failed to resolve runId for session ${sid}: ${error?.message ?? String(error)}`);
  }

  return undefined;
}

function truncateText(value: string, limit: number): string {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... (truncated)`;
}

function sanitizeOpencodeEventPayload(payload: unknown): unknown {
  const serialized = safeJsonStringifyRalphEvent({
    ts: new Date().toISOString(),
    type: "log.opencode.event",
    level: "info",
    data: { event: payload },
  } as RalphEvent);
  const redacted = redactSensitiveText(serialized);
  const normalized = redacted.length > MAX_LOG_EVENT_CHARS ? redacted.slice(0, MAX_LOG_EVENT_CHARS) : redacted;

  if (redacted.length > MAX_LOG_EVENT_CHARS) {
    return {
      truncated: true,
      preview: normalized,
      bytes: redacted.length,
    };
  }

  try {
    const parsed = JSON.parse(normalized);
    return parsed?.data?.event ?? payload;
  } catch {
    return normalized;
  }
}

function redactEventPayload(event: RalphEvent): RalphEvent {
  if (event.type === "log.ralph" || event.type === "log.worker") {
    return {
      ...event,
      data: { message: truncateText(redactSensitiveText(event.data.message), MAX_LOG_TEXT_CHARS) },
    } as RalphEvent;
  }

  if (event.type === "log.opencode.text") {
    return {
      ...event,
      data: { text: truncateText(redactSensitiveText(event.data.text), MAX_LOG_TEXT_CHARS) },
    } as RalphEvent;
  }

  if (event.type === "log.opencode.event") {
    return {
      ...event,
      data: { event: sanitizeOpencodeEventPayload(event.data.event) },
    } as RalphEvent;
  }

  return event;
}

function shouldEmitLog(event: RalphEvent): boolean {
  if (event.type !== "log.opencode.event" && event.type !== "log.opencode.text") return true;

  const key = [event.type, event.sessionId || event.runId || event.workerId || "global"].join(":");
  const now = Date.now();
  const limit = event.type === "log.opencode.event" ? LOG_MAX_OPENCODE_EVENTS : LOG_MAX_OPENCODE_TEXT;

  const state = logRateState.get(key);
  if (!state || now - state.windowStart >= LOG_WINDOW_MS) {
    logRateState.set(key, { windowStart: now, count: 1 });
    return true;
  }

  if (state.count >= limit) return false;
  state.count += 1;
  return true;
}

function applyRunIdRequirement(event: RalphEvent): RalphEvent {
  if (event.runId || !RUN_ID_REQUIRED_TYPES.has(event.type)) return event;

  const resolved = resolveRunIdForSession(event.sessionId);
  if (resolved) {
    return { ...event, runId: resolved } as RalphEvent;
  }

  return event;
}

function assertContract(event: RalphEvent): void {
  if (RUN_ID_REQUIRED_TYPES.has(event.type) && !event.runId) {
    console.warn(`[dashboard] Missing runId for event type ${event.type} (session=${event.sessionId ?? ""})`);
  }
}

export function publishDashboardEvent(event: PublishInput, context?: DashboardEventContext): boolean {
  const merged = {
    ...context,
    ...event,
    data: event.data,
  } as RalphEvent;

  const built = buildRalphEvent(merged);
  const withRunId = applyRunIdRequirement(built);
  const redacted = redactEventPayload(withRunId);

  if (!shouldEmitLog(redacted)) return false;

  if (!isRalphEvent(redacted)) {
    try {
      assertRalphEvent(redacted, "dashboard.publish");
    } catch {
      return false;
    }
  }

  assertContract(redacted);
  ralphEventBus.publish(redacted);
  return true;
}
