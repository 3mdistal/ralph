import { getConfig, getRepoAutoQueueConfig } from "../config";
import { resolveGitHubToken } from "../github-auth";
import { GitHubClient, splitRepoFullName } from "../github/client";
import { mutateIssueLabels } from "../github/label-mutation";
import { createRalphWorkflowLabelsEnsurer, type EnsureOutcome } from "../github/ensure-ralph-workflow-labels";
import { computeBlockedDecision } from "../github/issue-blocking-core";
import { parseIssueRef, type IssueRef } from "../github/issue-ref";
import { GitHubRelationshipProvider, type IssueRelationshipProvider } from "../github/issue-relationships";
import { resolveRelationshipSignals } from "../github/relationship-signals";
import { logRelationshipDiagnostics } from "../github/relationship-diagnostics";
import { canActOnTask, isHeartbeatStale } from "../ownership";
import { shouldLog } from "../logging";
import {
  addIssueLabel as addIssueLabelIo,
  addIssueLabels as addIssueLabelsIo,
  applyIssueLabelOps,
  removeIssueLabel as removeIssueLabelIo,
} from "../github/issue-label-io";
import {
  getIssueLabels,
  getIssueSnapshotByNumber,
  getTaskOpStateByPath,
  getRepoLabelSchemeState,
  listIssueSnapshotsWithRalphLabels,
  listOpenPrCandidatesForIssue,
  listTaskOpStatesByRepo,
  recordIssueLabelsSnapshot,
  recordIssueSnapshot,
  recordTaskSnapshot,
  releaseTaskSlot,
  runInStateTransaction,
  type IssueSnapshot,
  type TaskOpState,
} from "../state";
import type { AgentTask, QueueChangeHandler, QueueTask, QueueTaskStatus } from "../queue/types";
import { computeStaleInProgressRecovery, deriveTaskView, planClaim, statusToRalphLabelDelta, type LabelOp } from "./core";
import {
  RALPH_LABEL_STATUS_ESCALATED,
  RALPH_LABEL_STATUS_IN_PROGRESS,
  RALPH_LABEL_STATUS_PAUSED,
  RALPH_LABEL_STATUS_QUEUED,
  RALPH_LABEL_STATUS_STOPPED,
  RALPH_STATUS_LABEL_PREFIX,
} from "../github-labels";

const SWEEP_INTERVAL_MS = 5 * 60_000;
const WATCH_MIN_INTERVAL_MS = 1000;

const DEFAULT_LIVE_LABELS_CACHE_TTL_MS = 60_000;
const DEFAULT_LIVE_LABELS_ERROR_COOLDOWN_MS = 60_000;
const LIVE_LABELS_TELEMETRY_SOURCE = "queue:claim:labels";

const DEFAULT_MISSING_SESSION_GRACE_MS = 2 * 60_000;

const DISABLE_SWEEPS_ENV = "RALPH_GITHUB_QUEUE_DISABLE_SWEEPS";

