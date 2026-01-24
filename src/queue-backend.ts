import {
  checkBwrbVaultLayout,
  getConfig,
  getConfigMeta,
  isQueueBackendExplicit,
  type QueueBackend,
  type RalphConfig,
} from "./config";
import { shouldLog } from "./logging";
import * as bwrbQueue from "./queue";
import type { QueueChangeHandler, QueueTask, QueueTaskStatus } from "./queue/types";
import type { TaskPriority } from "./queue/priority";
import { createGitHubQueueDriver } from "./github-queue";

export type QueueBackendHealth = "ok" | "degraded" | "unavailable";

export type QueueBackendDriver = {
  name: QueueBackend;
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
  backend: QueueBackend;
  health: QueueBackendHealth;
  fallback: boolean;
  diagnostics?: string;
  explicit: boolean;
  bwrbVault?: string;
};

let cachedState: QueueBackendState | null = null;
let cachedDriver: QueueBackendDriver | null = null;

const GITHUB_QUEUE_IMPLEMENTED = true;

function isGitHubAuthConfigured(config: RalphConfig): boolean {
  if (config.githubApp) return true;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return Boolean(token && token.trim());
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
  let backend: QueueBackend = desiredBackend;
  let health: QueueBackendHealth = "ok";
  let diagnostics: string | undefined;

  if (meta.queueBackendExplicit && !meta.queueBackendValid) {
    cachedState = {
      desiredBackend,
      backend,
      health: "unavailable",
      fallback: false,
      diagnostics:
        `Invalid queueBackend=${JSON.stringify(meta.queueBackendRaw)}; ` +
        `valid values are "github", "bwrb", "none".`,
      explicit,
      bwrbVault: config.bwrbVault,
    };

    return cachedState;
  }

  if (desiredBackend === "bwrb") {
    const check = checkBwrbVaultLayout(config.bwrbVault);
    if (!check.ok) {
      health = "unavailable";
      diagnostics = check.error ?? `bwrbVault is missing or invalid: ${JSON.stringify(config.bwrbVault)}`;
    }
  } else if (desiredBackend === "github") {
    if (!GITHUB_QUEUE_IMPLEMENTED) {
      const fallbackCheck = checkBwrbVaultLayout(config.bwrbVault);
      if (!explicit && fallbackCheck.ok) {
        backend = "bwrb";
        health = "ok";
        diagnostics = "GitHub queue backend is not yet implemented (see #61/#63); falling back to bwrb.";
      } else {
        diagnostics = "GitHub queue backend is not yet implemented (see #61/#63).";
        if (explicit) {
          health = "unavailable";
        } else {
          backend = "none";
          health = "degraded";
        }
      }
    } else if (!isGitHubAuthConfigured(config)) {
      const fallbackCheck = checkBwrbVaultLayout(config.bwrbVault);
      if (!explicit && fallbackCheck.ok) {
        backend = "bwrb";
        health = "ok";
        diagnostics =
          "GitHub auth is not configured (set githubApp in ~/.ralph/config.* or GH_TOKEN/GITHUB_TOKEN); falling back to bwrb.";
      } else {
        diagnostics =
          "GitHub auth is not configured (set githubApp in ~/.ralph/config.* or GH_TOKEN/GITHUB_TOKEN).";
        if (explicit) {
          health = "unavailable";
        } else {
          backend = "none";
          health = "degraded";
        }
      }
    }
  } else {
    backend = "none";
  }

  cachedState = {
    desiredBackend,
    backend,
    health,
    fallback: backend !== desiredBackend,
    diagnostics,
    explicit,
    bwrbVault: config.bwrbVault,
  };

  return cachedState;
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

function logBwrbStorageNote(action: string, error?: string): void {
  const key = `bwrb-storage:${action}`;
  if (!shouldLog(key, 60_000)) return;

  if (error) {
    console.warn(`[ralph:bwrb] ${action} skipped. ${error}`);
  } else {
    console.warn(`[ralph:bwrb] ${action} skipped; bwrb vault is unavailable.`);
  }
}

export function getBwrbVaultIfValid(): string | null {
  const vault = getConfig().bwrbVault;
  const check = checkBwrbVaultLayout(vault);
  return check.ok ? vault : null;
}

export function getBwrbVaultForStorage(action: string): string | null {
  const vault = getConfig().bwrbVault;
  const check = checkBwrbVaultLayout(vault);
  if (check.ok) return vault;
  logBwrbStorageNote(action, check.error);
  return null;
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
  if (state.backend === "bwrb" && state.health === "ok") {
    cachedDriver = {
      name: "bwrb",
      initialPoll: bwrbQueue.initialPoll,
      startWatching: bwrbQueue.startWatching,
      stopWatching: bwrbQueue.stopWatching,
      getQueuedTasks: bwrbQueue.getQueuedTasks,
      getTasksByStatus: bwrbQueue.getTasksByStatus,
      getTaskByPath: bwrbQueue.getTaskByPath,
      tryClaimTask: bwrbQueue.tryClaimTask,
      heartbeatTask: bwrbQueue.heartbeatTask,
      updateTaskStatus: bwrbQueue.updateTaskStatus,
      createAgentTask: bwrbQueue.createAgentTask,
      resolveAgentTaskByIssue: bwrbQueue.resolveAgentTaskByIssue,
    };
  } else if (state.backend === "github" && state.health === "ok") {
    cachedDriver = createGitHubQueueDriver();
  } else {
    cachedDriver = createDisabledDriver(state);
  }

  return cachedDriver;
}

export type { AgentTask, QueueChangeHandler, QueueTask, QueueTaskStatus } from "./queue/types";
export { groupByRepo, normalizeBwrbNoteRef } from "./queue";

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

export async function createAgentTask(opts: {
  name: string;
  issue: string;
  repo: string;
  scope: string;
  status: QueueTaskStatus;
  priority?: TaskPriority;
}): Promise<{ taskPath: string; taskFileName: string } | null> {
  return getQueueBackendDriver().createAgentTask(opts);
}

export async function resolveAgentTaskByIssue(issue: string, repo?: string): Promise<QueueTask | null> {
  return getQueueBackendDriver().resolveAgentTaskByIssue(issue, repo);
}
