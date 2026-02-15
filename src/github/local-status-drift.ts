import { deriveRalphStatus } from "../github-queue/core";
import { shouldLog } from "../logging";
import { isHeartbeatStale } from "../ownership";
import type { QueueTaskStatus } from "../queue/types";
import {
  clearTaskOpState,
  getTaskOpStateByPath,
  hasDurableOpState,
  listIssueSnapshotsWithRalphLabels,
  listTaskOpStatesByRepo,
  type IssueSnapshot,
  type TaskOpState,
  updateTaskStatusIfOwnershipUnchanged,
} from "../state";
import { countStatusLabels } from "./status-label-invariant";

type DriftRepairReason =
  | "issue-closed"
  | "ambiguous-status-label"
  | "missing-op-state"
  | "missing-gh-status"
  | "unsupported-gh-status"
  | "missing-local-status"
  | "already-converged"
  | "unsafe-active-ownership"
  | "repaired"
  | "race-skip";

const SUPPORTED_GH_STATUSES = new Set<QueueTaskStatus>(["queued", "escalated", "paused", "stopped", "done"]);

function normalizeLocalStatus(opState: TaskOpState | null | undefined): QueueTaskStatus | null {
  if (!opState) return null;
  const released = typeof opState.releasedAtMs === "number" && Number.isFinite(opState.releasedAtMs);
  if (released) return "queued";
  const raw = opState.status?.trim();
  if (!raw) return null;
  if (raw === "starting" || raw === "waiting-on-pr") return "in-progress";
  return raw as QueueTaskStatus;
}

