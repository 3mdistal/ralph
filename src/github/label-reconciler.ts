import { getConfig } from "../config";
import { shouldLog } from "../logging";
import {
  getIssueLabels,
  listIssueSnapshotsWithRalphLabels,
  listTaskOpStatesByRepo,
  recordIssueLabelsSnapshot,
} from "../state";
import { GitHubClient } from "./client";
import { createRalphWorkflowLabelsEnsurer } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps } from "./issue-label-io";
import { mutateIssueLabels } from "./label-mutation";
import { statusToRalphLabelDelta, type LabelOp } from "../github-queue/core";
import type { QueueTaskStatus } from "../queue/types";

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_ISSUES_PER_TICK = 10;

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
  if (raw === "throttled") return null;
  if (raw === "done") return null;
  return raw as QueueTaskStatus;
}

async function reconcileRepo(repo: string, maxIssues: number): Promise<number> {
  const nowIso = new Date().toISOString();
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
    const opState = opStateByIssue.get(issue.number);
    if (!opState) continue;

    const released = typeof opState.releasedAtMs === "number" && Number.isFinite(opState.releasedAtMs);
    const desiredStatus = released ? "queued" : toDesiredStatus(opState.status ?? null);
    if (!desiredStatus) continue;

    const delta = statusToRalphLabelDelta(desiredStatus, issue.labels);
    if (delta.add.length === 0 && delta.remove.length === 0) continue;

    const ops: LabelOp[] = [
      ...delta.add.map((label) => ({ action: "add" as const, label })),
      ...delta.remove.map((label) => ({ action: "remove" as const, label })),
    ];

    let didApply = false;
    const graphResult = await mutateIssueLabels({
      github,
      repo,
      issueNumber: issue.number,
      issueNodeId: issue.githubNodeId,
      plan: { add: delta.add, remove: delta.remove },
      labelIdCache,
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

    processed += 1;
  }

  return processed;
}

export function startGitHubLabelReconciler(params?: {
  intervalMs?: number;
  log?: (message: string) => void;
}): { stop: () => void } {
  const intervalMs = Math.max(1_000, params?.intervalMs ?? DEFAULT_INTERVAL_MS);
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
      let remaining = MAX_ISSUES_PER_TICK;
      for (const repo of repos) {
        if (remaining <= 0) break;
        const processed = await reconcileRepo(repo, remaining);
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
