import { getConfig } from "../config";
import { shouldLog } from "../logging";
import {
  getIssueStatusTransitionRecord,
  getIssueLabels,
  listIssueSnapshotsWithRalphLabels,
  listTaskOpStatesByRepo,
  recordIssueStatusTransition,
  recordIssueLabelsSnapshot,
} from "../state";
import { GitHubClient } from "./client";
import { createRalphWorkflowLabelsEnsurer } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps } from "./issue-label-io";
import { mutateIssueLabels } from "./label-mutation";
import { canAttemptLabelWrite } from "./label-write-backoff";
import { countStatusLabels } from "./status-label-invariant";
import {
  deriveRalphStatus,
  shouldDebounceOppositeStatusTransition,
  statusToRalphLabelDelta,
  type LabelOp,
} from "../github-queue/core";
import type { QueueTaskStatus } from "../queue/types";
import { RALPH_LABEL_STATUS_PAUSED, RALPH_LABEL_STATUS_STOPPED } from "../github-labels";
import { auditQueueParityForRepo } from "./queue-parity-audit";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_ISSUES_PER_TICK = 10;
const DEFAULT_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_STATUS_TRANSITION_DEBOUNCE_MS = 5 * 60_000;
const TELEMETRY_SOURCE = "label-reconciler";

type ReconcileCooldownState = { desiredStatus: QueueTaskStatus; appliedAtMs: number };
const lastAppliedByIssue = new Map<string, ReconcileCooldownState>();

function applyLabelDeltaSnapshot(params: {
  repo: string;
  issueNumber: number;
  add: string[];
  remove: string[];
  nowIso: string;
}): void {
  const current = getIssueLabels(params.repo, params.issueNumber);
  const set = new Set(current);
  for (const label of params.remove) set.delete(label);
  for (const label of params.add) set.add(label);

  recordIssueLabelsSnapshot({
    repo: params.repo,
    issue: `${params.repo}#${params.issueNumber}`,
    labels: Array.from(set),
    at: params.nowIso,
  });
}

function toDesiredStatus(raw: string | null | undefined): QueueTaskStatus | null {
  if (!raw) return null;
  if (raw === "starting") return "in-progress";
  if (raw === "waiting-on-pr") return "in-progress";
  if (raw === "throttled") return null;
  if (raw === "done") return null;
  return raw as QueueTaskStatus;
}

