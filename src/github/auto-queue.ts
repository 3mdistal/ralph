import { type RepoConfig, getRepoAutoQueueConfig } from "../config";
import { isRepoAllowed } from "../github-app-auth";
import { shouldLog } from "../logging";
import { listIssueSnapshots, type IssueSnapshot } from "../state";
import { computeBlockedDecision, type BlockedDecision } from "./issue-blocking-core";
import { applyIssueLabelWriteback } from "./issue-label-writeback";
import { addIssueLabel, addIssueLabels, removeIssueLabel } from "./issue-label-io";
import { mutateIssueLabels } from "./label-mutation";
import { GitHubClient } from "./client";
import { createRalphWorkflowLabelsEnsurer } from "./ensure-ralph-workflow-labels";
import { GitHubRelationshipProvider } from "./issue-relationships";
import { resolveRelationshipSignals } from "./relationship-signals";
import { detectLegacyStatusLabels, formatLegacyStatusDiagnostic, getStatusLabels, planSetStatus, RALPH_STATUS_LABELS } from "./status-labels";
import type { QueueTaskStatus } from "../queue/types";

const AUTO_QUEUE_DEBOUNCE_MS = 500;

export type AutoQueueLabelPlan = {
  add: string[];
  remove: string[];
  blocked: BlockedDecision;
  runnable: boolean;
  skipped: boolean;
  reason?: string;
};

function hasRalphLabel(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase().startsWith("ralph:"));
}

function shouldSkipIssue(issue: IssueSnapshot): { skip: boolean; reason?: string } {
  if (issue.state?.toUpperCase() === "CLOSED") return { skip: true, reason: "closed" };
  const labels = issue.labels ?? [];
  const statusLabels = getStatusLabels(labels);
  if (statusLabels.length > 1) return { skip: true, reason: "invalid-status" };
  const statusLabel = statusLabels[0];
  if (!statusLabel) return { skip: false };
  if (statusLabel === RALPH_STATUS_LABELS.inProgress) return { skip: true, reason: "in-progress" };
  if (statusLabel === RALPH_STATUS_LABELS.inBot || statusLabel === RALPH_STATUS_LABELS.done) {
    return { skip: true, reason: "done" };
  }
  if (statusLabel === RALPH_STATUS_LABELS.paused || statusLabel === RALPH_STATUS_LABELS.throttled) {
    return { skip: true, reason: "paused" };
  }
  if (statusLabel === RALPH_STATUS_LABELS.stuck) return { skip: true, reason: "stuck" };
  return { skip: false };
}

export function computeAutoQueueLabelPlan(params: {
  issue: IssueSnapshot;
  blocked: BlockedDecision;
  scope: "labeled-only" | "all-open";
}): AutoQueueLabelPlan {
  const labels = params.issue.labels ?? [];
  const skipCheck = shouldSkipIssue(params.issue);
  if (skipCheck.skip) {
    return { add: [], remove: [], blocked: params.blocked, runnable: false, skipped: true, reason: skipCheck.reason };
  }

  if (params.scope === "labeled-only" && !hasRalphLabel(labels)) {
    return { add: [], remove: [], blocked: params.blocked, runnable: false, skipped: true, reason: "out-of-scope" };
  }

  if (params.blocked.confidence === "unknown") {
    return { add: [], remove: [], blocked: params.blocked, runnable: false, skipped: true, reason: "unknown" };
  }

  const targetStatus: QueueTaskStatus = params.blocked.blocked ? "blocked" : "queued";
  const delta = planSetStatus({ desired: targetStatus, currentLabels: labels });
  return {
    add: delta.add,
    remove: delta.remove,
    blocked: params.blocked,
    runnable: !params.blocked.blocked,
    skipped: delta.add.length === 0 && delta.remove.length === 0,
  };
}

export type AutoQueueResult = {
  ok: boolean;
  considered: number;
  updated: number;
  skipped: number;
  errors: number;
  hadChanges: boolean;
};

