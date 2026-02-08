import {
  getConfig,
  getConfigMeta,
  getProfile,
  getSandboxProfileConfig,
  isQueueBackendExplicit,
  type QueueBackend,
  type RalphConfig,
} from "./config";
import { shouldLog } from "./logging";
import type { QueueChangeHandler, QueueTask, QueueTaskStatus } from "./queue/types";
import type { TaskPriority } from "./queue/priority";
import { priorityRank } from "./queue/priority";
import { createGitHubQueueDriver } from "./github-queue";
import { isStateDbInitialized, listRepoLabelSchemeStates, listRepoLabelWriteStates } from "./state";
import { parseIssueRef } from "./github/issue-ref";

export type QueueBackendHealth = "ok" | "degraded" | "unavailable";

export type QueueBackendDriver = {
  name: Exclude<QueueBackend, "bwrb">;
  initialPoll(): Promise<QueueTask[]>;
  startWatching(onChange: QueueChangeHandler): void;
  stopWatching(): void;
  getQueuedTasks(): Promise<QueueTask[]>;
  getTasksByStatus(status: QueueTaskStatus): Promise<QueueTask[]>;
  getTaskByPath(taskPath: string): Promise<QueueTask | null>;
  tryClaimTask(opts: {
    task: QueueTask;
    daemonId: string;
    nowMs: number;
  }): Promise<{ claimed: boolean; task: QueueTask | null; reason?: string }>;
  heartbeatTask(opts: { task: QueueTask; daemonId: string; nowMs: number }): Promise<boolean>;
  updateTaskStatus(
    task: QueueTask | Pick<QueueTask, "_path" | "_name" | "name" | "issue" | "repo"> | string,
    status: QueueTaskStatus,
    extraFields?: Record<string, string | number>
  ): Promise<boolean>;
  createAgentTask(opts: {
    name: string;
    issue: string;
    repo: string;
    scope: string;
    status: QueueTaskStatus;
    priority?: TaskPriority;
  }): Promise<{ taskPath: string; taskFileName: string } | null>;
  resolveAgentTaskByIssue(issue: string, repo?: string): Promise<QueueTask | null>;
};

export type QueueBackendState = {
  desiredBackend: QueueBackend;
  backend: Exclude<QueueBackend, "bwrb">;
  health: QueueBackendHealth;
  fallback: boolean;
  diagnostics?: string;
  explicit: boolean;
};

let cachedState: QueueBackendState | null = null;
let cachedDriver: QueueBackendDriver | null = null;

function isGitHubAuthConfigured(config: RalphConfig): boolean {
  const profile = getProfile();
  if (profile === "sandbox") {
    const sandbox = getSandboxProfileConfig();
    if (sandbox?.githubAuth?.githubApp) return true;
    const tokenEnvVar = sandbox?.githubAuth?.tokenEnvVar;
    const token = tokenEnvVar ? process.env[tokenEnvVar] : undefined;
    return Boolean(token && token.trim());
  }

  if (config.githubApp) return true;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return Boolean(token && token.trim());
}

function mapLegacyBackend(
  desiredBackend: QueueBackend,
  config: RalphConfig
): { backend: Exclude<QueueBackend, "bwrb">; diagnostics?: string; fallback: boolean } {
  if (desiredBackend !== "bwrb") {
    return {
      backend: desiredBackend,
      fallback: false,
    };
  }

  if (isGitHubAuthConfigured(config)) {
    return {
      backend: "github",
      fallback: true,
      diagnostics: 'Legacy queueBackend "bwrb" is deprecated and mapped to "github".',
    };
  }

  return {
    backend: "none",
    fallback: true,
    diagnostics: 'Legacy queueBackend "bwrb" is deprecated and mapped to "none" because GitHub auth is not configured.',
  };
}

export function __resetQueueBackendStateForTests(): void {
  cachedState = null;
  cachedDriver = null;
}

