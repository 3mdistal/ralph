import type { QueueBackendNotice } from "./queue-backend";
import type { StatusUsageSnapshot } from "./status-usage";

export type StatusQueueSnapshot = {
  backend: string;
  desiredBackend: string;
  explicit: boolean;
  health: string;
  fallback: boolean;
  diagnostics: string | null;
  notices: QueueBackendNotice[];
};

export type StatusDrainSnapshot = {
  requestedAt: string | null;
  timeoutMs: number | null;
  pauseRequested: boolean;
  pauseAtCheckpoint?: string | null;
};

export type StatusTaskBase = {
  name: string;
  repo: string;
  issue: string;
  priority: string;
  opencodeProfile: string | null;
};

export type StatusInProgressTask = StatusTaskBase & {
  sessionId: string | null;
  nowDoing: unknown | null;
  line: string | null;
};

export type StatusThrottledTask = StatusTaskBase & {
  sessionId: string | null;
  resumeAt: string | null;
};

export type StatusBlockedTask = StatusTaskBase & {
  sessionId: string | null;
  blockedAt: string | null;
  blockedSource: string | null;
  blockedReason: string | null;
  blockedDetailsSnippet: string | null;
};

export type StatusSnapshot = {
  mode: string;
  queue: StatusQueueSnapshot;
  controlProfile: string | null;
  activeProfile: string | null;
  throttle: unknown;
  usage?: StatusUsageSnapshot;
  escalations: { pending: number };
  inProgress: StatusInProgressTask[];
  starting: StatusTaskBase[];
  queued: StatusTaskBase[];
  throttled: StatusThrottledTask[];
  blocked: StatusBlockedTask[];
  drain: StatusDrainSnapshot;
};

const normalizeOptionalString = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeBlockedTask = (task: StatusBlockedTask): StatusBlockedTask => ({
  ...task,
  sessionId: normalizeOptionalString(task.sessionId),
  blockedAt: normalizeOptionalString(task.blockedAt),
  blockedSource: normalizeOptionalString(task.blockedSource),
  blockedReason: normalizeOptionalString(task.blockedReason),
  blockedDetailsSnippet: normalizeOptionalString(task.blockedDetailsSnippet),
});

const normalizeThrottledTask = (task: StatusThrottledTask): StatusThrottledTask => ({
  ...task,
  sessionId: normalizeOptionalString(task.sessionId),
  resumeAt: normalizeOptionalString(task.resumeAt),
});

export function buildStatusSnapshot(input: StatusSnapshot): StatusSnapshot {
  return {
    ...input,
    blocked: input.blocked.map(normalizeBlockedTask),
    throttled: input.throttled.map(normalizeThrottledTask),
  };
}
