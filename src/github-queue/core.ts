import type { AgentTask, QueueTaskStatus } from "../queue/types";
import { inferPriorityFromLabels } from "../queue/priority";
import type { IssueSnapshot, TaskOpState } from "../state";

export type LabelOp = { action: "add" | "remove"; label: string };

const RALPH_STATUS_LABELS: Record<QueueTaskStatus, string | null> = {
  queued: "ralph:queued",
  "in-progress": "ralph:in-progress",
  blocked: "ralph:blocked",
  escalated: "ralph:escalated",
  done: "ralph:in-bot",
  starting: "ralph:in-progress",
  throttled: null,
};

const RALPH_LABEL_DONE = "ralph:done";
const KNOWN_RALPH_LABELS = Array.from(
  new Set([...Object.values(RALPH_STATUS_LABELS).filter(Boolean), RALPH_LABEL_DONE])
) as string[];
const RALPH_LABEL_QUEUED = RALPH_STATUS_LABELS.queued ?? "ralph:queued";
// Preserve queued intent while blocked; claimability is determined at the queue layer.
const PRESERVE_LABELS_BY_STATUS: Partial<Record<QueueTaskStatus, readonly string[]>> = {
  blocked: [RALPH_LABEL_QUEUED],
};

export function deriveRalphStatus(labels: string[], issueState?: string | null): QueueTaskStatus | null {
  const normalizedState = issueState?.toUpperCase();
  if (normalizedState === "CLOSED") return "done";
  if (labels.includes(RALPH_LABEL_DONE)) return "done";
  if (labels.includes("ralph:in-bot")) return "done";
  if (labels.includes("ralph:escalated")) return "escalated";
  if (labels.includes("ralph:blocked") && labels.includes("ralph:queued")) return "queued";
  if (labels.includes("ralph:blocked")) return "blocked";
  if (labels.includes("ralph:in-progress")) return "in-progress";
  if (labels.includes("ralph:queued")) return "queued";
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
  if (status === "blocked" && !labelSet.has(RALPH_LABEL_QUEUED)) {
    add.push(RALPH_LABEL_QUEUED);
  }
  const preserved = new Set(PRESERVE_LABELS_BY_STATUS[status] ?? []);
  const remove = KNOWN_RALPH_LABELS.filter(
    (label) => label !== target && labelSet.has(label) && !preserved.has(label)
  );
  return { add, remove };
}

export function planClaim(currentLabels: string[]): {
  claimable: boolean;
  steps: LabelOp[];
  reason?: string;
} {
  const labelSet = new Set(currentLabels);
  if (labelSet.has(RALPH_LABEL_DONE)) {
    return { claimable: false, steps: [], reason: "Issue already done" };
  }
  if (labelSet.has("ralph:escalated")) {
    return { claimable: false, steps: [], reason: "Issue is escalated" };
  }
  if (labelSet.has("ralph:in-bot")) {
    return { claimable: false, steps: [], reason: "Issue already in bot" };
  }
  if (labelSet.has("ralph:in-progress")) {
    return { claimable: false, steps: [], reason: "Issue already in progress" };
  }
  if (!labelSet.has("ralph:queued")) {
    return { claimable: false, steps: [], reason: "Missing ralph:queued label" };
  }

  if (labelSet.has("ralph:blocked")) {
    return {
      claimable: true,
      steps: [
        { action: "add", label: "ralph:in-progress" },
        { action: "remove", label: "ralph:queued" },
        { action: "remove", label: "ralph:blocked" },
      ],
    };
  }

  return {
    claimable: true,
    steps: [
      { action: "add", label: "ralph:in-progress" },
      { action: "remove", label: "ralph:queued" },
    ],
  };
}

export function shouldRecoverStaleInProgress(params: {
  labels: string[];
  opState?: TaskOpState | null;
  nowMs: number;
  ttlMs: number;
}): boolean {
  if (!params.labels.includes("ralph:in-progress")) return false;
  if (typeof params.opState?.releasedAtMs === "number" && Number.isFinite(params.opState.releasedAtMs)) return false;
  const heartbeat = params.opState?.heartbeatAt?.trim() ?? "";
  if (!heartbeat) return false;
  const heartbeatMs = Date.parse(heartbeat);
  if (!Number.isFinite(heartbeatMs)) return false;
  return params.nowMs - heartbeatMs > params.ttlMs;
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
