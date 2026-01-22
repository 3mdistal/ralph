import { getConfig } from "../config";
import { resolveGitHubToken } from "../github-auth";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "../github/client";
import { parseIssueRef, type IssueRef } from "../github/issue-blocking-core";
import { canActOnTask, isHeartbeatStale } from "../ownership";
import { shouldLog } from "../logging";
import {
  getIssueLabels,
  getIssueSnapshotByNumber,
  getTaskOpStateByPath,
  listIssueSnapshotsWithRalphLabels,
  listTaskOpStatesByRepo,
  recordIssueLabelsSnapshot,
  recordTaskSnapshot,
  type IssueSnapshot,
  type TaskOpState,
} from "../state";
import type { AgentTask, QueueChangeHandler, QueueTask, QueueTaskStatus } from "../queue/types";
import { deriveTaskView, planClaim, statusToRalphLabelDelta, shouldRecoverStaleInProgress, type LabelOp } from "./core";

const SWEEP_INTERVAL_MS = 5 * 60_000;
const WATCH_MIN_INTERVAL_MS = 1000;

type GitHubQueueDeps = {
  now?: () => Date;
};

function getNowIso(deps?: GitHubQueueDeps): string {
  return (deps?.now ? deps.now() : new Date()).toISOString();
}

function getNowMs(deps?: GitHubQueueDeps): number {
  return deps?.now ? deps.now().valueOf() : Date.now();
}

async function createGitHubClient(repo: string): Promise<GitHubClient> {
  const token = await resolveGitHubToken();
  return new GitHubClient(repo, token ? { token } : undefined);
}

async function addIssueLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  const { owner, name } = splitRepoFullName(repo);
  const client = await createGitHubClient(repo);
  await client.request(`/repos/${owner}/${name}/issues/${issueNumber}/labels`, {
    method: "POST",
    body: { labels: [label] },
  });
}

async function removeIssueLabel(repo: string, issueNumber: number, label: string): Promise<{ removed: boolean }> {
  const { owner, name } = splitRepoFullName(repo);
  const client = await createGitHubClient(repo);
  try {
    const response = await client.request(
      `/repos/${owner}/${name}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      {
      method: "DELETE",
      allowNotFound: true,
      }
    );
    return { removed: response.status !== 404 };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return { removed: false };
    }
    throw error;
  }
}

async function listIssueLabelsFromGitHub(repo: string, issueNumber: number): Promise<string[]> {
  const { owner, name } = splitRepoFullName(repo);
  const client = await createGitHubClient(repo);
  const response = await client.request<Array<{ name?: string | null }>>(
    `/repos/${owner}/${name}/issues/${issueNumber}/labels?per_page=100`
  );
  return (response.data ?? []).map((label) => label?.name ?? "").filter(Boolean);
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

async function applyLabelOps(params: {
  repo: string;
  issueNumber: number;
  steps: LabelOp[];
  rollback: LabelOp[];
  logLabel: string;
}): Promise<{ add: string[]; remove: string[]; ok: boolean }> {
  const added: string[] = [];
  const removed: string[] = [];

  for (const step of params.steps) {
    try {
      if (step.action === "add") {
        await addIssueLabel(params.repo, params.issueNumber, step.label);
        added.push(step.label);
      } else {
        const result = await removeIssueLabel(params.repo, params.issueNumber, step.label);
        if (result.removed) removed.push(step.label);
      }
    } catch (error: any) {
      console.warn(
        `[ralph:queue:github] Failed to ${step.action} ${step.label} for ${params.logLabel}: ${error?.message ?? String(error)}`
      );
      for (const rollback of params.rollback) {
        try {
          if (rollback.action === "add") {
            await addIssueLabel(params.repo, params.issueNumber, rollback.label);
          } else {
            await removeIssueLabel(params.repo, params.issueNumber, rollback.label);
          }
        } catch {
          // best-effort rollback
        }
      }
      return { add: added, remove: removed, ok: false };
    }
  }

  return { add: added, remove: removed, ok: true };
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
  let lastSweepAt = 0;
  let stopRequested = false;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchInFlight = false;

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
        if (!issue.labels.includes("ralph:in-progress")) continue;
        const opState = opStateByIssue.get(issue.number) ?? null;
        const shouldRecover = shouldRecoverStaleInProgress({
          labels: issue.labels,
          opState,
          nowMs,
          ttlMs,
        });
        if (!shouldRecover) continue;

        try {
          const delta = statusToRalphLabelDelta("queued", issue.labels);
          for (const label of delta.add) {
            await addIssueLabel(repo, issue.number, label);
          }
          for (const label of delta.remove) {
            await removeIssueLabel(repo, issue.number, label);
          }

          applyLabelDelta({ repo, issueNumber: issue.number, add: delta.add, remove: delta.remove, nowIso });
          recordTaskSnapshot({
            repo,
            issue: `${repo}#${issue.number}`,
            taskPath: `github:${repo}#${issue.number}`,
            status: "queued",
            at: nowIso,
          });
          console.warn(
            `[ralph:queue:github] Recovered stale in-progress issue ${repo}#${issue.number}; reset to queued`
          );
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
    await maybeSweepStaleInProgress();

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
          onChange(tasks);
        } finally {
          watchInFlight = false;
          watchTimer = setTimeout(tick, intervalMs);
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
          const liveLabels = await listIssueLabelsFromGitHub(issueRef.repo, issueRef.number);
          plan = planClaim(liveLabels);
          if (!plan.claimable) {
            return { claimed: false, task: opts.task, reason: plan.reason ?? "Task not claimable" };
          }
        } catch (error: any) {
          return { claimed: false, task: opts.task, reason: error?.message ?? String(error) };
        }

        const nowIso = new Date(opts.nowMs).toISOString();
        const taskPath = opState.taskPath || `github:${issueRef.repo}#${issueRef.number}`;

        const labelOps = await applyLabelOps({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          steps: plan.steps,
          rollback: plan.rollback,
          logLabel: `${issueRef.repo}#${issueRef.number}`,
        });
        if (!labelOps.ok) {
          return { claimed: false, task: opts.task, reason: "Failed to update claim labels" };
        }

        applyLabelDelta({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          add: labelOps.add,
          remove: labelOps.remove,
          nowIso,
        });

        recordTaskSnapshot({
          repo: issueRef.repo,
          issue: `${issueRef.repo}#${issueRef.number}`,
          taskPath,
          status: "in-progress",
          daemonId: opts.daemonId,
          heartbeatAt: nowIso,
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
      if (!canActOnTask({ "daemon-id": opState.daemonId, "heartbeat-at": opState.heartbeatAt }, opts.daemonId, opts.nowMs, ttlMs)) {
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
      const steps: LabelOp[] = [
        ...delta.add.map((label) => ({ action: "add" as const, label })),
        ...delta.remove.map((label) => ({ action: "remove" as const, label })),
      ];
      const rollback: LabelOp[] = [
        ...delta.remove.map((label) => ({ action: "add" as const, label })),
        ...delta.add.map((label) => ({ action: "remove" as const, label })),
      ];
      const labelOps = await applyLabelOps({
        repo: issueRef.repo,
        issueNumber: issueRef.number,
        steps,
        rollback,
        logLabel: `${issueRef.repo}#${issueRef.number}`,
      });
      if (!labelOps.ok) return false;

      applyLabelDelta({ repo: issueRef.repo, issueNumber: issueRef.number, add: labelOps.add, remove: labelOps.remove, nowIso });

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
