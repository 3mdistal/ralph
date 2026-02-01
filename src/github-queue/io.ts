import { getConfig, getRepoAutoQueueConfig } from "../config";
import { resolveGitHubToken } from "../github-auth";
import { GitHubClient, splitRepoFullName } from "../github/client";
import { mutateIssueLabels } from "../github/label-mutation";
import { applyIssueLabelWriteback } from "../github/issue-label-writeback";
import { createRalphWorkflowLabelsEnsurer, type EnsureOutcome } from "../github/ensure-ralph-workflow-labels";
import { computeBlockedDecision } from "../github/issue-blocking-core";
import { parseIssueRef, type IssueRef } from "../github/issue-ref";
import { GitHubRelationshipProvider, type IssueRelationshipProvider } from "../github/issue-relationships";
import { resolveRelationshipSignals } from "../github/relationship-signals";
import { canActOnTask, isHeartbeatStale } from "../ownership";
import { shouldLog } from "../logging";
import { addIssueLabel as addIssueLabelIo, addIssueLabels as addIssueLabelsIo, removeIssueLabel as removeIssueLabelIo } from "../github/issue-label-io";
import { detectLegacyStatusLabels, formatLegacyStatusDiagnostic, getStatusLabels, RALPH_STATUS_LABELS } from "../github/status-labels";
import {
  getIssueSnapshotByNumber,
  getTaskOpStateByPath,
  listIssueSnapshotsWithRalphLabels,
  listOpenPrCandidatesForIssue,
  listTaskOpStatesByRepo,
  recordTaskSnapshot,
  releaseTaskSlot,
  type IssueSnapshot,
  type TaskOpState,
} from "../state";
import type { AgentTask, QueueChangeHandler, QueueTask, QueueTaskStatus } from "../queue/types";
import { computeStaleInProgressRecovery, deriveTaskView, planClaim, statusToRalphLabelDelta } from "./core";

const SWEEP_INTERVAL_MS = 5 * 60_000;
const WATCH_MIN_INTERVAL_MS = 1000;

const DEFAULT_BLOCKED_SWEEP_MAX_ISSUES_PER_REPO = 25;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

type GitHubQueueDeps = {
  now?: () => Date;
  io?: GitHubQueueIO;
  relationshipsProviderFactory?: (repo: string) => IssueRelationshipProvider;
};

type GitHubQueueIO = {
  ensureWorkflowLabels: (repo: string) => Promise<EnsureOutcome>;
  listIssueLabels: (repo: string, issueNumber: number) => Promise<string[]>;
  reopenIssue: (repo: string, issueNumber: number) => Promise<void>;
  addIssueLabel: (repo: string, issueNumber: number, label: string) => Promise<void>;
  addIssueLabels: (repo: string, issueNumber: number, labels: string[]) => Promise<void>;
  removeIssueLabel: (repo: string, issueNumber: number, label: string) => Promise<{ removed: boolean }>;
  mutateIssueLabels: (params: {
    repo: string;
    issueNumber: number;
    issueNodeId?: string | null;
    add: string[];
    remove: string[];
  }) => Promise<boolean>;
};

function getNowIso(deps?: GitHubQueueDeps): string {
  return (deps?.now ? deps.now() : new Date()).toISOString();
}

function getNowMs(deps?: GitHubQueueDeps): number {
  return deps?.now ? deps.now().valueOf() : Date.now();
}

async function createGitHubClient(repo: string): Promise<GitHubClient> {
  const token = await resolveGitHubToken();
  if (!token) {
    throw new Error("GitHub auth is not configured");
  }
  return new GitHubClient(repo, { getToken: resolveGitHubToken });
}