function shouldRunSweeps(): boolean {
  const raw = process.env[DISABLE_SWEEPS_ENV];
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on");
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function readEnvNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function clampNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
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
  fetchIssue: (repo: string, issueNumber: number) => Promise<IssueFetchResult | null>;
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

type IssueFetchResult = {
  title: string | null;
  state: string | null;
  url: string | null;
  githubNodeId: string | null;
  githubUpdatedAt: string | null;
  labels: string[];
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

  const liveLabelsCacheTtlMs = clampNonNegativeInt(
    readEnvNonNegativeInt("RALPH_GITHUB_QUEUE_LIVE_LABELS_TTL_MS", DEFAULT_LIVE_LABELS_CACHE_TTL_MS),
    DEFAULT_LIVE_LABELS_CACHE_TTL_MS
  );
  const liveLabelsErrorCooldownMs = clampNonNegativeInt(
    readEnvNonNegativeInt("RALPH_GITHUB_QUEUE_LIVE_LABELS_ERROR_COOLDOWN_MS", DEFAULT_LIVE_LABELS_ERROR_COOLDOWN_MS),
    DEFAULT_LIVE_LABELS_ERROR_COOLDOWN_MS
  );

  type LiveLabelsCacheEntry = {
    labels: string[];
    fetchedAtMs: number;
    errorUntilMs?: number;
    errorMessage?: string;
  };
  const liveLabelsByIssue = new Map<string, LiveLabelsCacheEntry>();

  return {
    ensureWorkflowLabels: async (repo) => await labelEnsurer.ensure(repo),
    listIssueLabels: async (repo, issueNumber) => {
      const nowMs = Date.now();
      const cacheKey = `${repo}#${issueNumber}`;
      const cached = liveLabelsByIssue.get(cacheKey);
      if (cached) {
        if (cached.errorUntilMs && cached.errorUntilMs > nowMs) {
          throw new Error(cached.errorMessage ?? "GitHub label fetch temporarily suppressed after failure");
        }
        if (liveLabelsCacheTtlMs > 0 && nowMs - cached.fetchedAtMs < liveLabelsCacheTtlMs) {
          return [...cached.labels];
        }
      }

      const { owner, name } = splitRepoFullName(repo);
      const client = await createGitHubClient(repo);

      try {
        const response = await client.request<Array<{ name?: string | null }>>(
          `/repos/${owner}/${name}/issues/${issueNumber}/labels?per_page=100`,
          { source: LIVE_LABELS_TELEMETRY_SOURCE }
        );
        const labels = (response.data ?? []).map((label) => label?.name ?? "").filter(Boolean);
        liveLabelsByIssue.set(cacheKey, { labels, fetchedAtMs: nowMs });
        return [...labels];
      } catch (error: any) {
        // Avoid spamming core REST when auth/rate-limit/backoff is already active.
        const message = error?.message ?? String(error);
        liveLabelsByIssue.set(cacheKey, {
          labels: cached?.labels ?? [],
          fetchedAtMs: cached?.fetchedAtMs ?? 0,
          errorUntilMs: nowMs + liveLabelsErrorCooldownMs,
          errorMessage: message,
        });
        throw error;
      }
    },
    fetchIssue: async (repo, issueNumber) => {
      const client = await createGitHubClient(repo);
      const raw = await client.getIssue(issueNumber);
      return parseIssueFetchResult(raw);
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


function normalizeTaskField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

function normalizeTaskExtraFields(extraFields?: Record<string, string | number>): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!extraFields) return normalized;
  for (const [key, value] of Object.entries(extraFields)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = String(value);
    } else if (typeof value === "string") {
      normalized[key] = value.trim();
    }
  }
  return normalized;
}

function parseIssueFetchResult(raw: unknown): IssueFetchResult | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as any;
  const labels = Array.isArray(data.labels) ? data.labels.map((label: any) => label?.name ?? "").filter(Boolean) : [];
  return {
    title: typeof data.title === "string" ? data.title : null,
    state: typeof data.state === "string" ? data.state : null,
    url: typeof data.html_url === "string" ? data.html_url : null,
    githubNodeId: typeof data.node_id === "string" ? data.node_id : null,
    githubUpdatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
    labels,
  };
}