async function runAutoQueueOnce(params: {
  repo: RepoConfig;
  now?: () => Date;
}): Promise<AutoQueueResult> {
  const autoQueue = getRepoAutoQueueConfig(params.repo.name);
  if (!autoQueue || !autoQueue.enabled) {
    return { ok: true, considered: 0, updated: 0, skipped: 0, errors: 0, hadChanges: false };
  }
  if (!isRepoAllowed(params.repo.name)) {
    return { ok: true, considered: 0, updated: 0, skipped: 0, errors: 0, hadChanges: false };
  }

  const now = params.now ? params.now() : new Date();
  const nowIso = now.toISOString();
  const candidates = listIssueSnapshots(params.repo.name, {
    includeClosed: false,
    onlyRalph: autoQueue.scope === "labeled-only",
  });
  const limit = Math.max(0, autoQueue.maxPerTick);
  const issues = limit > 0 ? candidates.slice(0, limit) : candidates;

  if (issues.length === 0) {
    return { ok: true, considered: 0, updated: 0, skipped: 0, errors: 0, hadChanges: false };
  }

  const github = new GitHubClient(params.repo.name);
  const relationships = new GitHubRelationshipProvider(params.repo.name, github);
  const labelEnsurer = createRalphWorkflowLabelsEnsurer({
    githubFactory: (repo) => new GitHubClient(repo),
  });
  const labelIdCache = new Map<string, string>();

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let hadChanges = false;

  for (const issue of issues) {
    const skip = shouldSkipIssue(issue);
    if (skip.skip) {
      skipped += 1;
      continue;
    }

    const legacy = detectLegacyStatusLabels(issue.labels ?? []);
    if (legacy.length > 0 && shouldLog(`auto-queue:legacy:${issue.repo}#${issue.number}`, 60_000)) {
      console.warn(formatLegacyStatusDiagnostic({ repo: issue.repo, issueNumber: issue.number, legacyLabels: legacy }));
    }

    if (autoQueue.scope === "labeled-only" && !hasRalphLabel(issue.labels)) {
      skipped += 1;
      continue;
    }

    let snapshot;
    try {
      snapshot = await relationships.getSnapshot({ repo: issue.repo, number: issue.number });
    } catch (error: any) {
      errors += 1;
      if (shouldLog(`auto-queue:relationship:${issue.repo}#${issue.number}`, 60_000)) {
        console.warn(
          `[ralph:auto-queue:${issue.repo}] Failed relationship fetch for #${issue.number}: ${error?.message ?? String(error)}`
        );
      }
      continue;
    }

    const resolved = resolveRelationshipSignals(snapshot);
    const decision = computeBlockedDecision(resolved.signals);
    const plan = computeAutoQueueLabelPlan({ issue, blocked: decision, scope: autoQueue.scope });

    if (plan.skipped || (plan.add.length === 0 && plan.remove.length === 0)) {
      skipped += 1;
      continue;
    }

    if (autoQueue.dryRun) {
      updated += 1;
      hadChanges = true;
      continue;
    }

    try {
      const result = await applyIssueLabelWriteback({
        io: {
          mutateIssueLabels: async ({ repo, issueNumber, issueNodeId, add, remove }) => {
            const outcome = await mutateIssueLabels({
              github,
              repo,
              issueNumber,
              issueNodeId,
              plan: { add, remove },
              labelIdCache,
            });
            return outcome.ok;
          },
          addIssueLabel: async (repo, issueNumber, label) => {
            await addIssueLabel({ github, repo, issueNumber, label });
          },
          addIssueLabels: async (repo, issueNumber, labels) => {
            await addIssueLabels({ github, repo, issueNumber, labels });
          },
          removeIssueLabel: async (repo, issueNumber, label) => {
            return await removeIssueLabel({ github, repo, issueNumber, label, allowNotFound: true });
          },
        },
        repo: issue.repo,
        issueNumber: issue.number,
        issueNodeId: issue.githubNodeId,
        add: plan.add,
        remove: plan.remove,
        nowIso,
        logLabel: `${issue.repo}#${issue.number}`,
        log: (message) => console.warn(`[ralph:auto-queue:${issue.repo}] ${message}`),
        ensureLabels: async () => await labelEnsurer.ensure(issue.repo),
      });

      if (!result.ok) {
        errors += 1;
        const failure = result.result;
        if (!failure.ok && failure.kind !== "transient") {
          if (shouldLog(`auto-queue:label:${issue.repo}#${issue.number}`, 60_000)) {
            console.warn(
              `[ralph:auto-queue:${issue.repo}] Failed label update for #${issue.number}: ${failure.error}`
            );
          }
        }
        continue;
      }

      updated += 1;
      hadChanges = true;
    } catch (error: any) {
      errors += 1;
      if (shouldLog(`auto-queue:label:${issue.repo}#${issue.number}`, 60_000)) {
        console.warn(
          `[ralph:auto-queue:${issue.repo}] Failed label update for #${issue.number}: ${error?.message ?? String(error)}`
        );
      }
    }
  }

  return {
    ok: errors === 0,
    considered: issues.length,
    updated,
    skipped,
    errors,
    hadChanges,
  };
}

export type AutoQueueRunner = {
  schedule: (repo: RepoConfig, reason: "startup" | "sync") => void;
};

export function createAutoQueueRunner(params: {
  scheduleQueuedTasksSoon: () => void;
}): AutoQueueRunner {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();

  const schedule = (repo: RepoConfig, reason: "startup" | "sync") => {
    const config = getRepoAutoQueueConfig(repo.name);
    if (!config || !config.enabled) return;

    const key = repo.name;
    if (pending.has(key)) return;
    const timer = setTimeout(() => {
      pending.delete(key);
      if (inFlight.has(key)) return;
      inFlight.add(key);
      void runAutoQueueOnce({ repo })
        .then((result) => {
          if (result.hadChanges) {
            params.scheduleQueuedTasksSoon();
          }
          if (shouldLog(`auto-queue:${reason}:${repo.name}`, 60_000)) {
            console.log(
              `[ralph:auto-queue:${repo.name}] ${reason} sweep: ` +
                `considered=${result.considered} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}`
            );
          }
        })
        .finally(() => {
          inFlight.delete(key);
        });
    }, AUTO_QUEUE_DEBOUNCE_MS);
    pending.set(key, timer);
  };

  return { schedule };
}
