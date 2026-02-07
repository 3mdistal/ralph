import { getConfig } from "../config";
import { shouldLog } from "../logging";
import {
  getIdempotencyPayload,
  getIssueLabels,
  listIssueSnapshotsWithRalphLabels,
  listTaskOpStatesByRepo,
  recordIssueLabelsSnapshot,
  upsertIdempotencyKey,
} from "../state";
import { GitHubClient } from "./client";
import { createRalphWorkflowLabelsEnsurer } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps } from "./issue-label-io";
import { mutateIssueLabels } from "./label-mutation";
import { canAttemptLabelWrite } from "./label-write-backoff";
import { statusToRalphLabelDelta, type LabelOp } from "../github-queue/core";
import type { QueueTaskStatus } from "../queue/types";
import { RALPH_LABEL_STATUS_PAUSED, RALPH_LABEL_STATUS_STOPPED } from "../github-labels";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_ISSUES_PER_TICK = 10;
const DEFAULT_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_TRANSITION_THROTTLE_MS = 3 * 60_000;
const TELEMETRY_SOURCE = "label-reconciler";

type ReconcileCooldownState = { desiredStatus: QueueTaskStatus; appliedAtMs: number; reason: string };
const lastAppliedByIssue = new Map<string, ReconcileCooldownState>();

type TransitionGuardPayload = {
  desiredStatus: QueueTaskStatus;
  reason: string;
  appliedAtMs: number;
};

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

function transitionGuardKey(repo: string, issueNumber: number): string {
  return `ralph:label-transition:v1:${repo}#${issueNumber}`;
}

function parseTransitionGuardPayload(raw: string | null): TransitionGuardPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TransitionGuardPayload>;
    if (typeof parsed.desiredStatus !== "string") return null;
    if (typeof parsed.reason !== "string") return null;
    if (typeof parsed.appliedAtMs !== "number" || !Number.isFinite(parsed.appliedAtMs)) return null;
    return {
      desiredStatus: parsed.desiredStatus as QueueTaskStatus,
      reason: parsed.reason,
      appliedAtMs: parsed.appliedAtMs,
    };
  } catch {
    return null;
  }
}

function buildDesiredReason(params: { opStatus: string | null | undefined; released: boolean }): string {
  if (params.released) return "released";
  const status = (params.opStatus ?? "").trim();
  if (!status) return "unknown";
  if (status === "waiting-on-pr") return "open-pr-wait";
  return `op-state:${status}`;
}

async function reconcileRepo(repo: string, maxIssues: number, cooldownMs: number, transitionThrottleMs: number): Promise<number> {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const opStates = listTaskOpStatesByRepo(repo);
  const opStateByIssue = new Map<number, (typeof opStates)[number]>();
  for (const op of opStates) {
    if (typeof op.issueNumber !== "number") continue;
    if (!opStateByIssue.has(op.issueNumber)) opStateByIssue.set(op.issueNumber, op);
  }

  const issues = listIssueSnapshotsWithRalphLabels(repo);
  if (issues.length === 0) return 0;

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
    const desiredReason = buildDesiredReason({ opStatus: opState.status, released });

    const cooldownKey = `${repo}#${issue.number}`;
    const cooldown = lastAppliedByIssue.get(cooldownKey);
    if (cooldown && cooldown.desiredStatus === desiredStatus && nowMs - cooldown.appliedAtMs < cooldownMs) {
      continue;
    }
    const shouldThrottleTransition = (guard: ReconcileCooldownState | TransitionGuardPayload | null): boolean => {
      if (!guard) return false;
      if (guard.desiredStatus === desiredStatus) return false;
      if (guard.reason !== desiredReason) return false;
      return nowMs - guard.appliedAtMs < transitionThrottleMs;
    };

    if (shouldThrottleTransition(cooldown ?? null)) {
      if (shouldLog(`labels:reconcile:transition-throttle:${cooldownKey}`, 60_000)) {
        console.warn(
          `[ralph:labels] Suppressed transition for ${cooldownKey}: ${cooldown?.desiredStatus} -> ${desiredStatus} (reason=${desiredReason})`
        );
      }
      continue;
    }

    const durableGuard = parseTransitionGuardPayload(getIdempotencyPayload(transitionGuardKey(repo, issue.number)));
    if (shouldThrottleTransition(durableGuard)) {
      if (shouldLog(`labels:reconcile:transition-throttle:durable:${cooldownKey}`, 60_000)) {
        console.warn(
          `[ralph:labels] Suppressed transition for ${cooldownKey} from durable guard: ${durableGuard?.desiredStatus} -> ${desiredStatus} (reason=${desiredReason})`
        );
      }
      continue;
    }

    const delta = statusToRalphLabelDelta(desiredStatus, issue.labels);
    if (delta.add.length === 0 && delta.remove.length === 0) continue;

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
      const payload: TransitionGuardPayload = { desiredStatus, reason: desiredReason, appliedAtMs: nowMs };
      upsertIdempotencyKey({
        key: transitionGuardKey(repo, issue.number),
        scope: "label-transition-guard",
        payloadJson: JSON.stringify(payload),
        createdAt: nowIso,
      });
      lastAppliedByIssue.set(cooldownKey, { desiredStatus, appliedAtMs: nowMs, reason: desiredReason });
    }

    processed += 1;
  }

  return processed;
}

export function startGitHubLabelReconciler(params?: {
  intervalMs?: number;
  maxIssuesPerTick?: number;
  cooldownMs?: number;
  transitionThrottleMs?: number;
  log?: (message: string) => void;
}): { stop: () => void } {
  const intervalMs = Math.max(1_000, params?.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxIssuesPerTick = Math.max(1, Math.floor(params?.maxIssuesPerTick ?? DEFAULT_MAX_ISSUES_PER_TICK));
  const cooldownMs = Math.max(0, Math.floor(params?.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  const transitionThrottleMs = Math.max(
    0,
    Math.floor(params?.transitionThrottleMs ?? DEFAULT_TRANSITION_THROTTLE_MS)
  );
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
      for (const repo of repos) {
        if (remaining <= 0) break;
        const processed = await reconcileRepo(repo, remaining, cooldownMs, transitionThrottleMs);
        remaining -= processed;
      }
      if (shouldLog("labels:reconcile", 5 * 60_000)) {
        log("[ralph:labels] Reconcile tick complete");
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