function buildLabelOpsIo(io: GitHubQueueIO, repo: string, issueNumber: number) {
  return {
    addLabel: async (label: string) => await io.addIssueLabel(repo, issueNumber, label),
    addLabels: async (labels: string[]) => await io.addIssueLabels(repo, issueNumber, labels),
    removeLabel: async (label: string) => await io.removeIssueLabel(repo, issueNumber, label),
  };
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

function isOpenPrWaitingState(opState: TaskOpState | null | undefined): boolean {
  return (opState?.status ?? "").trim().toLowerCase() === "waiting-on-pr";
}

export function createGitHubQueueDriver(deps?: GitHubQueueDeps) {
  const io = deps?.io ?? createGitHubQueueIo();
  const relationshipsProviderFactory =
    deps?.relationshipsProviderFactory ?? ((repo: string) => new GitHubRelationshipProvider(repo));
  let lastSweepAt = 0;
  let lastClosedSweepAt = 0;
  let stopRequested = false;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchInFlight = false;

  const shouldSkipRepo = (repo: string): { skip: boolean; details?: string } => {
    const scheme = getRepoLabelSchemeState(repo);
    if (!scheme.errorCode) return { skip: false };
    return { skip: true, details: scheme.errorDetails ?? scheme.errorCode };
  };

  const warnSkipRepo = (repo: string, reason?: string) => {
    if (!shouldLog(`ralph:queue:github:unschedulable:${repo}`, 60_000)) return;
    const suffix = reason ? ` (${reason})` : "";
    console.warn(`[ralph:queue:github] Repo unschedulable; skipping ${repo}${suffix}`);
  };


  const maybeSweepClosedIssues = async (): Promise<void> => {
    const nowMs = getNowMs(deps);
    if (nowMs - lastClosedSweepAt < SWEEP_INTERVAL_MS) return;
    lastClosedSweepAt = nowMs;

    const nowIso = getNowIso(deps);

    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      const skip = shouldSkipRepo(repo);
      if (skip.skip) {
        warnSkipRepo(repo, skip.details);
        continue;
      }
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
            const didMutate = await io.mutateIssueLabels({
              repo,
              issueNumber: issue.number,
              issueNodeId: issue.githubNodeId,
              add: delta.add,
              remove: delta.remove,
            });

            if (!didMutate) {
              const steps: LabelOp[] = [
                ...delta.add.map((label) => ({ action: "add" as const, label })),
                ...delta.remove.map((label) => ({ action: "remove" as const, label })),
              ];

              const labelOps = await applyIssueLabelOps({
                ops: steps,
                io: buildLabelOpsIo(io, repo, issue.number),
                logLabel: `${repo}#${issue.number}`,
                log: (message) => console.warn(`[ralph:queue:github] ${message}`),
                repo,
                ensureLabels: async () => await io.ensureWorkflowLabels(repo),
                retryMissingLabelOnce: true,
              });

              if (labelOps.ok) {
                applyLabelDelta({ repo, issueNumber: issue.number, add: labelOps.add, remove: labelOps.remove, nowIso });
              } else if (labelOps.kind !== "transient") {
                throw labelOps.error;
              }
            } else {
              applyLabelDelta({ repo, issueNumber: issue.number, add: delta.add, remove: delta.remove, nowIso });
            }
          } catch (error: any) {
            console.warn(
              `[ralph:queue:github] Failed to reconcile labels for reopened issue ${repo}#${issue.number}: ${error?.message ?? String(error)}`
            );
          }

          continue;
        }

        // Otherwise: issue is closed and no active PR is tracked. Release locally and mark done.
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

          const delta = statusToRalphLabelDelta("done", issue.labels);
          const didMutate = await io.mutateIssueLabels({
            repo,
            issueNumber: issue.number,
            issueNodeId: issue.githubNodeId,
            add: delta.add,
            remove: delta.remove,
          });

          if (!didMutate) {
            const steps: LabelOp[] = [
              ...delta.add.map((label) => ({ action: "add" as const, label })),
              ...delta.remove.map((label) => ({ action: "remove" as const, label })),
            ];

            const labelOps = await applyIssueLabelOps({
              ops: steps,
              io: buildLabelOpsIo(io, repo, issue.number),
              logLabel: `${repo}#${issue.number}`,
              log: (message) => console.warn(`[ralph:queue:github] ${message}`),
              repo,
              ensureLabels: async () => await io.ensureWorkflowLabels(repo),
              retryMissingLabelOnce: true,
            });

            if (labelOps.ok) {
              applyLabelDelta({ repo, issueNumber: issue.number, add: labelOps.add, remove: labelOps.remove, nowIso });
            } else if (labelOps.kind !== "transient") {
              throw labelOps.error;
            }
          } else {
            applyLabelDelta({ repo, issueNumber: issue.number, add: delta.add, remove: delta.remove, nowIso });
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
    const missingSessionGraceMs = clampNonNegativeInt(
      readEnvNonNegativeInt("RALPH_GITHUB_QUEUE_MISSING_SESSION_GRACE_MS", DEFAULT_MISSING_SESSION_GRACE_MS),
      DEFAULT_MISSING_SESSION_GRACE_MS
    );
    const nowIso = getNowIso(deps);

    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      const skip = shouldSkipRepo(repo);
      if (skip.skip) {
        warnSkipRepo(repo, skip.details);
        continue;
      }
      const opStateByIssue = buildTaskOpStateMap(repo);
      const issues = listIssueSnapshotsWithRalphLabels(repo);

      for (const issue of issues) {
        if (stopRequested) return;
        if (!issue.labels.includes(RALPH_LABEL_STATUS_IN_PROGRESS)) continue;
        const opState = opStateByIssue.get(issue.number) ?? null;
        const recovery = computeStaleInProgressRecovery({
          labels: issue.labels,
          opState,
          nowMs,
          ttlMs,
          graceMs: missingSessionGraceMs,
        });
        if (!recovery.shouldRecover) continue;

        const hasOpenPr = listOpenPrCandidatesForIssue(repo, issue.number).length > 0;
        if (hasOpenPr && isOpenPrWaitingState(opState)) {
          if (shouldLog(`ralph:queue:github:stale-sweep:suppress:${repo}#${issue.number}`, 60_000)) {
            console.warn(
              `[ralph:queue:github] Suppressed stale in-progress recovery for ${repo}#${issue.number}; open PR wait state is intentional`
            );
          }
          continue;
        }

        try {
          releaseTaskSlot({
            repo,
            issueNumber: issue.number,
            taskPath: `github:${repo}#${issue.number}`,
            releasedReason: recovery.reason ?? "stale-in-progress",
            status: "queued",
          });

          const delta = statusToRalphLabelDelta("queued", issue.labels);
          const didMutate = await io.mutateIssueLabels({
            repo,
            issueNumber: issue.number,
            issueNodeId: issue.githubNodeId,
            add: delta.add,
            remove: delta.remove,
          });

          if (!didMutate) {
            const steps: LabelOp[] = [
              ...delta.add.map((label) => ({ action: "add" as const, label })),
              ...delta.remove.map((label) => ({ action: "remove" as const, label })),
            ];

            const labelOps = await applyIssueLabelOps({
              ops: steps,
              io: buildLabelOpsIo(io, repo, issue.number),
              logLabel: `${repo}#${issue.number}`,
              log: (message) => console.warn(`[ralph:queue:github] ${message}`),
              repo,
              ensureLabels: async () => await io.ensureWorkflowLabels(repo),
              retryMissingLabelOnce: true,
            });

            if (labelOps.ok) {
              applyLabelDelta({ repo, issueNumber: issue.number, add: labelOps.add, remove: labelOps.remove, nowIso });
            } else if (labelOps.kind !== "transient") {
              throw labelOps.error;
            }
          } else {
            applyLabelDelta({ repo, issueNumber: issue.number, add: delta.add, remove: delta.remove, nowIso });
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
    const tasks: AgentTask[] = [];
    for (const issue of issues) {
      const opState = opStateByIssue.get(issue.number);
      const hasStatusLabel = issue.labels.some((label) => label.toLowerCase().startsWith(RALPH_STATUS_LABEL_PREFIX));
      if (!hasStatusLabel && !opState) continue;
      tasks.push(deriveTaskView({ issue, opState, nowIso }));
    }
    return tasks;
  };

  const listTasksByStatus = async (status: QueueTaskStatus): Promise<AgentTask[]> => {
    if (shouldRunSweeps()) {
      await maybeSweepClosedIssues();
      await maybeSweepStaleInProgress();
    }

    const tasks: AgentTask[] = [];
    for (const repo of getConfig().repos.map((entry) => entry.name)) {
      const skip = shouldSkipRepo(repo);
      if (skip.skip) {
        warnSkipRepo(repo, skip.details);
        continue;
      }
      for (const task of buildTasksForRepo(repo)) {
        if (task.status === status) tasks.push(task);
      }
    }
    return tasks;
  };

  return {
    name: "github" as const,
    initialPoll: async (): Promise<QueueTask[]> => {
      // Bootstrap required workflow labels early so new repos become schedulable
      // before any claim/write attempts.
      const repos = getConfig().repos.map((entry) => entry.name);
      if (repos.length > 0) {
        await Promise.allSettled(repos.map(async (repo) => await io.ensureWorkflowLabels(repo)));
      }

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
        const autoQueueEnabled = getRepoAutoQueueConfig(issueRef.repo)?.enabled ?? false;
        const snapshotLabels = issue.labels;
        let plan = planClaim(snapshotLabels);
        const shouldCheckDependencies = autoQueueEnabled;
        const shouldCheckPause = snapshotLabels.includes(RALPH_LABEL_STATUS_PAUSED);

        // Avoid repeated core REST reads on every claim attempt. The IO layer applies a TTL cache.
        // We only request live labels when we may claim or when blocked-gating needs it.
        let labelsForPlan = snapshotLabels;
        try {
          if (plan.claimable || shouldCheckDependencies || shouldCheckPause) {
            labelsForPlan = await io.listIssueLabels(issueRef.repo, issueRef.number);
          }

          const shouldCheckDependenciesLive = autoQueueEnabled;
          if (shouldCheckDependenciesLive) {
            try {
              const relationships = relationshipsProviderFactory(issueRef.repo);
              const snapshot = await relationships.getSnapshot(issueRef);
              const resolved = resolveRelationshipSignals(snapshot);
              logRelationshipDiagnostics({ repo: issueRef.repo, issue: snapshot.issue, diagnostics: resolved.diagnostics, area: "queue" });
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

                return { claimed: false, task: opts.task, reason };
              }
            } catch (error: any) {
              return { claimed: false, task: opts.task, reason: error?.message ?? String(error) };
            }
          }
          plan = planClaim(labelsForPlan);
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
        const didMutate = await io.mutateIssueLabels({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          issueNodeId: issue.githubNodeId,
          add: claimDelta.add,
          remove: claimDelta.remove,
        });
        if (!didMutate) {
          const labelOps = await applyIssueLabelOps({
            ops: plan.steps,
            io: buildLabelOpsIo(io, issueRef.repo, issueRef.number),
            logLabel: `${issueRef.repo}#${issueRef.number}`,
            log: (message) => console.warn(`[ralph:queue:github] ${message}`),
            repo: issueRef.repo,
            ensureLabels: async () => await io.ensureWorkflowLabels(issueRef.repo),
            retryMissingLabelOnce: true,
          });
          if (!labelOps.ok && labelOps.kind !== "transient") {
            return { claimed: false, task: opts.task, reason: "Failed to update claim labels" };
          }

          if (labelOps.ok) {
            applyLabelDelta({
              repo: issueRef.repo,
              issueNumber: issueRef.number,
              add: labelOps.add,
              remove: labelOps.remove,
              nowIso,
            });
          }
        } else {
          applyLabelDelta({
            repo: issueRef.repo,
            issueNumber: issueRef.number,
            add: claimDelta.add,
            remove: claimDelta.remove,
            nowIso,
          });
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

      // Stop switch: if paused label is present, do not claim or heartbeat.
      // Prefer live labels (TTL-cached) to reduce pause/unpause latency.
      const snapshotPaused = issue.labels.includes(RALPH_LABEL_STATUS_PAUSED);
      try {
        const liveLabels = await io.listIssueLabels(issueRef.repo, issueRef.number);
        if (liveLabels.includes(RALPH_LABEL_STATUS_PAUSED)) {
          return { claimed: false, task: opts.task, reason: "Issue is paused" };
        }
      } catch {
        // best-effort: fall back to snapshot gating
        if (snapshotPaused) {
          return { claimed: false, task: opts.task, reason: "Issue is paused" };
        }
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

      const nowIso = getNowIso(deps);
      const normalizedExtra = normalizeTaskExtraFields(extraFields);
      let issue = resolveIssueSnapshot(issueRef.repo, issueRef.number);
      if (!issue) {
        try {
          const fetched = await io.fetchIssue(issueRef.repo, issueRef.number);
          if (fetched) {
            runInStateTransaction(() => {
              recordIssueSnapshot({
                repo: issueRef.repo,
                issue: `${issueRef.repo}#${issueRef.number}`,
                title: fetched.title ?? undefined,
                state: fetched.state ?? undefined,
                url: fetched.url ?? undefined,
                githubNodeId: fetched.githubNodeId ?? undefined,
                githubUpdatedAt: fetched.githubUpdatedAt ?? undefined,
                at: nowIso,
              });
              recordIssueLabelsSnapshot({
                repo: issueRef.repo,
                issue: `${issueRef.repo}#${issueRef.number}`,
                labels: fetched.labels,
                at: nowIso,
              });
            });
            issue = {
              repo: issueRef.repo,
              number: issueRef.number,
              title: fetched.title,
              state: fetched.state,
              url: fetched.url,
              githubNodeId: fetched.githubNodeId,
              githubUpdatedAt: fetched.githubUpdatedAt,
              labels: fetched.labels,
            };
          }
        } catch (error) {
          if (shouldLog(`ralph:queue:github:issue-fetch:${issueRef.repo}#${issueRef.number}`, 60_000)) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[ralph:queue:github] Failed to fetch issue ${issueRef.repo}#${issueRef.number}: ${message}`);
          }
        }
      }

      if (issue?.state?.toUpperCase() === "CLOSED" && status === "done") {
        recordTaskSnapshot({
          repo: issueRef.repo,
          issue: `${issueRef.repo}#${issueRef.number}`,
          taskPath: taskObj._path || `github:${issueRef.repo}#${issueRef.number}`,
          status,
          sessionId: normalizeTaskField(normalizedExtra["session-id"]),
          worktreePath: normalizeTaskField(normalizedExtra["worktree-path"]),
          workerId: normalizeTaskField(normalizedExtra["worker-id"]),
          repoSlot: normalizeTaskField(normalizedExtra["repo-slot"]),
          daemonId: normalizeTaskField(normalizedExtra["daemon-id"]),
          heartbeatAt: normalizeTaskField(normalizedExtra["heartbeat-at"]),
          at: nowIso,
        });
        return true;
      }

      const preservePausedLabel =
        Boolean(issue?.labels?.includes(RALPH_LABEL_STATUS_PAUSED)) && status !== "paused" && status !== "done";
      const preserveEscalatedLabel =
        Boolean(issue?.labels?.includes(RALPH_LABEL_STATUS_ESCALATED)) && status !== "escalated" && status !== "done";
      const preserveStoppedLabel =
        Boolean(issue?.labels?.includes(RALPH_LABEL_STATUS_STOPPED)) && status !== "stopped" && status !== "done";
      const shouldPreserveLabel = preservePausedLabel || preserveEscalatedLabel || preserveStoppedLabel;
      const delta = shouldPreserveLabel
        ? { add: [], remove: [] }
        : (issue ? statusToRalphLabelDelta(status, issue.labels) : { add: [], remove: [] });
      const steps: LabelOp[] = [
        ...delta.add.map((label) => ({ action: "add" as const, label })),
        ...delta.remove.map((label) => ({ action: "remove" as const, label })),
      ];
      const updateDelta = {
        add: steps.filter((step) => step.action === "add").map((step) => step.label),
        remove: steps.filter((step) => step.action === "remove").map((step) => step.label),
      };
      if (issue && (updateDelta.add.length > 0 || updateDelta.remove.length > 0)) {
        const didMutate = await io.mutateIssueLabels({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          issueNodeId: issue.githubNodeId,
          add: updateDelta.add,
          remove: updateDelta.remove,
        });
        if (!didMutate) {
          const labelOps = await applyIssueLabelOps({
            ops: steps,
            io: buildLabelOpsIo(io, issueRef.repo, issueRef.number),
            logLabel: `${issueRef.repo}#${issueRef.number}`,
            log: (message) => console.warn(`[ralph:queue:github] ${message}`),
            repo: issueRef.repo,
            ensureLabels: async () => await io.ensureWorkflowLabels(issueRef.repo),
            retryMissingLabelOnce: true,
          });
          if (labelOps.ok) {
            applyLabelDelta({ repo: issueRef.repo, issueNumber: issueRef.number, add: labelOps.add, remove: labelOps.remove, nowIso });
          } else if (labelOps.kind !== "transient") {
            if (shouldLog(`ralph:queue:github:label-ops:${issueRef.repo}#${issueRef.number}`, 60_000)) {
              console.warn(
                `[ralph:queue:github] Label update failed for ${issueRef.repo}#${issueRef.number}: ${labelOps.kind}`
              );
            }
          }
        } else {
          applyLabelDelta({ repo: issueRef.repo, issueNumber: issueRef.number, add: updateDelta.add, remove: updateDelta.remove, nowIso });
        }
      }

      recordTaskSnapshot({
        repo: issueRef.repo,
        issue: `${issueRef.repo}#${issueRef.number}`,
        taskPath: taskObj._path || `github:${issueRef.repo}#${issueRef.number}`,
        status,
        sessionId: normalizeTaskField(normalizedExtra["session-id"]),
        worktreePath: normalizeTaskField(normalizedExtra["worktree-path"]),
        workerId: normalizeTaskField(normalizedExtra["worker-id"]),
        repoSlot: normalizeTaskField(normalizedExtra["repo-slot"]),
        daemonId: normalizeTaskField(normalizedExtra["daemon-id"]),
        heartbeatAt: normalizeTaskField(normalizedExtra["heartbeat-at"]),
        releasedAtMs:
          status === "in-progress" ||
          status === "starting" ||
          status === "waiting-on-pr" ||
          status === "paused" ||
          status === "throttled"
            ? null
            : undefined,
        releasedReason:
          status === "in-progress" ||
          status === "starting" ||
          status === "waiting-on-pr" ||
          status === "paused" ||
          status === "throttled"
            ? null
            : undefined,
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