function createGitHubQueueIo(): GitHubQueueIO {
  const labelEnsurer = createRalphWorkflowLabelsEnsurer({
    githubFactory: (repo) => new GitHubClient(repo, { getToken: resolveGitHubToken }),
  });
  const labelIdCacheByRepo = new Map<string, Map<string, string>>();

  return {
    ensureWorkflowLabels: async (repo) => await labelEnsurer.ensure(repo),
    listIssueLabels: async (repo, issueNumber) => {
      const { owner, name } = splitRepoFullName(repo);
      const client = await createGitHubClient(repo);
      const response = await client.request<Array<{ name?: string | null }>>(
        `/repos/${owner}/${name}/issues/${issueNumber}/labels?per_page=100`
      );
      return (response.data ?? []).map((label) => label?.name ?? "").filter(Boolean);
    },
    reopenIssue: async (repo, issueNumber) => {
      const { owner, name } = splitRepoFullName(repo);
      const client = await createGitHubClient(repo);
      await client.request(`/repos/${owner}/${name}/issues/${issueNumber}`, {
        method: "PATCH",
        body: { state: "open" },
      });
    },
    addIssueLabel: async (repo, issueNumber, label) => {
      const client = await createGitHubClient(repo);
      await addIssueLabelIo({ github: client, repo, issueNumber, label });
    },
    addIssueLabels: async (repo, issueNumber, labels) => {
      const client = await createGitHubClient(repo);
      await addIssueLabelsIo({ github: client, repo, issueNumber, labels });
    },
    removeIssueLabel: async (repo, issueNumber, label) => {
      const client = await createGitHubClient(repo);
      return await removeIssueLabelIo({ github: client, repo, issueNumber, label, allowNotFound: true });
    },
    mutateIssueLabels: async ({ repo, issueNumber, issueNodeId, add, remove }) => {
      const client = await createGitHubClient(repo);
      let cache = labelIdCacheByRepo.get(repo);
      if (!cache) {
        cache = new Map<string, string>();
        labelIdCacheByRepo.set(repo, cache);
      }
      const result = await mutateIssueLabels({
        github: client,
        repo,
        issueNumber,
        issueNodeId,
        plan: { add, remove },
        labelIdCache: cache,
      });
      return result.ok;
    },
  };
}

function buildIssueRefFromTask(task: QueueTask): IssueRef | null {
  return parseIssueRef(task.issue, task.repo);
}

