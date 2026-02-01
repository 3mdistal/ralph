import type { AgentTask, QueueTaskStatus } from "../queue/types";
import { inferPriorityFromLabels } from "../queue/priority";
import { RALPH_STATUS_LABELS, getStatusLabels, planSetStatus, resolveStatusFromLabels } from "../github/status-labels";
import type { IssueSnapshot, TaskOpState } from "../state";

export type LabelOp = { action: "add" | "remove"; label: string };

export function deriveRalphStatus(labels: string[], issueState?: string | null): QueueTaskStatus | null {
  const resolved = resolveStatusFromLabels({ labels, issueState });
  return resolved.status;
}

export function statusToRalphLabelDelta(status: QueueTaskStatus, currentLabels: string[]): {
  add: string[];
  remove: string[];
} {
  const plan = planSetStatus({ desired: status, currentLabels });
  return { add: plan.add, remove: plan.remove };
}

export function planClaim(currentLabels: string[]): {
  claimable: boolean;
  steps: LabelOp[];
  reason?: string;
} {
  const statusLabels = getStatusLabels(currentLabels);
  if (statusLabels.length > 1) {
    return { claimable: false, steps: [], reason: "Multiple ralph:status labels present" };
  }
  const statusLabel = statusLabels[0] ?? null;
  if (!statusLabel) {
    return { claimable: false, steps: [], reason: "Missing ralph:status:queued label" };
  }
  if (statusLabel !== RALPH_STATUS_LABELS.queued) {
    return { claimable: false, steps: [], reason: `Issue is ${statusLabel}` };
  }

  return {
    claimable: true,
    steps: [
      { action: "add", label: RALPH_STATUS_LABELS.inProgress },
      { action: "remove", label: RALPH_STATUS_LABELS.queued },
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
}): { shouldRecover: boolean; reason?: StaleInProgressRecoveryReason } {
  if (!params.labels.includes(RALPH_STATUS_LABELS.inProgress)) return { shouldRecover: false };
  if (typeof params.opState?.releasedAtMs === "number" && Number.isFinite(params.opState.releasedAtMs)) {
    return { shouldRecover: false };
  }

  // Safety: only recover issues we have local op-state for.
  // Without an op-state row we can't distinguish "another daemon is actively working" from "orphaned".
  if (!params.opState) {
    return { shouldRecover: false, reason: "missing-op-state" };
  }

  const sessionId = params.opState.sessionId?.trim() ?? "";
  if (!sessionId) {
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
  const statusInfo = resolveStatusFromLabels({ labels: params.issue.labels, issueState: params.issue.state });
  const labelStatus = statusInfo.status;
  const released = typeof params.opState?.releasedAtMs === "number" && Number.isFinite(params.opState.releasedAtMs);
  const opStatus = released ? "queued" : ((params.opState?.status as QueueTaskStatus | null) ?? null);
  const status = opStatus ?? labelStatus ?? "blocked";
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
