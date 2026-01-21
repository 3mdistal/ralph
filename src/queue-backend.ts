import { checkBwrbVaultLayout, isQueueBackendExplicit, loadConfig, type QueueBackend, type RalphConfig } from "./config";
import { shouldLog } from "./logging";
import * as bwrbQueue from "./queue";
import type { QueueChangeHandler, QueueTask, QueueTaskStatus } from "./queue/types";

export type QueueBackendHealth = "ok" | "degraded" | "unavailable";

export type QueueBackendState = {
  desiredBackend: QueueBackend;
  backend: QueueBackend;
  health: QueueBackendHealth;
  diagnostics?: string;
  explicit: boolean;
  bwrbVault?: string;
};

let cachedState: QueueBackendState | null = null;

const GITHUB_QUEUE_IMPLEMENTED = false;

function isGitHubAuthConfigured(config: RalphConfig): boolean {
  if (config.githubApp) return true;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return Boolean(token && token.trim());
}

export function __resetQueueBackendStateForTests(): void {
  cachedState = null;
}

export function getQueueBackendState(): QueueBackendState {
  if (cachedState) return cachedState;

  const config = loadConfig();
  const desiredBackend = config.queueBackend ?? "github";
  const explicit = isQueueBackendExplicit();
  let backend: QueueBackend = desiredBackend;
  let health: QueueBackendHealth = "ok";
  let diagnostics: string | undefined;

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
        health = "degraded";
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
      diagnostics =
        "GitHub auth is not configured (set githubApp in ~/.ralph/config.* or GH_TOKEN/GITHUB_TOKEN).";
      if (explicit) {
        health = "unavailable";
      } else {
        backend = "none";
        health = "degraded";
      }
    }
  } else {
    backend = "none";
  }

  cachedState = {
    desiredBackend,
    backend,
    health,
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

export function isBwrbQueueEnabled(): boolean {
  const state = getQueueBackendState();
  return state.backend === "bwrb" && state.health === "ok";
}

export function ensureBwrbQueueOrWarn(action: string): boolean {
  const state = getQueueBackendState();
  if (state.backend === "bwrb" && state.health === "ok") return true;
  logQueueBackendNote(action, state);
  return false;
}

export type { AgentTask, QueueChangeHandler, QueueTask, QueueTaskStatus } from "./queue/types";
export { groupByRepo, normalizeBwrbNoteRef } from "./queue";

export async function initialPoll(): Promise<QueueTask[]> {
  if (!ensureBwrbQueueOrWarn("initial poll")) return [];
  return bwrbQueue.initialPoll();
}

export function startWatching(onChange: QueueChangeHandler): void {
  if (!ensureBwrbQueueOrWarn("queue watch")) return;
  bwrbQueue.startWatching(onChange);
}

export function stopWatching(): void {
  const state = getQueueBackendState();
  if (state.backend === "bwrb") {
    bwrbQueue.stopWatching();
  }
}

export async function getQueuedTasks(): Promise<QueueTask[]> {
  if (!ensureBwrbQueueOrWarn("list queued tasks")) return [];
  return bwrbQueue.getQueuedTasks();
}

export async function getTasksByStatus(status: QueueTaskStatus): Promise<QueueTask[]> {
  if (!ensureBwrbQueueOrWarn(`list tasks (${status})`)) return [];
  return bwrbQueue.getTasksByStatus(status);
}

export async function getTaskByPath(taskPath: string): Promise<QueueTask | null> {
  if (!ensureBwrbQueueOrWarn("get task by path")) return null;
  return bwrbQueue.getTaskByPath(taskPath);
}

export async function tryClaimTask(opts: {
  task: QueueTask;
  daemonId: string;
  nowMs: number;
}): Promise<{ claimed: boolean; task: QueueTask | null; reason?: string }> {
  if (!ensureBwrbQueueOrWarn("claim task")) {
    return { claimed: false, task: null, reason: "queue backend disabled" };
  }
  return bwrbQueue.tryClaimTask(opts);
}

export async function heartbeatTask(opts: {
  task: QueueTask;
  daemonId: string;
  nowMs: number;
}): Promise<boolean> {
  if (!ensureBwrbQueueOrWarn("heartbeat task")) return false;
  return bwrbQueue.heartbeatTask(opts);
}

export async function updateTaskStatus(
  task: QueueTask | Pick<QueueTask, "_path" | "_name" | "name" | "issue" | "repo"> | string,
  status: QueueTaskStatus,
  extraFields?: Record<string, string | number>
): Promise<boolean> {
  if (!ensureBwrbQueueOrWarn("update task status")) return false;
  return bwrbQueue.updateTaskStatus(task, status, extraFields);
}

export async function createAgentTask(opts: {
  name: string;
  issue: string;
  repo: string;
  scope: string;
  status: QueueTaskStatus;
  priority?: string;
}): Promise<{ taskPath: string; taskFileName: string } | null> {
  if (!ensureBwrbQueueOrWarn("create agent task")) return null;
  return bwrbQueue.createAgentTask(opts);
}

export async function resolveAgentTaskByIssue(issue: string, repo?: string): Promise<QueueTask | null> {
  if (!ensureBwrbQueueOrWarn("resolve agent task")) return null;
  return bwrbQueue.resolveAgentTaskByIssue(issue, repo);
}
