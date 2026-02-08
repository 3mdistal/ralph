import { RALPH_LABEL_STATUS_QUEUED, RALPH_STATUS_LABEL_PREFIX } from "../github-labels";
import { listIssueSnapshotsWithRalphLabels, listTaskOpStatesByRepo, type IssueSnapshot, type TaskOpState } from "../state";
import type { QueueTaskStatus } from "../queue/types";

export type QueueParityRepoAudit = {
  repo: string;
  ghQueuedLocalBlocked: number;
  multiStatusLabels: number;
  missingStatusWithOpState: number;
  sampleGhQueuedLocalBlocked: string[];
};

function normalizeLocalStatus(opState: TaskOpState | null | undefined): QueueTaskStatus | null {
  if (!opState) return null;
  const released = typeof opState.releasedAtMs === "number" && Number.isFinite(opState.releasedAtMs);
  if (released) return "queued";
  const raw = opState.status?.trim();
  if (!raw) return null;
  if (raw === "starting" || raw === "waiting-on-pr") return "in-progress";
  if (raw === "done" || raw === "throttled") return null;
  return raw as QueueTaskStatus;
}

export function computeQueueParityAudit(params: {
  repo: string;
  issues: IssueSnapshot[];
  opStates: TaskOpState[];
  sampleLimit?: number;
}): QueueParityRepoAudit {
  const sampleLimit = Number.isFinite(params.sampleLimit) ? Math.max(1, Math.floor(params.sampleLimit as number)) : 5;
  const opStateByIssue = new Map<number, TaskOpState>();
  for (const op of params.opStates) {
    if (typeof op.issueNumber !== "number") continue;
    if (!opStateByIssue.has(op.issueNumber)) opStateByIssue.set(op.issueNumber, op);
  }

  let ghQueuedLocalBlocked = 0;
  let multiStatusLabels = 0;
  let missingStatusWithOpState = 0;
  const sampleGhQueuedLocalBlocked: string[] = [];

  for (const issue of params.issues) {
    if ((issue.state ?? "").toUpperCase() === "CLOSED") continue;
    const labels = issue.labels;
    const statusLabels = labels.filter((label) => label.startsWith(RALPH_STATUS_LABEL_PREFIX));
    if (statusLabels.length > 1) {
      multiStatusLabels += 1;
    }

    const opState = opStateByIssue.get(issue.number);
    if (!opState) continue;

    if (statusLabels.length === 0) {
      missingStatusWithOpState += 1;
    }

    const localStatus = normalizeLocalStatus(opState);
    if (localStatus === "blocked" && labels.includes(RALPH_LABEL_STATUS_QUEUED)) {
      ghQueuedLocalBlocked += 1;
      if (sampleGhQueuedLocalBlocked.length < sampleLimit) {
        sampleGhQueuedLocalBlocked.push(`${params.repo}#${issue.number}`);
      }
    }
  }

  return {
    repo: params.repo,
    ghQueuedLocalBlocked,
    multiStatusLabels,
    missingStatusWithOpState,
    sampleGhQueuedLocalBlocked,
  };
}

export function auditQueueParityForRepo(repo: string, sampleLimit: number = 5): QueueParityRepoAudit {
  return computeQueueParityAudit({
    repo,
    issues: listIssueSnapshotsWithRalphLabels(repo),
    opStates: listTaskOpStatesByRepo(repo),
    sampleLimit,
  });
}
