import { type RepoConfig, getRepoAutoQueueConfig } from "../config";
import { isRepoAllowed } from "../github-app-auth";
import { shouldLog } from "../logging";
import { getIssueLabels, listIssueSnapshots, recordIssueLabelsSnapshot, type IssueSnapshot } from "../state";
import { computeBlockedDecision, type BlockedDecision } from "./issue-blocking-core";
import { addIssueLabel, applyIssueLabelOps, planIssueLabelOps, removeIssueLabel } from "./issue-label-io";
import { GitHubClient } from "./client";
import { createRalphWorkflowLabelsEnsurer } from "./ensure-ralph-workflow-labels";
import { GitHubRelationshipProvider } from "./issue-relationships";
import { resolveRelationshipSignals } from "./relationship-signals";

const RALPH_LABEL_QUEUED = "ralph:queued";
const RALPH_LABEL_BLOCKED = "ralph:blocked";
const RALPH_LABEL_DONE = "ralph:done";
const RALPH_LABEL_IN_BOT = "ralph:in-bot";
const RALPH_LABEL_IN_PROGRESS = "ralph:in-progress";
const RALPH_LABEL_ESCALATED = "ralph:escalated";

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
  if (labels.includes(RALPH_LABEL_DONE) || labels.includes(RALPH_LABEL_IN_BOT)) {
    return { skip: true, reason: "done" };
  }
  if (labels.includes(RALPH_LABEL_IN_PROGRESS)) return { skip: true, reason: "in-progress" };
  if (labels.includes(RALPH_LABEL_ESCALATED)) return { skip: true, reason: "escalated" };
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

  const add: string[] = [];
  const remove: string[] = [];
  const hasQueued = labels.includes(RALPH_LABEL_QUEUED);
  const hasBlocked = labels.includes(RALPH_LABEL_BLOCKED);

  if (params.blocked.blocked) {
    if (!hasBlocked) add.push(RALPH_LABEL_BLOCKED);
    return { add, remove, blocked: params.blocked, runnable: false, skipped: add.length === 0 };
  }

  if (hasBlocked) remove.push(RALPH_LABEL_BLOCKED);
  if (!hasQueued) add.push(RALPH_LABEL_QUEUED);
  return { add, remove, blocked: params.blocked, runnable: true, skipped: add.length === 0 && remove.length === 0 };
}

function applyLabelDelta(params: {
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

export type AutoQueueResult = {
  ok: boolean;
  considered: number;
  updated: number;
  skipped: number;
  errors: number;
  hadChanges: boolean;
};

export async function runAutoQueueOnce(params: {
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
      const ops = planIssueLabelOps({ add: plan.add, remove: plan.remove });
      if (ops.length === 0) {
        skipped += 1;
        continue;
      }

      const io = {
        addLabel: async (label: string) => {
          await addIssueLabel({ github, repo: issue.repo, issueNumber: issue.number, label });
        },
        removeLabel: async (label: string) => {
          return await removeIssueLabel({ github, repo: issue.repo, issueNumber: issue.number, label, allowNotFound: true });
        },
      };

      const result = await applyIssueLabelOps({
        ops,
        io,
        logLabel: `${issue.repo}#${issue.number}`,
        log: (message) => console.warn(`[ralph:auto-queue:${issue.repo}] ${message}`),
        ensureLabels: async () => await labelEnsurer.ensure(issue.repo),
        retryMissingLabelOnce: true,
      });

      if (!result.ok) {
        errors += 1;
        continue;
      }

      applyLabelDelta({
        repo: issue.repo,
        issueNumber: issue.number,
        add: result.add,
        remove: result.remove,
        nowIso,
      });

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