function buildTaskOpStateMap(repo: string): Map<number, TaskOpState> {
  const map = new Map<number, TaskOpState>();
  for (const state of listTaskOpStatesByRepo(repo)) {
    if (typeof state.issueNumber !== "number") continue;
    if (!map.has(state.issueNumber)) {
      map.set(state.issueNumber, state);
    }
  }
  return map;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildOwnershipSkipReason(state: TaskOpState, daemonId: string, nowMs: number, ttlMs: number): string {
  const owner = state.daemonId?.trim() ?? "";
  const heartbeatAt = state.heartbeatAt?.trim() ?? "";
  const isStale = isHeartbeatStale(heartbeatAt, nowMs, ttlMs);
  if (owner && owner !== daemonId) {
    return `Task owned by ${owner}; heartbeat ${isStale ? "stale" : "fresh"}`;
  }
  return "Task has fresh heartbeat";
}

function resolveIssueSnapshot(repo: string, issueNumber: number): IssueSnapshot | null {
  return getIssueSnapshotByNumber(repo, issueNumber);
}

export function createGitHubQueueDriver(deps?: GitHubQueueDeps) {
  const io = deps?.io ?? createGitHubQueueIo();
  const relationshipsProviderFactory =
    deps?.relationshipsProviderFactory ?? ((repo: string) => new GitHubRelationshipProvider(repo));
  let lastSweepAt = 0;
  let lastClosedSweepAt = 0;
  let lastBlockedSweepAt = 0;
  let stopRequested = false;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchInFlight = false;

  const applyLabelDelta = async (params: {
    repo: string;
    issueNumber: number;
    issueNodeId?: string | null;
    add: string[];
    remove: string[];
    nowIso: string;
    logLabel?: string;
  }): Promise<{ ok: boolean; transient: boolean }> => {
    const result = await applyIssueLabelWriteback({
      io: {
        mutateIssueLabels: io.mutateIssueLabels,
        addIssueLabel: io.addIssueLabel,
        addIssueLabels: io.addIssueLabels,
        removeIssueLabel: io.removeIssueLabel,
      },
      repo: params.repo,
      issueNumber: params.issueNumber,
      issueNodeId: params.issueNodeId,
      add: params.add,
      remove: params.remove,
      nowIso: params.nowIso,
      logLabel: params.logLabel,
      log: (message: string) => console.warn(`[ralph:queue:github] ${message}`),
      ensureLabels: async () => await io.ensureWorkflowLabels(params.repo),
    });

    if (!result.ok) {
      const failure = result.result;
      if (!failure.ok && failure.kind === "transient") {
        return { ok: false, transient: true };
      }
      throw failure.error;
    }

    return { ok: true, transient: false };
  };

  const logLegacyLabels = (repo: string, issueNumber: number, labels: string[]) => {
    const legacy = detectLegacyStatusLabels(labels);
    if (legacy.length === 0) return;
    const key = `legacy-status:${repo}#${issueNumber}:${legacy.sort().join(",")}`;
    if (!shouldLog(key, 60_000)) return;
    console.warn(formatLegacyStatusDiagnostic({ repo, issueNumber, legacyLabels: legacy }));
  };

  const maybeSweepBlockedLabels = async (): Promise<void> => {
    const nowMs = getNowMs(deps);
    if (nowMs - lastBlockedSweepAt < SWEEP_INTERVAL_MS) return;
    lastBlockedSweepAt = nowMs;

    const nowIso = getNowIso(deps);

    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      if (stopRequested) return;
      const autoQueueEnabled = getRepoAutoQueueConfig(repo)?.enabled ?? false;
      if (!autoQueueEnabled) continue;

      const maxIssues = clampPositiveInt(
        readEnvInt("RALPH_GITHUB_QUEUE_BLOCKED_SWEEP_MAX_ISSUES", DEFAULT_BLOCKED_SWEEP_MAX_ISSUES_PER_REPO),
        DEFAULT_BLOCKED_SWEEP_MAX_ISSUES_PER_REPO
      );

      const provider = relationshipsProviderFactory(repo);
      let processed = 0;

      const issues = listIssueSnapshotsWithRalphLabels(repo);
      for (const issue of issues) {
        if (stopRequested) return;
        if (processed >= maxIssues) break;
        if ((issue.state ?? "").toUpperCase() === "CLOSED") continue;
        logLegacyLabels(repo, issue.number, issue.labels);
        const statusLabels = getStatusLabels(issue.labels);
        if (statusLabels.length !== 1 || statusLabels[0] !== RALPH_STATUS_LABELS.queued) continue;

        try {
          const snapshot = await provider.getSnapshot({ repo, number: issue.number });
          const resolved = resolveRelationshipSignals(snapshot);
          const decision = computeBlockedDecision(resolved.signals);

          // IMPORTANT: unknown dependency coverage should NOT cause blocked label churn.
          // Only write the blocked label when we are certain the issue is blocked.
          if (decision.confidence === "unknown") {
            continue;
          }

          const targetStatus = decision.blocked ? "blocked" : "queued";
          const delta = statusToRalphLabelDelta(targetStatus, issue.labels);
          if (delta.add.length === 0 && delta.remove.length === 0) continue;

          const result = await applyLabelDelta({
            repo,
            issueNumber: issue.number,
            issueNodeId: issue.githubNodeId,
            add: delta.add,
            remove: delta.remove,
            nowIso,
            logLabel: `${repo}#${issue.number}`,
          });
          if (!result.ok && !result.transient) {
            throw new Error("Failed to update blocked status labels");
          }
        } catch (error: any) {
          console.warn(
            `[ralph:queue:github] Failed to reconcile blocked label for ${repo}#${issue.number}: ${error?.message ?? String(error)}`
          );
        } finally {
          processed += 1;
        }
      }
    }
  };

  const maybeSweepClosedIssues = async (): Promise<void> => {
    const nowMs = getNowMs(deps);
    if (nowMs - lastClosedSweepAt < SWEEP_INTERVAL_MS) return;
    lastClosedSweepAt = nowMs;

    const nowIso = getNowIso(deps);

    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      const opStateByIssue = buildTaskOpStateMap(repo);
      const issues = listIssueSnapshotsWithRalphLabels(repo);

      for (const issue of issues) {
        if (stopRequested) return;
        if ((issue.state ?? "").toUpperCase() !== "CLOSED") continue;

        const openPrs = listOpenPrCandidatesForIssue(repo, issue.number);
        const opState = opStateByIssue.get(issue.number) ?? null;
        const isReleased = typeof opState?.releasedAtMs === "number" && Number.isFinite(opState.releasedAtMs);

        // If a tracked PR is still open, keep the issue open.
        if (openPrs.length > 0) {
          try {
            await io.reopenIssue(repo, issue.number);
          } catch (error: any) {
            console.warn(
              `[ralph:queue:github] Failed to reopen closed issue with open PR ${repo}#${issue.number}: ${error?.message ?? String(error)}`
            );
          }

          try {
            if (!isReleased) {
              releaseTaskSlot({
                repo,
                issueNumber: issue.number,
                taskPath: `github:${repo}#${issue.number}`,
                releasedReason: "closed-with-open-pr",
                status: "queued",
              });
            }

            const delta = statusToRalphLabelDelta("queued", issue.labels);
            const result = await applyLabelDelta({
              repo,
              issueNumber: issue.number,
              issueNodeId: issue.githubNodeId,
              add: delta.add,
              remove: delta.remove,
              nowIso,
              logLabel: `${repo}#${issue.number}`,
            });
            if (!result.ok && !result.transient) {
              throw new Error("Failed to update queued status labels");
            }
          } catch (error: any) {
            console.warn(
              `[ralph:queue:github] Failed to reconcile labels for reopened issue ${repo}#${issue.number}: ${error?.message ?? String(error)}`
            );
          }

          continue;
        }

        // Otherwise: issue is closed and no active PR is tracked. Release locally and clear Ralph workflow labels.
        try {
          if (!isReleased) {
            releaseTaskSlot({
              repo,
              issueNumber: issue.number,
              taskPath: `github:${repo}#${issue.number}`,
              releasedReason: "issue-closed",
              status: "queued",
            });
          }

          const remove = issue.labels.filter((label) => label.toLowerCase().startsWith("ralph:"));
          if (remove.length > 0) {
            const result = await applyLabelDelta({
              repo,
              issueNumber: issue.number,
              issueNodeId: issue.githubNodeId,
              add: [],
              remove,
              nowIso,
              logLabel: `${repo}#${issue.number}`,
            });
            if (!result.ok && !result.transient) {
              throw new Error("Failed to clear workflow labels");
            }
          }
        } catch (error: any) {
          console.warn(
            `[ralph:queue:github] Failed to reconcile closed issue ${repo}#${issue.number}: ${error?.message ?? String(error)}`
          );
        }
      }
    }
  };

  const maybeSweepStaleInProgress = async (): Promise<void> => {
    const nowMs = getNowMs(deps);
    if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = nowMs;

    const ttlMs = getConfig().ownershipTtlMs;
    const nowIso = getNowIso(deps);

    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      const opStateByIssue = buildTaskOpStateMap(repo);
      const issues = listIssueSnapshotsWithRalphLabels(repo);

      for (const issue of issues) {
        if (stopRequested) return;
        logLegacyLabels(repo, issue.number, issue.labels);
        const statusLabels = getStatusLabels(issue.labels);
        if (statusLabels.length !== 1 || statusLabels[0] !== RALPH_STATUS_LABELS.inProgress) continue;
        const opState = opStateByIssue.get(issue.number) ?? null;
        const recovery = computeStaleInProgressRecovery({
          labels: issue.labels,
          opState,
          nowMs,
          ttlMs,
        });
        if (!recovery.shouldRecover) continue;

        try {
          releaseTaskSlot({
            repo,
            issueNumber: issue.number,
            taskPath: `github:${repo}#${issue.number}`,
            releasedReason: recovery.reason ?? "stale-in-progress",
            status: "queued",
          });

          const delta = statusToRalphLabelDelta("queued", issue.labels);
          const result = await applyLabelDelta({
            repo,
            issueNumber: issue.number,
            issueNodeId: issue.githubNodeId,
            add: delta.add,
            remove: delta.remove,
            nowIso,
            logLabel: `${repo}#${issue.number}`,
          });
          if (!result.ok && !result.transient) {
            throw new Error("Failed to requeue stale in-progress issue");
          }

          const reason = recovery.reason ? ` reason=${recovery.reason}` : "";
          console.warn(`[ralph:queue:github] Recovered stale in-progress issue ${repo}#${issue.number}; released locally${reason}`);
        } catch (error: any) {
          console.warn(
            `[ralph:queue:github] Failed to recover stale in-progress ${repo}#${issue.number}: ${error?.message ?? String(error)}`
          );
        }
      }
    }
  };

  const buildTasksForRepo = (repo: string): AgentTask[] => {
    const nowIso = getNowIso(deps);
    const opStateByIssue = buildTaskOpStateMap(repo);
    const issues = listIssueSnapshotsWithRalphLabels(repo);
    return issues.map((issue) => deriveTaskView({ issue, opState: opStateByIssue.get(issue.number), nowIso }));
  };

  const listTasksByStatus = async (status: QueueTaskStatus): Promise<AgentTask[]> => {
    if (status === "starting" || status === "throttled") return [];
    await maybeSweepClosedIssues();
    await maybeSweepStaleInProgress();
    await maybeSweepBlockedLabels();

    const tasks: AgentTask[] = [];
    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      for (const task of buildTasksForRepo(repo)) {
        if (task.status === status) tasks.push(task);
      }
    }
    return tasks;
  };

  return {
    name: "github" as const,
    initialPoll: async (): Promise<QueueTask[]> => {
      await maybeSweepStaleInProgress();
      return await listTasksByStatus("queued");
    },
    startWatching: (onChange: QueueChangeHandler): void => {
      const intervalMs = Math.max(getConfig().pollInterval, WATCH_MIN_INTERVAL_MS);

      const tick = async () => {
        if (stopRequested) return;
        if (watchInFlight) {
          watchTimer = setTimeout(tick, intervalMs);
          return;
        }
        watchInFlight = true;
        try {
          const tasks = await listTasksByStatus("queued");
          try {
            await Promise.resolve(onChange(tasks));
          } catch (error: any) {
            console.warn(
              `[ralph:queue:github] Queue watcher handler failed: ${error?.message ?? String(error)}`
            );
          }
        } catch (error: any) {
          console.warn(`[ralph:queue:github] Queue watcher failed: ${error?.message ?? String(error)}`);
        } finally {
          watchInFlight = false;
          if (!stopRequested) {
            watchTimer = setTimeout(tick, intervalMs);
          }
        }
      };

      void tick();
    },
    stopWatching: (): void => {
      stopRequested = true;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = null;
    },
    getQueuedTasks: async (): Promise<QueueTask[]> => {
      return await listTasksByStatus("queued");
    },
    getTasksByStatus: async (status: QueueTaskStatus): Promise<QueueTask[]> => {
      return await listTasksByStatus(status);
    },
    getTaskByPath: async (taskPath: string): Promise<QueueTask | null> => {
      const match = taskPath.match(/^github:(.+)#(\d+)$/);
      if (!match) return null;
      const repo = match[1];
      const issueNumber = Number.parseInt(match[2], 10);
      if (!repo || !Number.isFinite(issueNumber)) return null;

      const issue = resolveIssueSnapshot(repo, issueNumber);
      if (!issue) return null;
      const opState = getTaskOpStateByPath(repo, taskPath);
      return deriveTaskView({ issue, opState, nowIso: getNowIso(deps) });
    },
    tryClaimTask: async (opts: {
      task: QueueTask;
      daemonId: string;
      nowMs: number;
    }): Promise<{ claimed: boolean; task: QueueTask | null; reason?: string }> => {
      const issueRef = buildIssueRefFromTask(opts.task);
      if (!issueRef) return { claimed: false, task: null, reason: "Invalid issue reference" };

      const issue = resolveIssueSnapshot(issueRef.repo, issueRef.number);
      if (!issue) return { claimed: false, task: null, reason: "Issue snapshot missing" };
      if (issue.state?.toUpperCase() === "CLOSED") {
        return { claimed: false, task: opts.task, reason: "Issue is closed" };
      }

      const opStateByIssue = buildTaskOpStateMap(issueRef.repo);
      const opState = opStateByIssue.get(issueRef.number) ?? {
        repo: issueRef.repo,
        issueNumber: issueRef.number,
        taskPath: opts.task._path || `github:${issueRef.repo}#${issueRef.number}`,
      };

      if (opts.task.status === "queued") {
        let plan = planClaim(issue.labels);
        try {
          const liveLabels = await io.listIssueLabels(issueRef.repo, issueRef.number);
          logLegacyLabels(issueRef.repo, issueRef.number, liveLabels);
          const autoQueueEnabled = getRepoAutoQueueConfig(issueRef.repo)?.enabled ?? false;
          const liveStatusLabels = getStatusLabels(liveLabels);
          const hasBlocked = liveStatusLabels.includes(RALPH_STATUS_LABELS.blocked);
          const shouldCheckDependencies = hasBlocked || autoQueueEnabled;
          if (shouldCheckDependencies) {
            try {
              const relationships = relationshipsProviderFactory(issueRef.repo);
              const snapshot = await relationships.getSnapshot(issueRef);
              const resolved = resolveRelationshipSignals(snapshot);
              const decision = computeBlockedDecision(resolved.signals);

              if (decision.confidence === "unknown") {
                // Unknown dependency coverage is not a blocker for claiming.
                // Treat it as best-effort signal gathering rather than a hard gate.
                if (shouldLog(`deps:unknown:${issueRef.repo}#${issueRef.number}`, 60_000)) {
                  console.warn(
                    `[ralph:queue:github] Dependency coverage unknown for ${issueRef.repo}#${issueRef.number}; proceeding without blocked label gating`
                  );
                }
              } else if (decision.blocked) {
                const reason =
                  decision.reasons.length > 0
                    ? `Issue blocked by dependencies (${decision.reasons.join(", ")})`
                    : "Issue blocked by dependencies";

                // Best-effort: materialize blocked label for visibility.
                if (autoQueueEnabled && !hasBlocked) {
                  try {
                    const nowIso = new Date(opts.nowMs).toISOString();
                    const delta = statusToRalphLabelDelta("blocked", liveLabels);
                    if (delta.add.length > 0 || delta.remove.length > 0) {
                      await applyLabelDelta({
                        repo: issueRef.repo,
                        issueNumber: issueRef.number,
                        issueNodeId: issue.githubNodeId,
                        add: delta.add,
                        remove: delta.remove,
                        nowIso,
                        logLabel: `${issueRef.repo}#${issueRef.number}`,
                      });
                    }
                  } catch {
                    // best-effort
                  }
                }
                return { claimed: false, task: opts.task, reason };
              }
            } catch (error: any) {
              return { claimed: false, task: opts.task, reason: error?.message ?? String(error) };
            }
          }
          plan = planClaim(liveLabels);
          if (!plan.claimable) {
            return { claimed: false, task: opts.task, reason: plan.reason ?? "Task not claimable" };
          }
        } catch (error: any) {
          return { claimed: false, task: opts.task, reason: error?.message ?? String(error) };
        }

        const nowIso = new Date(opts.nowMs).toISOString();
        const taskPath = opState.taskPath || `github:${issueRef.repo}#${issueRef.number}`;

        try {
          await io.ensureWorkflowLabels(issueRef.repo);
        } catch {
          // best-effort
        }

        const claimDelta = {
          add: plan.steps.filter((step) => step.action === "add").map((step) => step.label),
          remove: plan.steps.filter((step) => step.action === "remove").map((step) => step.label),
        };
        const result = await applyLabelDelta({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          issueNodeId: issue.githubNodeId,
          add: claimDelta.add,
          remove: claimDelta.remove,
          nowIso,
          logLabel: `${issueRef.repo}#${issueRef.number}`,
        });
        if (!result.ok && !result.transient) {
          return { claimed: false, task: opts.task, reason: "Failed to update claim labels" };
        }

        recordTaskSnapshot({
          repo: issueRef.repo,
          issue: `${issueRef.repo}#${issueRef.number}`,
          taskPath,
          status: "in-progress",
          daemonId: opts.daemonId,
          heartbeatAt: nowIso,
          releasedAtMs: null,
          releasedReason: null,
          at: nowIso,
        });

        const refreshed = resolveIssueSnapshot(issueRef.repo, issueRef.number) ?? issue;
        const view = deriveTaskView({
          issue: refreshed,
          opState: { ...opState, daemonId: opts.daemonId, heartbeatAt: nowIso, status: "in-progress" },
          nowIso,
        });

        return { claimed: true, task: view };
      }

      const ttlMs = getConfig().ownershipTtlMs;
      if (
        !canActOnTask(
          {
            "daemon-id": opState.daemonId ?? undefined,
            "heartbeat-at": opState.heartbeatAt ?? undefined,
          },
          opts.daemonId,
          opts.nowMs,
          ttlMs
        )
      ) {
        return { claimed: false, task: opts.task, reason: buildOwnershipSkipReason(opState, opts.daemonId, opts.nowMs, ttlMs) };
      }

      const nowIso = new Date(opts.nowMs).toISOString();
      recordTaskSnapshot({
        repo: issueRef.repo,
        issue: `${issueRef.repo}#${issueRef.number}`,
        taskPath: opState.taskPath,
        status: opts.task.status,
        daemonId: opts.daemonId,
        heartbeatAt: nowIso,
        releasedAtMs: null,
        releasedReason: null,
        at: nowIso,
      });

      const refreshed = resolveIssueSnapshot(issueRef.repo, issueRef.number) ?? issue;
      const view = deriveTaskView({
        issue: refreshed,
        opState: { ...opState, daemonId: opts.daemonId, heartbeatAt: nowIso, status: opts.task.status },
        nowIso,
      });
      return { claimed: true, task: view };
    },
    heartbeatTask: async (opts: { task: QueueTask; daemonId: string; nowMs: number }): Promise<boolean> => {
      const issueRef = buildIssueRefFromTask(opts.task);
      if (!issueRef) return false;

      const opState = getTaskOpStateByPath(issueRef.repo, opts.task._path);
      const owner = opState?.daemonId?.trim() ?? "";
      if (owner && owner !== opts.daemonId) return false;

      const nowIso = new Date(opts.nowMs).toISOString();
      recordTaskSnapshot({
        repo: issueRef.repo,
        issue: `${issueRef.repo}#${issueRef.number}`,
        taskPath: opts.task._path,
        status: opts.task.status,
        daemonId: opts.daemonId,
        heartbeatAt: nowIso,
        releasedAtMs: null,
        releasedReason: null,
        at: nowIso,
      });
      return true;
    },
    updateTaskStatus: async (
      task: QueueTask | Pick<QueueTask, "_path" | "_name" | "name" | "issue" | "repo"> | string,
      status: QueueTaskStatus,
      extraFields?: Record<string, string | number>
    ): Promise<boolean> => {
      const taskObj = typeof task === "object" ? task : null;
      if (!taskObj) return false;
      const issueRef = parseIssueRef(taskObj.issue, taskObj.repo);
      if (!issueRef) return false;

      const issue = resolveIssueSnapshot(issueRef.repo, issueRef.number);
      if (!issue) return false;

      const nowIso = getNowIso(deps);
      if (issue.state?.toUpperCase() === "CLOSED" && status === "done") {
        recordTaskSnapshot({
          repo: issueRef.repo,
          issue: `${issueRef.repo}#${issueRef.number}`,
          taskPath: taskObj._path || `github:${issueRef.repo}#${issueRef.number}`,
          status,
          sessionId: normalizeOptionalString(extraFields?.["session-id"]),
          worktreePath: normalizeOptionalString(extraFields?.["worktree-path"]),
          workerId: normalizeOptionalString(extraFields?.["worker-id"]),
          repoSlot: normalizeOptionalString(extraFields?.["repo-slot"]),
          daemonId: normalizeOptionalString(extraFields?.["daemon-id"]),
          heartbeatAt: normalizeOptionalString(extraFields?.["heartbeat-at"]),
          at: nowIso,
        });
        return true;
      }
      const delta = statusToRalphLabelDelta(status, issue.labels);
      const updateDelta = {
        add: delta.add,
        remove: delta.remove,
      };
      const result = await applyLabelDelta({
        repo: issueRef.repo,
        issueNumber: issueRef.number,
        issueNodeId: issue.githubNodeId,
        add: updateDelta.add,
        remove: updateDelta.remove,
        nowIso,
        logLabel: `${issueRef.repo}#${issueRef.number}`,
      });
      if (!result.ok && !result.transient) {
        return false;
      }

      const normalizedExtra: Record<string, string> = {};
      if (extraFields) {
        for (const [key, value] of Object.entries(extraFields)) {
          if (typeof value === "number") normalizedExtra[key] = String(value);
          else if (typeof value === "string") normalizedExtra[key] = value;
        }
      }

      recordTaskSnapshot({
        repo: issueRef.repo,
        issue: `${issueRef.repo}#${issueRef.number}`,
        taskPath: taskObj._path || `github:${issueRef.repo}#${issueRef.number}`,
        status,
        sessionId: normalizeOptionalString(normalizedExtra["session-id"]),
        worktreePath: normalizeOptionalString(normalizedExtra["worktree-path"]),
        workerId: normalizeOptionalString(normalizedExtra["worker-id"]),
        repoSlot: normalizeOptionalString(normalizedExtra["repo-slot"]),
        daemonId: normalizeOptionalString(normalizedExtra["daemon-id"]),
        heartbeatAt: normalizeOptionalString(normalizedExtra["heartbeat-at"]),
        releasedAtMs: status === "in-progress" || status === "starting" || status === "throttled" ? null : undefined,
        releasedReason: status === "in-progress" || status === "starting" || status === "throttled" ? null : undefined,
        at: nowIso,
      });

      return true;
    },
    createAgentTask: async () => {
      if (shouldLog("github-queue:create-task", 60_000)) {
        console.warn("[ralph:queue:github] createAgentTask is not supported for GitHub-backed queues");
      }
      return null;
    },
    resolveAgentTaskByIssue: async (issue: string, repo?: string): Promise<QueueTask | null> => {
      const baseRepo = repo ?? issue.split("#")[0] ?? "";
      const ref = parseIssueRef(issue, baseRepo);
      if (!ref) return null;
      const snapshot = resolveIssueSnapshot(ref.repo, ref.number);
      if (!snapshot) return null;
      const opState = buildTaskOpStateMap(ref.repo).get(ref.number);
      return deriveTaskView({ issue: snapshot, opState, nowIso: getNowIso(deps) });
    },
  };
}