async function reconcileRepo(
  repo: string,
  maxIssues: number,
  cooldownMs: number
): Promise<{ processed: number; queuedBlockedBefore: number; queuedBlockedAfter: number }> {
  const parityBefore = auditQueueParityForRepo(repo);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const debounceMsRaw = Number(process.env.RALPH_GITHUB_QUEUE_STATUS_DEBOUNCE_MS ?? DEFAULT_STATUS_TRANSITION_DEBOUNCE_MS);
  const debounceMs = Number.isFinite(debounceMsRaw) ? Math.max(0, Math.floor(debounceMsRaw)) : DEFAULT_STATUS_TRANSITION_DEBOUNCE_MS;
  const opStates = listTaskOpStatesByRepo(repo);
  const opStateByIssue = new Map<number, (typeof opStates)[number]>();
  for (const op of opStates) {
    if (typeof op.issueNumber !== "number") continue;
    if (!opStateByIssue.has(op.issueNumber)) opStateByIssue.set(op.issueNumber, op);
  }

  const issues = listIssueSnapshotsWithRalphLabels(repo);
  if (issues.length === 0) {
    return {
      processed: 0,
      queuedBlockedBefore: parityBefore.ghQueuedLocalBlocked,
      queuedBlockedAfter: parityBefore.ghQueuedLocalBlocked,
    };
  }

  const github = new GitHubClient(repo);
  const labelIdCache = new Map<string, string>();
  const labelEnsurer = createRalphWorkflowLabelsEnsurer({
    githubFactory: (targetRepo) => new GitHubClient(targetRepo),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  });

  let processed = 0;

  for (const issue of issues) {
    if (processed >= maxIssues) break;
    if ((issue.state ?? "").toUpperCase() === "CLOSED") continue;
    if (issue.labels.includes(RALPH_LABEL_STATUS_PAUSED)) continue;
    if (issue.labels.includes(RALPH_LABEL_STATUS_STOPPED)) continue;
    const opState = opStateByIssue.get(issue.number);
    if (!opState) continue;

    const released = typeof opState.releasedAtMs === "number" && Number.isFinite(opState.releasedAtMs);
    const desiredStatus = released ? "queued" : toDesiredStatus(opState.status ?? null);
    if (!desiredStatus) continue;

    const cooldownKey = `${repo}#${issue.number}`;
    const cooldown = lastAppliedByIssue.get(cooldownKey);
    if (cooldown && cooldown.desiredStatus === desiredStatus && nowMs - cooldown.appliedAtMs < cooldownMs) {
      continue;
    }

    const delta = statusToRalphLabelDelta(desiredStatus, issue.labels);
    if (delta.add.length === 0 && delta.remove.length === 0) continue;

    const fromStatus = deriveRalphStatus(issue.labels, issue.state);
    const previous = getIssueStatusTransitionRecord(repo, issue.number);
    const suppress = shouldDebounceOppositeStatusTransition({
      fromStatus,
      toStatus: desiredStatus,
      reason: `label-reconciler:${desiredStatus}`,
      nowMs,
      windowMs: debounceMs,
      previous: previous
        ? {
            fromStatus: previous.fromStatus as QueueTaskStatus | null,
            toStatus: previous.toStatus as QueueTaskStatus,
            reason: previous.reason,
            atMs: previous.updatedAtMs,
          }
        : null,
    });
    if (suppress.suppress) {
      const statusCount = countStatusLabels(issue.labels);
      if (statusCount === 1) {
        console.warn(
          `[ralph:labels:reconcile:${repo}] Suppressed transition for ${repo}#${issue.number}: ${suppress.reason ?? "debounced"}`
        );
        continue;
      }
      console.warn(
        `[ralph:labels:reconcile:${repo}] Ignoring debounce for ${repo}#${issue.number}; status labels drifted (count=${statusCount})`
      );
    }

    const ops: LabelOp[] = [
      ...delta.add.map((label) => ({ action: "add" as const, label })),
      ...delta.remove.map((label) => ({ action: "remove" as const, label })),
    ];

    let didApply = false;

    // Respect repo-level label write backoff to avoid burning rate limit.
    if (!canAttemptLabelWrite(repo)) {
      continue;
    }
    const graphResult = await mutateIssueLabels({
      github,
      repo,
      issueNumber: issue.number,
      issueNodeId: issue.githubNodeId,
      plan: { add: delta.add, remove: delta.remove },
      labelIdCache,
      telemetrySource: TELEMETRY_SOURCE,
    });
    if (graphResult.ok) {
      applyLabelDeltaSnapshot({ repo, issueNumber: issue.number, add: delta.add, remove: delta.remove, nowIso });
      didApply = true;
    }

    if (!didApply) {
      const result = await executeIssueLabelOps({
        github,
        repo,
        issueNumber: issue.number,
        ops,
        log: (message) => console.warn(`[ralph:labels:reconcile:${repo}] ${message}`),
        logLabel: `${repo}#${issue.number}`,
        ensureLabels: async () => await labelEnsurer.ensure(repo),
        retryMissingLabelOnce: true,
        ensureBefore: false,
      });

      if (result.ok) {
        applyLabelDeltaSnapshot({ repo, issueNumber: issue.number, add: result.add, remove: result.remove, nowIso });
        didApply = true;
      }
    }

    if (didApply) {
      recordIssueStatusTransition({
        repo,
        issueNumber: issue.number,
        fromStatus,
        toStatus: desiredStatus,
        reason: `label-reconciler:${desiredStatus}`,
        updatedAtMs: nowMs,
      });
      lastAppliedByIssue.set(cooldownKey, { desiredStatus, appliedAtMs: nowMs });
    }

    processed += 1;
  }

  const parityAfter = auditQueueParityForRepo(repo);
  const shouldReportDrift =
    parityBefore.ghQueuedLocalBlocked !== parityAfter.ghQueuedLocalBlocked || parityAfter.ghQueuedLocalBlocked > 0;
  if (shouldReportDrift) {
    const samples = parityAfter.sampleGhQueuedLocalBlocked.length > 0
      ? ` samples=${parityAfter.sampleGhQueuedLocalBlocked.join(",")}`
      : "";
    console.log(
      `[ralph:labels:reconcile:${repo}] queued/local-blocked drift before=${parityBefore.ghQueuedLocalBlocked} after=${parityAfter.ghQueuedLocalBlocked}${samples}`
    );
  }

  return {
    processed,
    queuedBlockedBefore: parityBefore.ghQueuedLocalBlocked,
    queuedBlockedAfter: parityAfter.ghQueuedLocalBlocked,
  };
}

export function startGitHubLabelReconciler(params?: {
  intervalMs?: number;
  maxIssuesPerTick?: number;
  cooldownMs?: number;
  log?: (message: string) => void;
}): { stop: () => void } {
  const intervalMs = Math.max(1_000, params?.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxIssuesPerTick = Math.max(1, Math.floor(params?.maxIssuesPerTick ?? DEFAULT_MAX_ISSUES_PER_TICK));
  const cooldownMs = Math.max(0, Math.floor(params?.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  const log = params?.log ?? ((message: string) => console.log(message));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (running) {
      timer = setTimeout(tick, intervalMs);
      return;
    }
    running = true;
    try {
      const repos = getConfig().repos.map((entry) => entry.name);
      let remaining = maxIssuesPerTick;
      let totalProcessed = 0;
      let queuedBlockedBefore = 0;
      let queuedBlockedAfter = 0;
      for (const repo of repos) {
        if (remaining <= 0) break;
        const result = await reconcileRepo(repo, remaining, cooldownMs);
        remaining -= result.processed;
        totalProcessed += result.processed;
        queuedBlockedBefore += result.queuedBlockedBefore;
        queuedBlockedAfter += result.queuedBlockedAfter;
      }
      if (shouldLog("labels:reconcile", 5 * 60_000)) {
        log(
          `[ralph:labels] Reconcile tick complete processed=${totalProcessed} queued/local-blocked=${queuedBlockedBefore}->${queuedBlockedAfter}`
        );
      }
    } catch (error: any) {
      log(`[ralph:labels] Reconcile tick failed: ${error?.message ?? String(error)}`);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
