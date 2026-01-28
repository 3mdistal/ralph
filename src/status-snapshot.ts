export type StatusQueueSnapshot = {
  backend: string;
  health: string;
  fallback: boolean;
  diagnostics: string | null;
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
  workerId?: string | null;
  checkpoint?: string | null;
  pauseRequested?: boolean;
  pausedAtCheckpoint?: string | null;
  alerts?: StatusTaskAlerts | null;
};

export type StatusTaskAlerts = {
  totalCount: number;
  latestSummary: string | null;
  latestAt: string | null;
  latestCommentUrl: string | null;
};

export type StatusInProgressTask = StatusTaskBase & {
  sessionId: string | null;
  nowDoing: unknown | null;
  line: string | null;
  tokensTotal?: number | null;
  tokensComplete?: boolean;
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

export type StatusDaemonSnapshot = {
  daemonId: string | null;
  pid: number | null;
  startedAt: string | null;
  version: string | null;
  controlFilePath: string | null;
  command: string[] | null;
};

import type { StatusUsageSnapshot } from "./status-usage";

export type StatusSnapshot = {
  mode: string;
  queue: StatusQueueSnapshot;
  daemon: StatusDaemonSnapshot | null;
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

const normalizeAlerts = (alerts?: StatusTaskAlerts | null): StatusTaskAlerts | null => {
  if (!alerts || typeof alerts.totalCount !== "number" || alerts.totalCount <= 0) return null;
  return {
    totalCount: alerts.totalCount,
    latestSummary: normalizeOptionalString(alerts.latestSummary),
    latestAt: normalizeOptionalString(alerts.latestAt),
    latestCommentUrl: normalizeOptionalString(alerts.latestCommentUrl),
  };
};

const normalizeTaskBase = <T extends StatusTaskBase>(task: T): T => ({
  ...task,
  workerId: normalizeOptionalString(task.workerId),
  checkpoint: normalizeOptionalString(task.checkpoint),
  pauseRequested: typeof task.pauseRequested === "boolean" ? task.pauseRequested : undefined,
  pausedAtCheckpoint: normalizeOptionalString(task.pausedAtCheckpoint),
  alerts: normalizeAlerts(task.alerts),
});

const normalizeBlockedTask = (task: StatusBlockedTask): StatusBlockedTask => ({
  ...normalizeTaskBase(task),
  sessionId: normalizeOptionalString(task.sessionId),
  blockedAt: normalizeOptionalString(task.blockedAt),
  blockedSource: normalizeOptionalString(task.blockedSource),
  blockedReason: normalizeOptionalString(task.blockedReason),
  blockedDetailsSnippet: normalizeOptionalString(task.blockedDetailsSnippet),
});

const normalizeThrottledTask = (task: StatusThrottledTask): StatusThrottledTask => ({
  ...normalizeTaskBase(task),
  sessionId: normalizeOptionalString(task.sessionId),
  resumeAt: normalizeOptionalString(task.resumeAt),
});

const normalizeInProgressTask = (task: StatusInProgressTask): StatusInProgressTask => ({
  ...normalizeTaskBase(task),
  sessionId: normalizeOptionalString(task.sessionId),
  line: normalizeOptionalString(task.line),
});

export function buildStatusSnapshot(input: StatusSnapshot): StatusSnapshot {
  return {
    ...input,
    blocked: input.blocked.map(normalizeBlockedTask),
    inProgress: input.inProgress.map(normalizeInProgressTask),
    starting: input.starting.map(normalizeTaskBase),
    queued: input.queued.map(normalizeTaskBase),
    throttled: input.throttled.map(normalizeThrottledTask),
  };
}
