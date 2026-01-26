import {
  checkBwrbVaultLayout,
  getConfig,
  getConfigMeta,
  getProfile,
  getSandboxProfileConfig,
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

export type QueueBackendNotice = {
  code: "bwrb-legacy";
  severity: "warning";
  message: string;
  docsPath: string;
  suggestedAction: string;
};

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
  notices: QueueBackendNotice[];
};

let cachedState: QueueBackendState | null = null;
let cachedDriver: QueueBackendDriver | null = null;

const GITHUB_QUEUE_IMPLEMENTED = true;

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

export function __resetQueueBackendStateForTests(): void {
  cachedState = null;
  cachedDriver = null;
}

type QueueBackendResolutionInput = {
  desiredBackend: QueueBackend;
  explicit: boolean;
  githubQueueImplemented: boolean;
  githubAuthConfigured: boolean;
  bwrbVault: string;
  bwrbVaultCheck: { ok: boolean; error?: string };
  meta: {
    queueBackendExplicit: boolean;
    queueBackendValid: boolean;
    queueBackendRaw?: unknown;
  };
};

const buildBwrbLegacyNotice = (): QueueBackendNotice => ({
  code: "bwrb-legacy",
  severity: "warning",
  message:
    "bwrb queue backend is legacy; GitHub issues and ~/.ralph/state.sqlite are the canonical queue surfaces.",
  docsPath: "docs/product/github-first-orchestration.md",
  suggestedAction: "Prefer queueBackend=github and configure GitHub auth; bwrb output is best-effort only.",
});

export function resolveQueueBackendState(input: QueueBackendResolutionInput): QueueBackendState {
  let backend: QueueBackend = input.desiredBackend;
  let health: QueueBackendHealth = "ok";
  let diagnostics: string | undefined;

  if (input.meta.queueBackendExplicit && !input.meta.queueBackendValid) {
    return {
      desiredBackend: input.desiredBackend,
      backend,
      health: "unavailable",
      fallback: false,
      diagnostics:
        `Invalid queueBackend=${JSON.stringify(input.meta.queueBackendRaw)}; ` +
        `valid values are "github", "bwrb", "none".`,
      explicit: input.explicit,
      bwrbVault: input.bwrbVault,
      notices: [],
    };
  }

  if (input.desiredBackend === "bwrb") {
    if (!input.bwrbVaultCheck.ok) {
      health = "unavailable";
      diagnostics = input.bwrbVaultCheck.error ?? `bwrbVault is missing or invalid: ${JSON.stringify(input.bwrbVault)}`;
    }
  } else if (input.desiredBackend === "github") {
    if (!input.githubQueueImplemented) {
      if (!input.explicit && input.bwrbVaultCheck.ok) {
        backend = "bwrb";
        health = "ok";
        diagnostics = "GitHub queue backend is not yet implemented (see #61/#63); falling back to bwrb.";
      } else {
        diagnostics = "GitHub queue backend is not yet implemented (see #61/#63).";
        if (input.explicit) {
          health = "unavailable";
        } else {
          backend = "none";
          health = "degraded";
        }
      }
    } else if (!input.githubAuthConfigured) {
      if (!input.explicit && input.bwrbVaultCheck.ok) {
        backend = "bwrb";
        health = "ok";
        diagnostics =
          "GitHub auth is not configured (set githubApp in ~/.ralph/config.* or GH_TOKEN/GITHUB_TOKEN); falling back to bwrb.";
      } else {
        diagnostics =
          "GitHub auth is not configured (set githubApp in ~/.ralph/config.* or GH_TOKEN/GITHUB_TOKEN).";
        if (input.explicit) {
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

  const notices = backend === "bwrb" ? [buildBwrbLegacyNotice()] : [];

  return {
    desiredBackend: input.desiredBackend,
    backend,
    health,
    fallback: backend !== input.desiredBackend,
    diagnostics,
    explicit: input.explicit,
    bwrbVault: input.bwrbVault,
    notices,
  };
}

export function getQueueBackendState(): QueueBackendState {
  if (cachedState) return cachedState;

  const config = getConfig();
  const meta = getConfigMeta();
  const desiredBackend = config.queueBackend ?? "github";
  const explicit = isQueueBackendExplicit();
  const bwrbVaultCheck = checkBwrbVaultLayout(config.bwrbVault);

  cachedState = resolveQueueBackendState({
    desiredBackend,
    explicit,
    githubQueueImplemented: GITHUB_QUEUE_IMPLEMENTED,
    githubAuthConfigured: isGitHubAuthConfigured(config),
    bwrbVault: config.bwrbVault,
    bwrbVaultCheck,
    meta,
  });

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