export function getQueueBackendState(): QueueBackendState {
  if (cachedState) return cachedState;

  const config = getConfig();
  const meta = getConfigMeta();
  const desiredBackend = config.queueBackend ?? "github";
  const explicit = isQueueBackendExplicit();

  if (meta.queueBackendExplicit && !meta.queueBackendValid) {
    cachedState = {
      desiredBackend,
      backend: "none",
      health: "unavailable",
      fallback: false,
      diagnostics:
        `Invalid queueBackend=${JSON.stringify(meta.queueBackendRaw)}; ` +
        'valid values are "github", "none".',
      explicit,
    };
    return cachedState;
  }

  const legacy = mapLegacyBackend(desiredBackend, config);
  let backend = legacy.backend;
  let health: QueueBackendHealth = "ok";
  let diagnostics = legacy.diagnostics;

  if (backend === "github" && !isGitHubAuthConfigured(config)) {
    const authHint = "GitHub auth is not configured (set githubApp in ~/.ralph/config.* or GH_TOKEN/GITHUB_TOKEN).";
    if (explicit || desiredBackend === "bwrb") {
      health = "unavailable";
      diagnostics = diagnostics ? `${diagnostics} ${authHint}` : authHint;
    } else {
      backend = "none";
      health = "degraded";
      diagnostics = diagnostics ? `${diagnostics} ${authHint}` : authHint;
    }
  }

  cachedState = {
    desiredBackend,
    backend,
    health,
    fallback: legacy.fallback || backend !== desiredBackend,
    diagnostics,
    explicit,
  };

  return cachedState;
}

export function getQueueBackendStateWithLabelHealth(nowMs: number = Date.now()): QueueBackendState {
  const base = getQueueBackendState();
  if (base.backend !== "github" || base.health === "unavailable") return base;
  if (!isStateDbInitialized()) return base;

  let diagnostics = base.diagnostics;
  let degraded = false;

  const labelWriteStates = listRepoLabelWriteStates();
  const blocked = labelWriteStates
    .map((state) => ({ repo: state.repo, blockedUntilMs: state.blockedUntilMs, lastError: state.lastError }))
    .filter((entry) => typeof entry.blockedUntilMs === "number" && entry.blockedUntilMs > nowMs);
  if (blocked.length > 0) {
    degraded = true;
    const nextBlockedUntilMs = Math.min(...blocked.map((entry) => entry.blockedUntilMs as number));
    const untilIso = new Date(nextBlockedUntilMs).toISOString();
    const detail =
      blocked.length === 1
        ? `label writes blocked until ${untilIso}`
        : `label writes blocked for ${blocked.length} repos (next ${untilIso})`;
    diagnostics = diagnostics ? `${diagnostics} ${detail}` : detail;
  }

  const schemeStates = listRepoLabelSchemeStates();
  const schemeErrors = schemeStates.filter((state) => Boolean(state.errorCode));
  if (schemeErrors.length > 0) {
    degraded = true;
    const lines = ["Repo label scheme errors:", ...schemeErrors.map((s) => `- ${s.repo}: ${s.errorDetails ?? s.errorCode}`)];
    const detail = lines.join("\n");
    diagnostics = diagnostics ? `${diagnostics}\n${detail}` : detail;
  }

  if (!degraded) return base;
  return { ...base, health: "degraded", diagnostics };
}

function logQueueBackendNote(action: string, state: QueueBackendState): void {
  const key = `queue-backend:${action}:${state.backend}:${state.health}`;
  if (!shouldLog(key, 60_000)) return;

  const base = `[ralph:queue] ${action} skipped; queue backend is ${state.backend}`;
  if (state.diagnostics) {
    console.warn(`${base}. ${state.diagnostics}`);
  } else {
    console.warn(`${base}.`);
  }
}