function normalizeOwnershipField(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export type LocalStatusDriftPlan = {
  decision: "repair" | "skip";
  reason: DriftRepairReason;
  statusLabelCount: number;
  ghStatus: QueueTaskStatus | null;
  localStatus: QueueTaskStatus | null;
  activeOwnership: boolean;
  expectedDaemonId: string | null;
  expectedHeartbeatAt: string | null;
  targetStatus: QueueTaskStatus | null;
};

export function planLocalStatusDriftRepair(params: {
  issue: IssueSnapshot;
  opState: TaskOpState | null;
  nowMs: number;
  ttlMs: number;
}): LocalStatusDriftPlan {
  const statusLabelCount = countStatusLabels(params.issue.labels);
  const ghStatus = deriveRalphStatus(params.issue.labels, params.issue.state);
  const localStatus = normalizeLocalStatus(params.opState);
  const expectedDaemonId = normalizeOwnershipField(params.opState?.daemonId);
  const expectedHeartbeatAt = normalizeOwnershipField(params.opState?.heartbeatAt);
  const activeOwnership = !isHeartbeatStale(expectedHeartbeatAt ?? undefined, params.nowMs, params.ttlMs);

  const base = {
    statusLabelCount,
    ghStatus,
    localStatus,
    activeOwnership,
    expectedDaemonId,
    expectedHeartbeatAt,
  };

  if ((params.issue.state ?? "").toUpperCase() === "CLOSED") {
    return { decision: "skip", reason: "issue-closed", targetStatus: null, ...base };
  }
  if (statusLabelCount !== 1) {
    return { decision: "skip", reason: "ambiguous-status-label", targetStatus: null, ...base };
  }
  if (!params.opState) {
    return { decision: "skip", reason: "missing-op-state", targetStatus: null, ...base };
  }
  if (!ghStatus) {
    return { decision: "skip", reason: "missing-gh-status", targetStatus: null, ...base };
  }
  if (!SUPPORTED_GH_STATUSES.has(ghStatus)) {
    return { decision: "skip", reason: "unsupported-gh-status", targetStatus: null, ...base };
  }
  if (!localStatus) {
    return { decision: "skip", reason: "missing-local-status", targetStatus: null, ...base };
  }
  if (localStatus === ghStatus) {
    return { decision: "skip", reason: "already-converged", targetStatus: ghStatus, ...base };
  }
  if (activeOwnership) {
    return { decision: "skip", reason: "unsafe-active-ownership", targetStatus: ghStatus, ...base };
  }
  return { decision: "repair", reason: "repaired", targetStatus: ghStatus, ...base };
}

function buildDriftLog(details: Record<string, unknown>): string {
  return JSON.stringify({
    event: "local-status-drift",
    ...details,
  });
}

export function reconcileLocalStatusDriftForRepo(params: {
  repo: string;
  nowMs?: number;
  ttlMs: number;
  logPrefix?: string;
}): {
  repaired: number;
  unsafeSkipped: number;
  raceSkipped: number;
  observedDrift: number;
} {
  const nowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const logPrefix = params.logPrefix ?? `[ralph:labels:reconcile:${params.repo}]`;
  const issues = listIssueSnapshotsWithRalphLabels(params.repo);
  const opStates = listTaskOpStatesByRepo(params.repo);
  const opStateByIssue = new Map<number, TaskOpState>();
  for (const op of opStates) {
    if (typeof op.issueNumber !== "number") continue;
    if (!opStateByIssue.has(op.issueNumber)) opStateByIssue.set(op.issueNumber, op);
  }

  let repaired = 0;
  let unsafeSkipped = 0;
  let raceSkipped = 0;
  let observedDrift = 0;

  for (const issue of issues) {
    const opState = opStateByIssue.get(issue.number) ?? null;
    const plan = planLocalStatusDriftRepair({
      issue,
      opState,
      nowMs,
      ttlMs: params.ttlMs,
    });

    const hasDrift = plan.ghStatus !== null && plan.localStatus !== null && plan.ghStatus !== plan.localStatus;
    if (hasDrift) observedDrift += 1;

    if (plan.decision !== "repair" || !opState || !plan.targetStatus) {
      if (plan.reason === "unsafe-active-ownership") {
        unsafeSkipped += 1;
        if (shouldLog(`labels:local-drift:unsafe:${params.repo}#${issue.number}`, 60_000)) {
          console.warn(
            `${logPrefix} ${buildDriftLog({
              repo: params.repo,
              issueNumber: issue.number,
              action: "skip",
              reason: plan.reason,
              statusLabelCount: plan.statusLabelCount,
              ghStatus: plan.ghStatus,
              localStatus: plan.localStatus,
              activeOwnership: plan.activeOwnership,
              expectedDaemonId: plan.expectedDaemonId,
              expectedHeartbeatAt: plan.expectedHeartbeatAt,
            })}`
          );
        }
      }
      continue;
    }

    const releasedReason = `label-reconciler:local-status-drift:${plan.localStatus ?? "unknown"}->${plan.targetStatus}`;
    const result = hasDurableOpState(opState)
      ? clearTaskOpState({
          repo: params.repo,
          taskPath: opState.taskPath,
          status: plan.targetStatus,
          releasedAtMs: nowMs,
          releasedReason,
          expectedDaemonId: plan.expectedDaemonId,
          expectedHeartbeatAt: plan.expectedHeartbeatAt,
        })
      : updateTaskStatusIfOwnershipUnchanged({
          repo: params.repo,
          taskPath: opState.taskPath,
          status: plan.targetStatus,
          releasedAtMs: nowMs,
          releasedReason,
          expectedDaemonId: plan.expectedDaemonId,
          expectedHeartbeatAt: plan.expectedHeartbeatAt,
        });

    const updated = "updated" in result ? result.updated : result.cleared;

    if (result.raceSkipped) {
      raceSkipped += 1;
      if (shouldLog(`labels:local-drift:race:${params.repo}#${issue.number}`, 60_000)) {
        console.warn(
          `${logPrefix} ${buildDriftLog({
            repo: params.repo,
            issueNumber: issue.number,
            action: "skip",
            reason: "race-skip",
            statusLabelCount: plan.statusLabelCount,
            ghStatus: plan.ghStatus,
            localStatus: plan.localStatus,
            targetStatus: plan.targetStatus,
            expectedDaemonId: plan.expectedDaemonId,
            expectedHeartbeatAt: plan.expectedHeartbeatAt,
          })}`
        );
      }
      continue;
    }

    if (!updated) continue;
    repaired += 1;

    const after = getTaskOpStateByPath(params.repo, opState.taskPath);
    const afterStatus = normalizeLocalStatus(after);
    if (shouldLog(`labels:local-drift:repaired:${params.repo}#${issue.number}`, 60_000)) {
      console.log(
        `${logPrefix} ${buildDriftLog({
          repo: params.repo,
          issueNumber: issue.number,
          action: "repair",
          reason: plan.reason,
          statusLabelCount: plan.statusLabelCount,
          ghStatus: plan.ghStatus,
          localStatusBefore: plan.localStatus,
          localStatusAfter: afterStatus,
          targetStatus: plan.targetStatus,
          expectedDaemonId: plan.expectedDaemonId,
          expectedHeartbeatAt: plan.expectedHeartbeatAt,
          at: nowIso,
        })}`
      );
    }
  }

  return { repaired, unsafeSkipped, raceSkipped, observedDrift };
}
