import type { AgentTask, QueueTaskStatus } from "../queue/types";
import { inferPriorityFromLabels } from "../queue/priority";
import type { IssueSnapshot, TaskOpState } from "../state";
import {
  RALPH_LABEL_STATUS_BLOCKED,
  RALPH_LABEL_STATUS_DONE,
  RALPH_LABEL_STATUS_IN_BOT,
  RALPH_LABEL_STATUS_IN_PROGRESS,
  RALPH_LABEL_STATUS_PAUSED,
  RALPH_LABEL_STATUS_QUEUED,
  RALPH_LABEL_STATUS_THROTTLED,
} from "../github-labels";

export type LabelOp = { action: "add" | "remove"; label: string };

const RALPH_STATUS_LABELS: Record<QueueTaskStatus, string | null> = {
  queued: RALPH_LABEL_STATUS_QUEUED,
  "in-progress": RALPH_LABEL_STATUS_IN_PROGRESS,
  blocked: RALPH_LABEL_STATUS_BLOCKED,
  escalated: RALPH_LABEL_STATUS_BLOCKED,
  done: RALPH_LABEL_STATUS_DONE,
  starting: RALPH_LABEL_STATUS_IN_PROGRESS,
  throttled: RALPH_LABEL_STATUS_THROTTLED,
};

const KNOWN_RALPH_STATUS_LABELS = Array.from(
  new Set([
    ...Object.values(RALPH_STATUS_LABELS).filter(Boolean),
    RALPH_LABEL_STATUS_PAUSED,
    RALPH_LABEL_STATUS_IN_BOT,
  ])
) as string[];

export function deriveRalphStatus(labels: string[], issueState?: string | null): QueueTaskStatus | null {
  const normalizedState = issueState?.toUpperCase();
  if (normalizedState === "CLOSED") return "done";
  if (labels.includes(RALPH_LABEL_STATUS_DONE)) return "done";
  if (labels.includes(RALPH_LABEL_STATUS_IN_BOT)) return "done";
  if (labels.includes(RALPH_LABEL_STATUS_THROTTLED)) return "throttled";
  if (labels.includes(RALPH_LABEL_STATUS_PAUSED)) return "blocked";
  if (labels.includes(RALPH_LABEL_STATUS_BLOCKED)) return "blocked";
  if (labels.includes(RALPH_LABEL_STATUS_IN_PROGRESS)) return "in-progress";
  if (labels.includes(RALPH_LABEL_STATUS_QUEUED)) return "queued";
  return null;
}

export function statusToRalphLabelDelta(status: QueueTaskStatus, currentLabels: string[]): {
  add: string[];
  remove: string[];
} {
  const target = RALPH_STATUS_LABELS[status];
  if (!target) return { add: [], remove: [] };

  const labelSet = new Set(currentLabels);
  const add: string[] = [];
  if (!labelSet.has(target)) add.push(target);
  const remove = KNOWN_RALPH_STATUS_LABELS.filter((label) => label !== target && labelSet.has(label));
  return { add, remove };
}

export function planClaim(currentLabels: string[]): {
  claimable: boolean;
  steps: LabelOp[];
  reason?: string;
} {
  const labelSet = new Set(currentLabels);
  if (labelSet.has(RALPH_LABEL_STATUS_DONE)) return { claimable: false, steps: [], reason: "Issue already done" };
  if (labelSet.has(RALPH_LABEL_STATUS_IN_BOT)) return { claimable: false, steps: [], reason: "Issue already in bot" };
  if (labelSet.has(RALPH_LABEL_STATUS_THROTTLED)) return { claimable: false, steps: [], reason: "Issue is throttled" };
  if (labelSet.has(RALPH_LABEL_STATUS_PAUSED)) return { claimable: false, steps: [], reason: "Issue is paused" };
  if (labelSet.has(RALPH_LABEL_STATUS_BLOCKED)) return { claimable: false, steps: [], reason: "Issue is blocked" };
  if (labelSet.has(RALPH_LABEL_STATUS_IN_PROGRESS)) return { claimable: false, steps: [], reason: "Issue already in progress" };
  if (!labelSet.has(RALPH_LABEL_STATUS_QUEUED)) {
    return { claimable: false, steps: [], reason: "Missing ralph:status:queued label" };
  }

  return {
    claimable: true,
    steps: [
      { action: "add", label: RALPH_LABEL_STATUS_IN_PROGRESS },
      { action: "remove", label: RALPH_LABEL_STATUS_QUEUED },
    ],
  };
}