function createDisabledDriver(state: QueueBackendState): QueueBackendDriver {
  const warn = (action: string): void => logQueueBackendNote(action, state);

  return {
    name: state.backend,
    initialPoll: async () => {
      warn("initial poll");
      return [];
    },
    startWatching: () => {
      warn("queue watch");
    },
    stopWatching: () => {
      // no-op
    },
    getQueuedTasks: async () => {
      warn("list queued tasks");
      return [];
    },
    getTasksByStatus: async (status) => {
      warn(`list tasks (${status})`);
      return [];
    },
    getTaskByPath: async () => {
      warn("get task by path");
      return null;
    },
    tryClaimTask: async () => {
      warn("claim task");
      return { claimed: false, task: null, reason: "queue backend disabled" };
    },
    heartbeatTask: async () => {
      warn("heartbeat task");
      return false;
    },
    updateTaskStatus: async () => {
      warn("update task status");
      return false;
    },
    createAgentTask: async () => {
      warn("create agent task");
      return null;
    },
    resolveAgentTaskByIssue: async () => {
      warn("resolve agent task");
      return null;
    },
  };
}

function getQueueBackendDriver(): QueueBackendDriver {
  if (cachedDriver) return cachedDriver;

  const state = getQueueBackendState();
  if (state.backend === "github" && state.health === "ok") {
    cachedDriver = createGitHubQueueDriver();
  } else {
    cachedDriver = createDisabledDriver(state);
  }

  return cachedDriver;
}

export type { AgentTask, QueueChangeHandler, QueueTask, QueueTaskStatus } from "./queue/types";

export function groupByRepo<T extends Pick<QueueTask, "repo">>(tasks: T[]): Map<string, T[]> {
  const byRepo = new Map<string, T[]>();
  for (const task of tasks) {
    const existing = byRepo.get(task.repo) ?? [];
    existing.push(task);
    byRepo.set(task.repo, existing);
  }

  for (const [repo, repoTasks] of byRepo) {
    repoTasks.sort((a, b) => {
      const aTask = a as unknown as Partial<QueueTask>;
      const bTask = b as unknown as Partial<QueueTask>;
      const aPriority = aTask.priority as TaskPriority | undefined;
      const bPriority = bTask.priority as TaskPriority | undefined;
      const rankDelta = priorityRank(aPriority) - priorityRank(bPriority);
      if (rankDelta !== 0) return rankDelta;

      const aIssue = parseIssueRef(aTask.issue ?? "", aTask.repo ?? "")?.number ?? Number.POSITIVE_INFINITY;
      const bIssue = parseIssueRef(bTask.issue ?? "", bTask.repo ?? "")?.number ?? Number.POSITIVE_INFINITY;
      if (aIssue !== bIssue) return aIssue - bIssue;

      const aPath = aTask._path ?? "";
      const bPath = bTask._path ?? "";
      return aPath.localeCompare(bPath);
    });
    byRepo.set(repo, repoTasks);
  }

  return byRepo;
}

export async function initialPoll(): Promise<QueueTask[]> {
  return getQueueBackendDriver().initialPoll();
}

export function startWatching(onChange: QueueChangeHandler): void {
  getQueueBackendDriver().startWatching(onChange);
}

export function stopWatching(): void {
  getQueueBackendDriver().stopWatching();
}

export async function getQueuedTasks(): Promise<QueueTask[]> {
  return getQueueBackendDriver().getQueuedTasks();
}

export async function getTasksByStatus(status: QueueTaskStatus): Promise<QueueTask[]> {
  return getQueueBackendDriver().getTasksByStatus(status);
}

export async function getTaskByPath(taskPath: string): Promise<QueueTask | null> {
  return getQueueBackendDriver().getTaskByPath(taskPath);
}

export async function tryClaimTask(opts: {
  task: QueueTask;
  daemonId: string;
  nowMs: number;
}): Promise<{ claimed: boolean; task: QueueTask | null; reason?: string }> {
  return getQueueBackendDriver().tryClaimTask(opts);
}

export async function heartbeatTask(opts: {
  task: QueueTask;
  daemonId: string;
  nowMs: number;
}): Promise<boolean> {
  return getQueueBackendDriver().heartbeatTask(opts);
}

export async function updateTaskStatus(
  task: QueueTask | Pick<QueueTask, "_path" | "_name" | "name" | "issue" | "repo"> | string,
  status: QueueTaskStatus,
  extraFields?: Record<string, string | number>
): Promise<boolean> {
  return getQueueBackendDriver().updateTaskStatus(task, status, extraFields);
}