export type StaleInProgressRecoveryReason =
  | "missing-op-state"
  | "missing-session-id"
  | "missing-heartbeat"
  | "invalid-heartbeat"
  | "stale-heartbeat";

export function computeStaleInProgressRecovery(params: {
  labels: string[];
  opState?: TaskOpState | null;
  nowMs: number;
  ttlMs: number;
  graceMs?: number;
}): { shouldRecover: boolean; reason?: StaleInProgressRecoveryReason } {
  if (!params.labels.includes(RALPH_LABEL_STATUS_IN_PROGRESS)) return { shouldRecover: false };
  if (typeof params.opState?.releasedAtMs === "number" && Number.isFinite(params.opState.releasedAtMs)) {
    return { shouldRecover: false };
  }

  // Safety: only recover issues we have local op-state for.
  // Without an op-state row we can't distinguish "another daemon is actively working" from "orphaned".
  if (!params.opState) {
    return { shouldRecover: false, reason: "missing-op-state" };
  }

  const graceMs = Number.isFinite(params.graceMs) ? Math.max(0, Math.floor(params.graceMs as number)) : 0;

  const sessionId = params.opState.sessionId?.trim() ?? "";
  if (!sessionId) {
    const heartbeat = params.opState.heartbeatAt?.trim() ?? "";
    const heartbeatMs = heartbeat ? Date.parse(heartbeat) : NaN;

    // Grace period: newly claimed tasks may briefly lack a sessionId.
    // If we have a recent heartbeat, defer recovery until grace elapses.
    if (graceMs > 0 && Number.isFinite(heartbeatMs) && params.nowMs - heartbeatMs < graceMs) {
      return { shouldRecover: false };
    }

    if (Number.isFinite(heartbeatMs) && params.nowMs - heartbeatMs > params.ttlMs) {
      return { shouldRecover: true, reason: "stale-heartbeat" };
    }

    return { shouldRecover: true, reason: "missing-session-id" };
  }

  const heartbeat = params.opState.heartbeatAt?.trim() ?? "";
  if (!heartbeat) {
    return { shouldRecover: true, reason: "missing-heartbeat" };
  }

  const heartbeatMs = Date.parse(heartbeat);
  if (!Number.isFinite(heartbeatMs)) {
    return { shouldRecover: true, reason: "invalid-heartbeat" };
  }

  if (params.nowMs - heartbeatMs > params.ttlMs) {
    return { shouldRecover: true, reason: "stale-heartbeat" };
  }

  return { shouldRecover: false };
}

export function deriveTaskView(params: {
  issue: IssueSnapshot;
  opState?: TaskOpState | null;
  nowIso: string;
}): AgentTask {
  const issueRef = `${params.issue.repo}#${params.issue.number}`;
  const taskPath = params.opState?.taskPath ?? `github:${issueRef}`;
  const labelStatus = deriveRalphStatus(params.issue.labels, params.issue.state);
  const released = typeof params.opState?.releasedAtMs === "number" && Number.isFinite(params.opState.releasedAtMs);
  const opStatus = released ? "queued" : ((params.opState?.status as QueueTaskStatus | null) ?? null);
  const status = opStatus ?? labelStatus ?? "queued";
  const creationDate = params.issue.githubUpdatedAt ?? params.nowIso;
  const name = params.issue.title?.trim() ? params.issue.title : `Issue ${params.issue.number}`;
  const priority = inferPriorityFromLabels(params.issue.labels);

  return {
    _path: taskPath,
    _name: name,
    type: "agent-task",
    "creation-date": creationDate,
    scope: "builder",
    issue: issueRef,
    repo: params.issue.repo,
    status,
    priority,
    name,
    "session-id": params.opState?.sessionId ?? undefined,
    "worktree-path": params.opState?.worktreePath ?? undefined,
    "worker-id": params.opState?.workerId ?? undefined,
    "repo-slot": params.opState?.repoSlot ?? undefined,
    "daemon-id": params.opState?.daemonId ?? undefined,
    "heartbeat-at": params.opState?.heartbeatAt ?? undefined,
  };
}
