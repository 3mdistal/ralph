#!/usr/bin/env bun
/**
 * Ralph Loop - Autonomous Coding Task Orchestrator
 * 
 * Watches the queue backend (GitHub-first) for agent-tasks and dispatches them to OpenCode agents.
 * Processes tasks in parallel across repos, sequentially within each repo.
 * Creates rollup PRs after N successful merges for batch review.
 */

import { existsSync } from "fs";
import { join } from "path";
import crypto from "crypto";

import {
  getConfig,
  getDashboardEventsRetentionDays,
  getDashboardControlPlaneConfig,
  getOpencodeDefaultProfileName,
  getRequestedOpencodeProfileName,
  listOpencodeProfileNames,
  getRepoConcurrencySlots,
  getRepoSchedulerPriority,
  DEFAULT_REPO_SCHEDULER_PRIORITY,
  getRepoPath,
  getSandboxProfileConfig,
  getSandboxProvisioningConfig,
  type ControlConfig,
} from "./config";
import { filterReposToAllowedOwners, listAccessibleRepos } from "./github-app-auth";
import {
  getQueueBackendState,
  getQueueBackendStateWithLabelHealth,
  initialPoll,
  startWatching,
  stopWatching,
  groupByRepo,
  getQueuedTasks,
  getTasksByStatus,
  getTaskByPath,
  updateTaskStatus,
  tryClaimTask,
  heartbeatTask,
  type AgentTask,
} from "./queue-backend";
import { RepoWorker, type AgentRun } from "./worker";
import { RollupMonitor } from "./rollup";
import { Semaphore } from "./semaphore";
import { createSchedulerController, startQueuedTasks } from "./scheduler";
import { createPrioritySelectorState } from "./scheduler/priority-policy";
import {
  issuePriorityWeight,
  normalizePriorityInputToRalphPriorityLabel,
  normalizeTaskPriority,
  planRalphPriorityLabelSet,
} from "./queue/priority";

import { DrainMonitor, readControlStateSnapshot, resolveControlFilePath, type DaemonMode } from "./drain";
import { isRalphCheckpoint, type RalphCheckpoint } from "./dashboard/events";
import { formatDuration, shouldLog } from "./logging";
import { getThrottleDecision, type ThrottleDecision } from "./throttle";
import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "./opencode-auto-profile";
import { getRalphSandboxManifestPath, getRalphSandboxManifestsDir, getRalphSessionLockPath } from "./paths";
import { removeDaemonRecord, writeDaemonRecord } from "./daemon-record";
import { getRalphVersion } from "./version";
import { computeHeartbeatIntervalMs, parseHeartbeatMs } from "./ownership";
import { getRepoLabelSchemeState, initStateDb, recordPrSnapshot, PR_STATE_MERGED } from "./state";
import { releaseTaskSlot } from "./state";
import { updateControlFile } from "./control-file";
import { buildNudgePreview, queueNudge } from "./nudge";
import { terminateOpencodeRuns } from "./opencode-process-registry";
import { ralphEventBus } from "./dashboard/bus";
import { publishDashboardEvent } from "./dashboard/publisher";
import { cleanupDashboardEventLogs, installDashboardEventPersistence, type DashboardEventPersistence } from "./dashboard/event-persistence";
import { resolveMessageSessionId } from "./dashboard/message-targeting";
import { startGitHubIssuePollers } from "./github-issues-sync";
import { createAutoQueueRunner } from "./github/auto-queue";
import { startGitHubDoneReconciler } from "./github/done-reconciler";
import { startGitHubLabelReconciler } from "./github/label-reconciler";
import { startGitHubCmdProcessor } from "./github/cmd-processor";
import { resolveGitHubToken } from "./github-auth";
import { GitHubClient } from "./github/client";
import { parseIssueRef } from "./github/issue-ref";
import { executeIssueLabelOps, planIssueLabelOps } from "./github/issue-label-io";
import { ensureRalphWorkflowLabelsOnce } from "./github/ensure-ralph-workflow-labels";
import {
  ACTIVITY_EMIT_INTERVAL_MS,
  ACTIVITY_WINDOW_MS,
  classifyActivity,
} from "./activity-classifier";
import type { ActivityLabel } from "./activity-classifier";
import { editEscalation, getEscalationsByStatus, readResolutionMessage } from "./escalation-notes";
import {
  buildWaitingResolutionUpdate,
  DEFAULT_RESOLUTION_RECHECK_INTERVAL_MS,
  shouldDeferWaitingResolutionCheck,
} from "./escalation-resume";
import { attemptResumeResolvedEscalations as attemptResumeResolvedEscalationsImpl } from "./escalation-resume-scheduler";
import { computeDaemonGate } from "./daemon-gate";
import { runGatesCommand } from "./commands/gates";
import { runRunsCommand } from "./commands/runs";
import { collectStatusSnapshot, runStatusCommand, type StatusDrainState } from "./commands/status";
import { runGithubUsageCommand } from "./commands/github-usage";
import { runWorktreesCommand } from "./commands/worktrees";
import { runSandboxCommand } from "./commands/sandbox";
import { runSandboxSeedCommand } from "./commands/sandbox-seed";
import { getTaskNowDoingLine, getTaskOpencodeProfileName } from "./status-utils";
import { createEscalationConsultantScheduler } from "./escalation-consultant/scheduler";
import { RepoSlotManager, parseRepoSlot, parseRepoSlotFromWorktreePath } from "./repo-slot-manager";
import { isLoopbackHost, startControlPlaneServer, type ControlPlaneServer } from "./dashboard/control-plane-server";
import { toControlPlaneStateV1 } from "./dashboard/control-plane-state";
import { buildProvisionPlan } from "./sandbox/provisioning-core";
import {
  applySeedFromSpec,
  executeProvisionPlan,
  findLatestManifestPath,
  readManifestOrNull,
} from "./sandbox/provisioning-io";
import { writeSandboxManifest } from "./sandbox/manifest";
import { getBaselineSeedSpec, loadSeedSpecFromFile } from "./sandbox/seed-spec";

// --- State ---

const workers = new Map<string, RepoWorker>();
const workersBySlot = new Map<string, RepoWorker>();
const repoSlotManager = new RepoSlotManager(getRepoConcurrencySlots);
const repoStartupCleanup = new Set<string>();
let rollupMonitor: RollupMonitor;
let isShuttingDown = false;
let drainMonitor: DrainMonitor | null = null;
let drainRequestedAt: number | null = null;
let drainTimeoutMs: number | null = null;
let dashboardEventPersistence: DashboardEventPersistence | null = null;
let controlPlaneServer: ControlPlaneServer | null = null;
let pauseRequestedByControl = false;
let pauseAtCheckpoint: RalphCheckpoint | null = null;
let githubIssuePollers: { stop: () => void } | null = null;
let githubDoneReconciler: { stop: () => void } | null = null;
let githubLabelReconciler: { stop: () => void } | null = null;
let githubCmdProcessor: { stop: () => void } | null = null;
let autoQueueRunner: ReturnType<typeof createAutoQueueRunner> | null = null;

const daemonId = `d_${crypto.randomUUID()}`;
const daemonStartedAt = new Date().toISOString();
const daemonCommand = [process.execPath, ...process.argv.slice(1)];
const daemonVersion = getRalphVersion();

const IDLE_ROLLUP_CHECK_MS = 15_000;
const IDLE_ROLLUP_THRESHOLD_MS = 5 * 60_000;
const ESCALATION_CONSULTANT_INTERVAL_MS = 60_000;

const idleState = new Map<
  string,
  {
    idleSince: number | null;
    lastQueuedCount: number;
    lastInFlightCount: number;
    lastCheckedAt: number;
  }
>();

function getDaemonMode(defaults?: Partial<ControlConfig>): DaemonMode {
  if (drainMonitor) return drainMonitor.getMode();
  return readControlStateSnapshot({ log: (message) => console.warn(message), defaults }).mode;
}

function getDrainSnapshotState(): StatusDrainState {
  return {
    requestedAt: drainRequestedAt,
    timeoutMs: drainTimeoutMs,
    pauseRequested: pauseRequestedByControl,
    pauseAtCheckpoint,
  };
}

function applyControlState(control: {
  mode: DaemonMode;
  pauseRequested?: boolean;
  pauseAtCheckpoint?: string;
  drainTimeoutMs?: number;
}): void {
  const mode = control.mode;
  if (mode === "draining" && drainRequestedAt === null) {
    drainRequestedAt = Date.now();
  }
  if (mode !== "draining") {
    drainRequestedAt = null;
  }

  if (typeof control.drainTimeoutMs === "number") {
    drainTimeoutMs = control.drainTimeoutMs;
  } else {
    drainTimeoutMs = null;
  }

  pauseRequestedByControl = control.pauseRequested === true;

  if (typeof control.pauseAtCheckpoint === "string" && isRalphCheckpoint(control.pauseAtCheckpoint)) {
    pauseAtCheckpoint = control.pauseAtCheckpoint as RalphCheckpoint;
  } else {
    pauseAtCheckpoint = null;
  }
}

function getActiveOpencodeProfileName(defaults?: Partial<ControlConfig>): string | null {
  // Source of truth is config (opencode.defaultProfile). The control file no longer controls profile.
  return getRequestedOpencodeProfileName(null);
}

async function resolveEffectiveOpencodeProfileNameForNewTasks(
  now: number,
  defaults?: Partial<ControlConfig>
): Promise<string | null> {
  const requested = getActiveOpencodeProfileName(defaults);
  const resolved = await resolveOpencodeProfileForNewWork(now, requested);
  return resolved.profileName;
}

function getTaskKey(task: Pick<AgentTask, "_path" | "name">): string {
  return task._path || task.name;
}

// Track in-flight tasks to avoid double-processing
const inFlightTasks = new Set<string>();
const activeSessionTasks = new Map<
  string,
  { task: AgentTask; workerId?: string; taskId?: string }
>();
const activityStateBySession = new Map<string, { activity: ActivityLabel; lastEmittedAt: number }>();
const ownedTasks = new Map<string, string>();

function shouldEmitActivityUpdate(params: {
  sessionId: string;
  activity: ActivityLabel;
  now: number;
}): boolean {
  const existing = activityStateBySession.get(params.sessionId);
  if (!existing) return true;
  if (existing.activity !== params.activity) return true;
  return params.now - existing.lastEmittedAt >= ACTIVITY_EMIT_INTERVAL_MS;
}

function recordActivityState(params: { sessionId: string; activity: ActivityLabel; now: number }): void {
  activityStateBySession.set(params.sessionId, { activity: params.activity, lastEmittedAt: params.now });
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const pendingResumeTasks = new Map<string, AgentTask>();
const pendingResumeWaiters = new Map<string, Deferred>();
let resumeSchedulingMode: "shared" | "resume-only" = "shared";

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function queueResumeTasks(tasks: AgentTask[], trackCompletion: boolean): Promise<void>[] {
  const completions: Promise<void>[] = [];

  for (const task of tasks) {
    const key = getTaskKey(task);
    if (!pendingResumeTasks.has(key)) {
      pendingResumeTasks.set(key, task);
    }

    if (!trackCompletion) continue;

    let deferred = pendingResumeWaiters.get(key);
    if (!deferred) {
      deferred = createDeferred();
      pendingResumeWaiters.set(key, deferred);
    }
    completions.push(deferred.promise);
  }

  return completions;
}

function resolveResumeCompletion(key: string): void {
  const deferred = pendingResumeWaiters.get(key);
  if (!deferred) return;
  pendingResumeWaiters.delete(key);
  deferred.resolve();
}

let globalSemaphore: Semaphore | null = null;
const repoSemaphores = new Map<string, Semaphore>();

const rrCursor = { value: 0 };
const schedulerPriorityState = { value: createPrioritySelectorState() };

function maybeExitIfAllReposUnschedulableDueToLegacyLabels(repos: string[]): void {
  if (repos.length === 0) return;

  // Avoid exiting while work is in-flight; surfacing the diagnostics is enough.
  if (inFlightTasks.size > 0 || ownedTasks.size > 0) return;

  let checkedCount = 0;
  let legacyCount = 0;

  for (const repo of repos) {
    const state = getRepoLabelSchemeState(repo);
    if (!state.checkedAt) continue;
    checkedCount += 1;
    if (state.errorCode === "legacy-workflow-labels") legacyCount += 1;
  }

  // Only make this fatal once we've actually checked every configured repo.
  if (checkedCount !== repos.length) return;
  if (legacyCount !== repos.length) return;

  console.error(
    "[ralph] All configured repos are unschedulable due to legacy workflow labels. Manual cutover required: see docs/ops/label-scheme-migration.md"
  );
  process.exit(1);
}

function ensureSemaphores(): void {
  if (globalSemaphore) return;
  const config = getConfig();
  globalSemaphore = new Semaphore(config.maxWorkers);
}

function getRepoSemaphore(repo: string): Semaphore {
  let sem = repoSemaphores.get(repo);
  if (!sem) {
    sem = new Semaphore(getRepoConcurrencySlots(repo));
    repoSemaphores.set(repo, sem);
  }
  return sem;
}

function buildRepoOrderForTasks(tasks: AgentTask[], priorityTasks: AgentTask[]): string[] {
  const repoSet = new Set<string>();
  for (const task of tasks) repoSet.add(task.repo);
  for (const task of priorityTasks) repoSet.add(task.repo);
  if (repoSet.size === 0) return [];

  const cfg = getConfig();
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const repo of cfg.repos.map((entry) => entry.name)) {
    if (!repoSet.has(repo)) continue;
    ordered.push(repo);
    seen.add(repo);
  }

  const extras = Array.from(repoSet)
    .filter((repo) => !seen.has(repo))
    .sort((a, b) => a.localeCompare(b));

  return ordered.concat(extras);
}

function buildSchedulerPriorityConfig(repoOrder: string[]): { enabled: boolean; priorities: Map<string, number> } {
  const cfg = getConfig();
  const explicit = new Map<string, number>();

  for (const repo of cfg.repos) {
    const priority = getRepoSchedulerPriority(repo.name);
    if (priority !== null) explicit.set(repo.name, priority);
  }

  const enabled = explicit.size > 0;
  const priorities = new Map<string, number>();

  for (const repo of repoOrder) {
    priorities.set(repo, explicit.get(repo) ?? DEFAULT_REPO_SCHEDULER_PRIORITY);
  }

  return { enabled, priorities };
}

async function checkIdleRollups(): Promise<void> {
  if (isShuttingDown) return;
  const config = getConfig();
  if (getDaemonMode(config.control) === "draining") return;
  if (inFlightTasks.size > 0) return;

  const queued = await getRunnableTasks();
  if (queued.length > 0) {
    resetIdleState(queued);
    return;
  }

  const repos = new Set(config.repos.map((repo) => repo.name));
  for (const repo of workers.keys()) repos.add(repo);
  if (repos.size === 0) return;

  const now = Date.now();
  const repoList = Array.from(repos);
  const idleRepos: string[] = [];

  for (const repo of repoList) {
    const state = idleState.get(repo) ?? {
      idleSince: null,
      lastQueuedCount: 0,
      lastInFlightCount: 0,
      lastCheckedAt: 0,
    };

    if (!state.idleSince) {
      state.idleSince = now;
    }

    state.lastQueuedCount = 0;
    state.lastInFlightCount = 0;
    state.lastCheckedAt = now;
    idleState.set(repo, state);

    const idleFor = now - state.idleSince;
    if (idleFor >= IDLE_ROLLUP_THRESHOLD_MS) {
      idleRepos.push(repo);
    } else if (shouldLog(`rollup:idle-wait:${repo}`, 60_000)) {
      console.log(
        `[ralph:rollup] Waiting ${formatDuration(IDLE_ROLLUP_THRESHOLD_MS - idleFor)} before idle rollup check for ${repo}`
      );
    }
  }

  if (idleRepos.length === 0) return;

  await Promise.all(
    idleRepos.map(async (repo) => {
      try {
        const prUrl = await rollupMonitor.checkIdleRollup(repo);
        if (prUrl && shouldLog(`rollup:idle:${repo}`, 60_000)) {
          console.log(`[ralph:rollup] Idle rollup created for ${repo}: ${prUrl}`);
        }
      } catch (e: any) {
        console.error(`[ralph:rollup] Idle rollup check failed for ${repo}:`, e);
      } finally {
        idleState.set(repo, {
          idleSince: now,
          lastQueuedCount: 0,
          lastInFlightCount: 0,
          lastCheckedAt: now,
        });
      }
    })
  );
}

function resetIdleState(queued: AgentTask[]): void {
  const now = Date.now();
  const countsByRepo = groupByRepo(queued);

  for (const [repo, tasks] of countsByRepo) {
    idleState.set(repo, {
      idleSince: null,
      lastQueuedCount: tasks.length,
      lastInFlightCount: inFlightTasks.size,
      lastCheckedAt: now,
    });
  }

  for (const repo of idleState.keys()) {
    if (countsByRepo.has(repo)) continue;
    idleState.set(repo, {
      idleSince: null,
      lastQueuedCount: 0,
      lastInFlightCount: inFlightTasks.size,
      lastCheckedAt: now,
    });
  }
}

function getOrCreateWorker(repo: string): RepoWorker {
  let worker = workers.get(repo);
  if (worker) return worker;

  const repoPath = getRepoPath(repo);
  const created = new RepoWorker(repo, repoPath);
  workers.set(repo, created);
  console.log(`[ralph] Created worker for ${repo} -> ${repoPath}`);
  ensureRepoStartupCleanup(repo, created);
  return created;
}

function getWorkerSlotKey(repo: string, repoSlot: number): string {
  return `${repo}::${repoSlot}`;
}

function ensureRepoStartupCleanup(repo: string, worker: RepoWorker): void {
  if (repoStartupCleanup.has(repo)) return;
  repoStartupCleanup.add(repo);
  void worker.runStartupCleanup();
}

function getOrCreateWorkerForSlot(repo: string, repoSlot: number): RepoWorker {
  const key = getWorkerSlotKey(repo, repoSlot);
  let worker = workersBySlot.get(key);
  if (worker) return worker;

  const repoPath = getRepoPath(repo);
  const created = new RepoWorker(repo, repoPath);
  workersBySlot.set(key, created);
  console.log(`[ralph] Created worker slot ${repoSlot} for ${repo} -> ${repoPath}`);
  ensureRepoStartupCleanup(repo, created);
  return created;
}

function getTaskRepoSlotHint(task: AgentTask): number | null {
  const explicit = parseRepoSlot(task["repo-slot"]);
  if (explicit !== null) return explicit;
  return parseRepoSlotFromWorktreePath(task["worktree-path"]?.trim());
}

function reserveRepoSlotForTask(task: AgentTask): { slot: number; release: () => void } | null {
  const taskKey = getTaskKey(task);
  const preferred = getTaskRepoSlotHint(task);
  const reservation = repoSlotManager.reserveSlotForTask(task.repo, taskKey, { preferred });
  if (!reservation) return null;
  return { slot: reservation.slot, release: reservation.release };
}

async function seedRepoSlotReservations(): Promise<void> {
  const statuses: AgentTask["status"][] = ["starting", "in-progress", "paused", "throttled"];
  const tasks = (await Promise.all(statuses.map((status) => getTasksByStatus(status)))).flat();
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const taskKey = getTaskKey(task);
    const preferred = getTaskRepoSlotHint(task);
    const reservation = repoSlotManager.reserveSlotForTask(task.repo, taskKey, { preferred });
    if (!reservation) {
      console.warn(
        `[scheduler] repoSlot reservation failed on startup (repo=${task.repo}, task=${task._path ?? task.name})`
      );
      continue;
    }

    if (preferred === null || preferred !== reservation.slot) {
      await updateTaskStatus(task, task.status, { "repo-slot": String(reservation.slot) });
      task["repo-slot"] = String(reservation.slot);
    }
  }
}

async function getRunnableTasks(): Promise<AgentTask[]> {
  const [starting, queued] = await Promise.all([getTasksByStatus("starting"), getQueuedTasks()]);
  return [...starting, ...queued];
}

function recordOwnedTask(task: AgentTask): void {
  const key = getTaskKey(task);
  const path = task._path || "";
  if (path) ownedTasks.set(key, path);
}

function forgetOwnedTask(task: AgentTask): void {
  const key = getTaskKey(task);
  ownedTasks.delete(key);
}

const schedulerController = createSchedulerController({
  getDaemonMode: () => {
    const config = getConfig();
    return getDaemonMode(config.control);
  },
  isShuttingDown: () => isShuttingDown,
  getRunnableTasks: () => getRunnableTasks(),
  onRunnableTasks: (tasks) => {
    const config = getConfig();
    return processNewTasks(tasks, config.control ?? {});
  },
  getPendingResumeTasks: () => Array.from(pendingResumeTasks.values()),
  onPendingResumeTasks: (priorityTasks) => {
    ensureSemaphores();
    if (!globalSemaphore) return;

    const repoOrder = buildRepoOrderForTasks([], priorityTasks);
    const priorityConfig = buildSchedulerPriorityConfig(repoOrder);

    void startQueuedTasks({
      gate: "running",
      tasks: [],
      priorityTasks,
      inFlightTasks,
      getTaskKey: (t) => getTaskKey(t),
      groupByRepo,
      globalSemaphore,
      getRepoSemaphore,
      rrCursor,
      repoOrder,
      repoPriorities: priorityConfig.priorities,
      priorityEnabled: priorityConfig.enabled,
      priorityState: schedulerPriorityState,
      getTaskPriorityWeight: (task: AgentTask) => issuePriorityWeight(task.priority),
      shouldLog,
      log: (message) => console.log(message),
      startTask,
      startPriorityTask: startResumeTask,
    });
  },
});

function scheduleQueuedTasksSoon(): void {
  schedulerController.scheduleQueuedTasksSoon();
}

function scheduleResumeTasksSoon(): void {
  schedulerController.scheduleResumeTasksSoon();
}

const resumeAttemptedThisRun = new Set<string>();
let resumeDisabledUntil = 0;

const RESUME_DISABLE_MS = 60_000;

async function attemptResumeResolvedEscalations(): Promise<void> {
  return attemptResumeResolvedEscalationsImpl({
    isShuttingDown: () => isShuttingDown,
    now: () => Date.now(),

    resumeAttemptedThisRun,
    getResumeDisabledUntil: () => resumeDisabledUntil,
    setResumeDisabledUntil: (ts) => {
      resumeDisabledUntil = ts;
    },
    resumeDisableMs: RESUME_DISABLE_MS,
    getVaultPathForLogs: () => "<not-applicable>",

    ensureSemaphores,
    getGlobalSemaphore: () => globalSemaphore,
    getRepoSemaphore,

    getTaskKey,
    inFlightTasks,
    tryClaimTask,
    recordOwnedTask,
    forgetOwnedTask,
    daemonId,

    getEscalationsByStatus,
    editEscalation,
    readResolutionMessage,

    getTaskByPath,
    updateTaskStatus,

    shouldDeferWaitingResolutionCheck,
    buildWaitingResolutionUpdate,
    resolutionRecheckIntervalMs: DEFAULT_RESOLUTION_RECHECK_INTERVAL_MS,

    getOrCreateWorker,
    recordMerge: async (repo, prUrl) => {
      try {
        recordPrSnapshot({ repo, issue: "", prUrl, state: PR_STATE_MERGED });
      } catch {
        // best-effort
      }

      await rollupMonitor.recordMerge(repo, prUrl);
    },
    scheduleQueuedTasksSoon,
  });
}

async function attemptResumeThrottledTasks(defaults: Partial<ControlConfig>): Promise<void> {
  if (getDaemonMode(defaults) === "draining" || isShuttingDown) return;

  ensureSemaphores();
  if (!globalSemaphore) return;

  const throttled = await getTasksByStatus("throttled");
  if (throttled.length === 0) return;

  const nowMs = Date.now();
  const claimable: AgentTask[] = [];
  const heartbeatCutoffMs = nowMs - getConfig().ownershipTtlMs;
  for (const task of throttled) {
    const heartbeatMs = parseHeartbeatMs(task["heartbeat-at"]);
    if (heartbeatMs && heartbeatMs < heartbeatCutoffMs && shouldLog(`ownership:stale:${task._path}`, 60_000)) {
      console.warn(
        `[ralph] Task heartbeat is stale; eligible for takeover: ${task.name} (last ${new Date(heartbeatMs).toISOString()})`
      );
    }

    const claim = await tryClaimTask({ task, daemonId, nowMs });
    if (claim.claimed && claim.task) {
      recordOwnedTask(claim.task);
      claimable.push(claim.task);
    } else if (claim.reason && shouldLog(`ownership:skip:${task._path}`, 60_000)) {
      console.log(`[ralph] Skipping throttled task ${task.name}: ${claim.reason}`);
    }
  }

  if (claimable.length === 0) return;

  const controlProfile = getActiveOpencodeProfileName(defaults);
  const activeProfile = controlProfile === "auto" ? await resolveAutoOpencodeProfileName(Date.now()) : controlProfile;
  const profileKeys = Array.from(
    new Set(claimable.map((t) => getTaskOpencodeProfileName(t) ?? activeProfile ?? ""))
  );

  const hardByProfile = new Map<string, { hard: boolean; decision: ThrottleDecision }>();

  await Promise.all(
    profileKeys.map(async (profileKey) => {
      const decision = await getThrottleDecision(Date.now(), { opencodeProfile: profileKey ? profileKey : null });
      hardByProfile.set(profileKey, { hard: decision.state === "hard", decision });
    })
  );

  const now = Date.now();

  for (const task of claimable) {
    if (getDaemonMode(defaults) === "draining" || isShuttingDown) return;

    const resumeAtRaw = task["resume-at"]?.trim() ?? "";
    const resumeAtTs = resumeAtRaw ? Date.parse(resumeAtRaw) : Number.NaN;
    if (Number.isFinite(resumeAtTs) && resumeAtTs > now) continue;

    const profileKey = getTaskOpencodeProfileName(task) ?? activeProfile ?? "";
    const throttleForProfile = hardByProfile.get(profileKey);

    if (throttleForProfile?.hard) {
      if (shouldLog(`daemon:hard-throttle-resume:${profileKey || "ambient"}`, 60_000)) {
        console.warn(
          `[ralph] Hard throttle active (profile=${profileKey || "ambient"}); deferring resume of throttled tasks until ` +
            `${throttleForProfile.decision.snapshot.resumeAt ?? "unknown"}`
        );
      }
      continue;
    }

    const sessionId = task["session-id"]?.trim() ?? "";
    if (!sessionId) {
      await updateTaskStatus(task, "queued", {
        "throttled-at": "",
        "resume-at": "",
        "usage-snapshot": "",
      });
      continue;
    }

    const taskKey = getTaskKey(task);
    if (inFlightTasks.has(taskKey)) continue;

    const releaseGlobal = globalSemaphore.tryAcquire();
    if (!releaseGlobal) return;

    const releaseRepo = getRepoSemaphore(task.repo).tryAcquire();
    if (!releaseRepo) {
      releaseGlobal();
      continue;
    }

    await updateTaskStatus(task, "in-progress", {
      "assigned-at": new Date().toISOString().split("T")[0],
      "session-id": sessionId,
      "throttled-at": "",
      "resume-at": "",
      "usage-snapshot": "",
    });

    inFlightTasks.add(taskKey);

    getOrCreateWorker(task.repo)
      .resumeTask(task, { resumeMessage: "Continue." })
       .then(async (run) => {
         if (run.outcome === "success" && run.pr) {
           try {
             recordPrSnapshot({ repo: task.repo, issue: task.issue, prUrl: run.pr, state: PR_STATE_MERGED });
           } catch {
             // best-effort
           }

           await rollupMonitor.recordMerge(task.repo, run.pr);
         }
       })
      .catch((e: any) => {
        console.error(`[ralph] Error resuming throttled task ${task.name}:`, e);
      })
    .finally(() => {
      inFlightTasks.delete(taskKey);
      forgetOwnedTask(task);
      releaseGlobal();
      releaseRepo();
      if (!isShuttingDown) {
        scheduleQueuedTasksSoon();
        void checkIdleRollups();
      }
    });

  }
}

async function startTask(opts: {
  repo: string;
  task: AgentTask;
  releaseGlobal: () => void;
  releaseRepo: () => void;
}): Promise<boolean> {
  const { repo, task, releaseGlobal, releaseRepo } = opts;
  const initialKey = getTaskKey(task);
  inFlightTasks.add(initialKey);

  let releaseSlot: (() => void) | null = null;

  try {
    const nowMs = Date.now();
    const claim = await tryClaimTask({ task, daemonId, nowMs });

    if (!claim.claimed || !claim.task) {
      if (claim.reason && shouldLog(`ownership:skip:${task._path}`, 60_000)) {
        console.log(`[ralph] Skipping task ${task.name}: ${claim.reason}`);
      }
      inFlightTasks.delete(initialKey);
      if (!isShuttingDown) scheduleQueuedTasksSoon();
      return false;
    }

    const claimedTask = claim.task;
    recordOwnedTask(claimedTask);

    const key = getTaskKey(claimedTask);
    if (key !== initialKey) {
      inFlightTasks.delete(initialKey);
      inFlightTasks.add(key);
    }

    const reconcile = await getOrCreateWorker(repo).tryReconcileMergeablePrForQueuedTask(claimedTask);
    if (reconcile.handled) {
      if (reconcile.merged) {
        try {
          recordPrSnapshot({ repo, issue: claimedTask.issue, prUrl: reconcile.prUrl, state: PR_STATE_MERGED });
        } catch {
          // best-effort
        }
        await rollupMonitor.recordMerge(repo, reconcile.prUrl);
        console.log(`[ralph] Reconciled mergeable PR for ${claimedTask.issue}: ${reconcile.prUrl}`);
      } else {
        console.warn(`[ralph] Reconcile merge attempt failed for ${claimedTask.issue}: ${reconcile.reason}`);
      }

      inFlightTasks.delete(key);
      forgetOwnedTask(claimedTask);
      releaseGlobal();
      releaseRepo();
      if (!isShuttingDown) {
        scheduleQueuedTasksSoon();
        void checkIdleRollups();
      }
      return true;
    }

    try {
      const reservation = reserveRepoSlotForTask(claimedTask);
      if (!reservation) {
        if (shouldLog(`scheduler:repo-slot:${claimedTask.repo}`, 30_000)) {
          console.warn(`[scheduler] Repo concurrency slots full; deferring ${claimedTask.name}`);
        }
        inFlightTasks.delete(key);
        forgetOwnedTask(claimedTask);
        if (!isShuttingDown) scheduleQueuedTasksSoon();
        return false;
      }
      releaseSlot = reservation.release;
      const slot = reservation.slot;

      const blockedSource = claimedTask["blocked-source"]?.trim() || "";
      const sessionId = claimedTask["session-id"]?.trim() || "";
      const shouldResumeMergeConflict = sessionId && blockedSource === "merge-conflict";
      const shouldResumeStall = sessionId && blockedSource === "stall";
      const shouldResumeQueuedSession = sessionId && !shouldResumeMergeConflict && !shouldResumeStall;

      if (shouldResumeMergeConflict) {
        console.log(
          `[ralph] Requeued merge-conflict task ${claimedTask.name}; resuming session ${sessionId} for conflict resolution`
        );

        await updateTaskStatus(claimedTask, "in-progress", {
          "assigned-at": new Date().toISOString().split("T")[0],
          "session-id": sessionId,
          "throttled-at": "",
          "resume-at": "",
          "usage-snapshot": "",
          "blocked-source": "",
          "blocked-reason": "",
          "blocked-details": "",
          "blocked-at": "",
          "blocked-checked-at": "",
        });

        void getOrCreateWorkerForSlot(repo, slot)
          .resumeTask(claimedTask, {
            resumeMessage:
              "This task already has an open PR with merge conflicts blocking CI. Resolve the merge conflicts by rebasing/merging the base branch into the PR branch, push updates, and continue with the existing PR only.",
            repoSlot: slot,
          })
          .then(async (run: AgentRun) => {
            if (run.outcome === "success" && run.pr) {
              try {
                recordPrSnapshot({ repo, issue: claimedTask.issue, prUrl: run.pr, state: PR_STATE_MERGED });
              } catch {
                // best-effort
              }

              await rollupMonitor.recordMerge(repo, run.pr);
            }
          })
          .catch((e) => {
            console.error(`[ralph] Error resuming task ${claimedTask.name}:`, e);
          })
          .finally(() => {
            inFlightTasks.delete(key);
            forgetOwnedTask(claimedTask);
            releaseSlot?.();
            releaseGlobal();
            releaseRepo();
            if (!isShuttingDown) {
              scheduleQueuedTasksSoon();
              void checkIdleRollups();
            }
          });

        return true;
      }

      if (shouldResumeStall) {
        const cfg = getConfig().stall;
        const idleMs = cfg?.nudgeAfterMs ?? cfg?.idleMs ?? 5 * 60_000;
        const idleMinutes = Math.round(idleMs / 60_000);

        console.log(`[ralph] Requeued stalled task ${claimedTask.name}; nudging session ${sessionId} to resume work`);

        await updateTaskStatus(claimedTask, "in-progress", {
          "assigned-at": new Date().toISOString().split("T")[0],
          "session-id": sessionId,
          "throttled-at": "",
          "resume-at": "",
          "usage-snapshot": "",
          "blocked-source": "",
          "blocked-reason": "",
          "blocked-details": "",
          "blocked-at": "",
          "blocked-checked-at": "",
        });

        void getOrCreateWorkerForSlot(repo, slot)
          .resumeTask(claimedTask, {
            resumeMessage:
              `You have been idle for ~${idleMinutes}m. Decide next action: continue, rerun the last command, or escalate with a question. Then proceed.`,
            repoSlot: slot,
          })
          .then(async (run: AgentRun) => {
            if (run.outcome === "success" && run.pr) {
              try {
                recordPrSnapshot({ repo, issue: claimedTask.issue, prUrl: run.pr, state: PR_STATE_MERGED });
              } catch {
                // best-effort
              }

              await rollupMonitor.recordMerge(repo, run.pr);
            }
          })
          .catch((e) => {
            console.error(`[ralph] Error resuming task ${claimedTask.name}:`, e);
          })
          .finally(() => {
            inFlightTasks.delete(key);
            forgetOwnedTask(claimedTask);
            releaseSlot?.();
            releaseGlobal();
            releaseRepo();
            if (!isShuttingDown) {
              scheduleQueuedTasksSoon();
              void checkIdleRollups();
            }
          });

        return true;
      }

      if (shouldResumeQueuedSession) {
        console.log(`[ralph] Requeued task ${claimedTask.name}; resuming existing session ${sessionId}`);

        await updateTaskStatus(claimedTask, "in-progress", {
          "assigned-at": new Date().toISOString().split("T")[0],
          "session-id": sessionId,
          "throttled-at": "",
          "resume-at": "",
          "usage-snapshot": "",
          "blocked-source": "",
          "blocked-reason": "",
          "blocked-details": "",
          "blocked-at": "",
          "blocked-checked-at": "",
        });

        void getOrCreateWorkerForSlot(repo, slot)
          .resumeTask(claimedTask, {
            resumeMessage:
              "This task already has an OpenCode session. Resume from where you left off. " +
              "If the issue has recent operator guidance in comments, apply it before continuing.",
            repoSlot: slot,
          })
          .then(async (run: AgentRun) => {
            if (run.outcome === "success" && run.pr) {
              try {
                recordPrSnapshot({ repo, issue: claimedTask.issue, prUrl: run.pr, state: PR_STATE_MERGED });
              } catch {
                // best-effort
              }

              await rollupMonitor.recordMerge(repo, run.pr);
            }
          })
          .catch((e) => {
            console.error(`[ralph] Error resuming task ${claimedTask.name}:`, e);
          })
          .finally(() => {
            inFlightTasks.delete(key);
            forgetOwnedTask(claimedTask);
            releaseSlot?.();
            releaseGlobal();
            releaseRepo();
            if (!isShuttingDown) {
              scheduleQueuedTasksSoon();
              void checkIdleRollups();
            }
          });

        return true;
      }

      void getOrCreateWorkerForSlot(repo, slot)
        .processTask(claimedTask, { repoSlot: slot })
        .then(async (run: AgentRun) => {
          if (run.outcome === "success" && run.pr) {
            try {
              recordPrSnapshot({ repo, issue: claimedTask.issue, prUrl: run.pr, state: PR_STATE_MERGED });
            } catch {
              // best-effort
            }

            await rollupMonitor.recordMerge(repo, run.pr);
          }
        })
        .catch((e) => {
          console.error(`[ralph] Error processing task ${claimedTask.name}:`, e);
        })
        .finally(() => {
          inFlightTasks.delete(key);
          forgetOwnedTask(claimedTask);
          releaseSlot?.();
          releaseGlobal();
          releaseRepo();
          if (!isShuttingDown) {
            scheduleQueuedTasksSoon();
            void checkIdleRollups();
          }
        });
    } catch (error: any) {
      console.error(`[ralph] Error starting task ${claimedTask.name}:`, error);
      inFlightTasks.delete(key);
      forgetOwnedTask(claimedTask);
      releaseSlot?.();
      if (!isShuttingDown) scheduleQueuedTasksSoon();
      return false;
    }
    return true;
  } catch (error: any) {
    console.error(`[ralph] Error claiming task ${task.name}:`, error);
    inFlightTasks.delete(initialKey);
    if (!isShuttingDown) scheduleQueuedTasksSoon();
    return false;
  }
}

function startResumeTask(opts: {
  repo: string;
  task: AgentTask;
  releaseGlobal: () => void;
  releaseRepo: () => void;
}): boolean {
  const { repo, task, releaseGlobal, releaseRepo } = opts;
  const key = getTaskKey(task);

  const reservation = reserveRepoSlotForTask(task);
  if (!reservation) {
    if (shouldLog(`scheduler:repo-slot:${task.repo}`, 30_000)) {
      console.warn(`[scheduler] Repo concurrency slots full; deferring resume for ${task.name}`);
    }
    return false;
  }

  pendingResumeTasks.delete(key);
  inFlightTasks.add(key);

  void getOrCreateWorkerForSlot(repo, reservation.slot)
    .resumeTask(task, { repoSlot: reservation.slot })
    .then(() => {
      // ignore
    })
    .catch((e: any) => {
      console.error(`[ralph] Error resuming task ${task.name}:`, e);
    })
    .finally(() => {
      inFlightTasks.delete(key);
      forgetOwnedTask(task);
      reservation.release();
      releaseGlobal();
      releaseRepo();
      resolveResumeCompletion(key);
      if (!isShuttingDown) {
        const scheduleNext = resumeSchedulingMode === "resume-only" ? scheduleResumeTasksSoon : scheduleQueuedTasksSoon;
        scheduleNext();
        void checkIdleRollups();
      }
    });

  return true;
}

// --- Main Logic ---

async function processNewTasks(tasks: AgentTask[], defaults: Partial<ControlConfig>): Promise<void> {
  ensureSemaphores();
  if (!globalSemaphore) return;

  const isDraining = getDaemonMode(defaults) === "draining";
  if (isDraining && pendingResumeTasks.size === 0) return;

  const selection = await resolveOpencodeProfileForNewWork(Date.now(), getActiveOpencodeProfileName(defaults));
  const throttle = selection.decision;
  const gate = computeDaemonGate({ mode: getDaemonMode(), throttle, isShuttingDown });

  if (selection.source === "failover") {
    const requested = selection.requestedProfile ?? "default";
    const chosen = throttle.snapshot.opencodeProfile ?? "ambient";

    if (shouldLog(`daemon:opencode-profile-failover:${requested}->${chosen}`, 60_000)) {
      console.warn(`[ralph] Hard throttle on profile=${requested}; failing over to profile=${chosen} for new tasks`);
    }
  }

  if (!gate.allowModelSend) {
    if (gate.reason === "hard-throttled" && shouldLog("daemon:hard-throttle", 30_000)) {
      console.warn(
        `[ralph] Hard throttle active (profile=${throttle.snapshot.opencodeProfile ?? "ambient"}); skipping task scheduling until ${
          throttle.snapshot.resumeAt ?? "unknown"
        }`
      );
    }
    return;
  }

  if (!gate.allowDequeue && pendingResumeTasks.size === 0) return;
  if (throttle.state === "soft") return;

  const blockedTasks = await getTasksByStatus("blocked");
  const blockedPaths = new Set<string>();
  const tasksForSync = [...tasks, ...blockedTasks];
  const tasksByRepoForSync = groupByRepo(tasksForSync);
  await Promise.all(
    Array.from(tasksByRepoForSync.entries()).map(async ([repo, repoTasks]) => {
      const worker = getOrCreateWorker(repo);
      try {
        const blocked = await worker.syncBlockedStateForTasks(repoTasks);
        blocked.forEach((path) => blockedPaths.add(path));
      } catch (error: any) {
        console.warn(`[ralph] Failed to sync blocked state for ${repo}: ${error?.message ?? String(error)}`);
      }
    })
  );

  const unblockedTasks = tasks.filter((task) => !(task._path && blockedPaths.has(task._path)));
  const queueTasks = isDraining ? [] : unblockedTasks;
  const pendingResumes = Array.from(pendingResumeTasks.values());

  if (queueTasks.length > 0) {
    resetIdleState(queueTasks);
  } else if (!isDraining) {
    resetIdleState(tasks);
  }

  const repoOrder = buildRepoOrderForTasks(queueTasks, pendingResumes);
  const priorityConfig = buildSchedulerPriorityConfig(repoOrder);

  const startedCount = await startQueuedTasks({
    gate: "running",
    tasks: queueTasks,
    priorityTasks: pendingResumes,
    inFlightTasks,
    getTaskKey: (t) => getTaskKey(t),
    groupByRepo,
    globalSemaphore,
    getRepoSemaphore,
    rrCursor,
    repoOrder,
    repoPriorities: priorityConfig.priorities,
    priorityEnabled: priorityConfig.enabled,
    priorityState: schedulerPriorityState,
    getTaskPriorityWeight: (task: AgentTask) => issuePriorityWeight(task.priority),
    shouldLog,
    log: (message) => console.log(message),
    startTask,
    startPriorityTask: startResumeTask,
  });

  if (startedCount > 0) {
    console.log(`[ralph] Started ${startedCount} task(s)`);
  }
}

async function emitActivityUpdate(params: {
  sessionId: string;
  task: AgentTask;
  workerId?: string;
  taskId?: string;
}): Promise<void> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) return;

  try {
    const now = Date.now();
    const snapshot = await classifyActivity({
      sessionId,
      runLogPath: params.task["run-log-path"],
      now,
      windowMs: ACTIVITY_WINDOW_MS,
    });

    if (!shouldEmitActivityUpdate({ sessionId, activity: snapshot.activity, now })) return;

    publishDashboardEvent(
      {
        type: "worker.activity.updated",
        level: "info",
        workerId: params.workerId,
        repo: params.task.repo,
        taskId: params.taskId,
        sessionId,
        data: { activity: snapshot.activity },
      },
      { sessionId, workerId: params.workerId }
    );

    recordActivityState({ sessionId, activity: snapshot.activity, now });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.warn(`[ralph] Failed to classify activity: ${msg}`);
  }
}

async function printHeartbeatTick(): Promise<void> {
  const [starting, inProgress] = await Promise.all([getTasksByStatus("starting"), getTasksByStatus("in-progress")]);
  const tasks = [...starting, ...inProgress];
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const line = await getTaskNowDoingLine(task);
    console.log(`[ralph:hb] ${line}`);

    const sessionId = task["session-id"]?.trim();
    if (!sessionId) continue;

    const taskId = task._path || task.name;
    const workerId = taskId ? `${task.repo}#${taskId}` : undefined;
    activeSessionTasks.set(sessionId, { task, workerId, taskId });
  }

  const activeSessionIds = new Set(tasks.map((task) => task["session-id"]?.trim()).filter(Boolean) as string[]);

  for (const [sessionId, payload] of activeSessionTasks) {
    if (!activeSessionIds.has(sessionId)) {
      activeSessionTasks.delete(sessionId);
      continue;
    }

    await emitActivityUpdate({ sessionId, ...payload });
  }
}

async function refreshTaskOwnershipHeartbeat(nowMs: number): Promise<void> {
  if (ownedTasks.size === 0) return;

  const keys = Array.from(ownedTasks.keys());
  await Promise.all(
    keys.map(async (key) => {
      const path = ownedTasks.get(key);
      if (!path) return;

      const task = await getTaskByPath(path);
      if (!task) {
        ownedTasks.delete(key);
        return;
      }

      const updated = await heartbeatTask({ task, daemonId, nowMs });
      if (!updated) {
        ownedTasks.delete(key);
      }
    })
  );
}

async function resumeTasksOnStartup(opts?: {
  awaitCompletion?: boolean;
  schedulingMode?: "shared" | "resume-only";
}): Promise<void> {
  ensureSemaphores();
  if (!globalSemaphore) return;

  const awaitCompletion = opts?.awaitCompletion ?? true;
  const schedulingMode = opts?.schedulingMode ?? resumeSchedulingMode;

  const inProgress = await getTasksByStatus("in-progress");

  if (inProgress.length > 0) {
    console.log(`[ralph] Found ${inProgress.length} in-progress task(s) on startup`);
  }

  const nowMs = Date.now();
  const claimable: AgentTask[] = [];
  const heartbeatCutoffMs = nowMs - getConfig().ownershipTtlMs;
  for (const task of inProgress) {
    const heartbeatMs = parseHeartbeatMs(task["heartbeat-at"]);
    if (heartbeatMs && heartbeatMs < heartbeatCutoffMs && shouldLog(`ownership:stale:${task._path}`, 60_000)) {
      console.warn(
        `[ralph] Task heartbeat is stale; eligible for takeover: ${task.name} (last ${new Date(heartbeatMs).toISOString()})`
      );
    }

    const claim = await tryClaimTask({ task, daemonId, nowMs });
    if (claim.claimed && claim.task) {
      recordOwnedTask(claim.task);
      claimable.push(claim.task);
    } else if (claim.reason && shouldLog(`ownership:skip:${task._path}`, 60_000)) {
      console.log(`[ralph] Skipping resume for ${task.name}: ${claim.reason}`);
    }
  }

  const inProgressByRepo = groupByRepo(claimable);
  await Promise.all(
    Array.from(inProgressByRepo.entries()).map(async ([repo, tasks]) => {
      const worker = getOrCreateWorker(repo);
      await worker.runTaskCleanup(tasks);
    })
  );

  if (claimable.length === 0) return;

  const withoutSession = claimable.filter((t) => !(t["session-id"]?.trim()));
  for (const task of withoutSession) {
    console.warn(`[ralph] In-progress task has no session ID, resetting to starting: ${task.name}`);
    await updateTaskStatus(task, "starting", { "session-id": "" });
  }

  const withSession = claimable.filter((t) => t["session-id"]?.trim());
  if (withSession.length === 0) return;

  const globalLimit = getConfig().maxWorkers;

  const withSessionByRepo = groupByRepo(withSession);
  const repos = Array.from(withSessionByRepo.keys());
  const perRepoResumed = new Map<string, number>();

  const toResume: AgentTask[] = [];
  let cursor = 0;

  while (toResume.length < globalLimit) {
    let progressed = false;

    for (let i = 0; i < repos.length; i++) {
      const idx = (cursor + i) % repos.length;
      const repo = repos[idx];
      const repoTasks = withSessionByRepo.get(repo);
      if (!repoTasks || repoTasks.length === 0) continue;

      const limit = getRepoConcurrencySlots(repo);
      const already = perRepoResumed.get(repo) ?? 0;
      if (already >= limit) continue;

      const task = repoTasks.shift()!;
      toResume.push(task);
      perRepoResumed.set(repo, already + 1);
      cursor = (idx + 1) % repos.length;
      progressed = true;
      break;
    }

    if (!progressed) break;
  }

  const toRequeue: AgentTask[] = [];
  for (const repo of repos) {
    const remaining = withSessionByRepo.get(repo) ?? [];
    for (const task of remaining) toRequeue.push(task);
  }

  for (const task of toRequeue) {
    console.warn(
      `[ralph] Concurrency limits exceeded on startup; resetting in-progress task to queued: ${task.name} (${task.repo})`
    );
    repoSlotManager.releaseSlotForTask(task.repo, getTaskKey(task));
    await updateTaskStatus(task, "queued", { "session-id": "" });
  }

  if (toResume.length === 0) return;

  const completionPromises = queueResumeTasks(toResume, awaitCompletion);

  if (schedulingMode === "resume-only") {
    scheduleResumeTasksSoon();
  } else {
    scheduleQueuedTasksSoon();
  }

  if (awaitCompletion) {
    await Promise.allSettled(completionPromises);
  }
}

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║         Ralph Loop Orchestrator            ║");
  console.log("║     Autonomous Coding Task Processor       ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log("");

  // Load config
  const config = getConfig();
  // Initialize durable local state (SQLite)
  initStateDb();
  const queueState = getQueueBackendStateWithLabelHealth();

  if (queueState.health === "unavailable") {
    const reason = queueState.diagnostics ? ` ${queueState.diagnostics}` : "";
    console.error(`[ralph] Queue backend ${queueState.backend} unavailable.${reason}`);
    process.exit(1);
  }

  try {
    writeDaemonRecord({
      version: 1,
      daemonId,
      pid: process.pid,
      startedAt: daemonStartedAt,
      ralphVersion: daemonVersion,
      command: daemonCommand,
      cwd: process.cwd(),
      controlFilePath: resolveControlFilePath(),
    });
  } catch (e: any) {
    console.warn(`[ralph] Failed to write daemon record: ${e?.message ?? String(e)}`);
  }
  if (queueState.backend !== "none") {
    await seedRepoSlotReservations();
  }

  const retentionDays = getDashboardEventsRetentionDays();
  await cleanupDashboardEventLogs({ retentionDays });
  dashboardEventPersistence = installDashboardEventPersistence({
    bus: ralphEventBus,
    retentionDays,
  });

  autoQueueRunner = createAutoQueueRunner({
    scheduleQueuedTasksSoon,
  });

  const controlPlaneConfig = getDashboardControlPlaneConfig();
  if (controlPlaneConfig.enabled) {
    if (!controlPlaneConfig.token) {
      console.warn(`${"[ralph:control-plane]"} Enabled but no token configured; skipping startup`);
    } else if (!controlPlaneConfig.allowRemote && !isLoopbackHost(controlPlaneConfig.host)) {
      console.warn(
        `${"[ralph:control-plane]"} Host ${controlPlaneConfig.host} is not loopback. ` +
          `Set dashboard.controlPlane.allowRemote=true to override.`
      );
    } else {
      const signalControlReload = (): void => {
        try {
          process.kill(process.pid, "SIGUSR1");
        } catch {
          // ignore
        }
      };

      const resolveSessionIdForWorkerId = (workerId: string | null): string | null => {
        const needle = workerId?.trim();
        if (!needle) return null;
        for (const [sessionId, payload] of activeSessionTasks) {
          if (payload.workerId === needle) return sessionId;
        }
        return null;
      };

      controlPlaneServer = startControlPlaneServer({
        bus: ralphEventBus,
        getStateSnapshot: async () =>
          toControlPlaneStateV1(await collectStatusSnapshot({ drain: getDrainSnapshotState(), initStateDb: false })),
        token: controlPlaneConfig.token,
        host: controlPlaneConfig.host,
        port: controlPlaneConfig.port,
        exposeRawOpencodeEvents: controlPlaneConfig.exposeRawOpencodeEvents,
        replayLastDefault: controlPlaneConfig.replayLastDefault,
        replayLastMax: controlPlaneConfig.replayLastMax,
        commands: {
          pause: async ({ workerId, reason, checkpoint }) => {
            const patch = {
              mode: "paused" as const,
              pauseRequested: checkpoint ? true : undefined,
              pauseAtCheckpoint: checkpoint ?? undefined,
            };
            updateControlFile({ patch });
            signalControlReload();

            const sessionId = resolveSessionIdForWorkerId(workerId ?? null);
            publishDashboardEvent(
              {
                type: "worker.pause.requested",
                level: "info",
                ...(workerId ? { workerId } : {}),
                ...(sessionId ? { sessionId } : {}),
                data: reason ? { reason } : {},
              },
              { workerId: workerId ?? undefined, sessionId: sessionId ?? undefined }
            );
          },
          resume: async ({ workerId, reason }) => {
            const patch = {
              mode: "running" as const,
              pauseRequested: null,
              pauseAtCheckpoint: null,
              drainTimeoutMs: null,
            };
            updateControlFile({ patch });
            signalControlReload();

            const sessionId = resolveSessionIdForWorkerId(workerId ?? null);
            publishDashboardEvent(
              {
                type: "worker.pause.cleared",
                level: "info",
                ...(workerId ? { workerId } : {}),
                ...(sessionId ? { sessionId } : {}),
                data: reason ? { reason } : {},
              },
              { workerId: workerId ?? undefined, sessionId: sessionId ?? undefined }
            );
          },
          enqueueMessage: async ({ workerId, sessionId, text }) => {
            const resolvedTarget = resolveMessageSessionId({
              workerId,
              sessionId,
              resolveWorkerId: resolveSessionIdForWorkerId,
            });
            if (!resolvedTarget.sessionId) {
              if (workerId?.trim()) {
                throw new Error("Unable to resolve session for workerId; worker is not active");
              }
              throw new Error("Provide sessionId or an active workerId");
            }

            const resolvedSessionId = resolvedTarget.sessionId;

            const payload = activeSessionTasks.get(resolvedSessionId);
            const id = await queueNudge(resolvedSessionId, text, {
              repo: payload?.task.repo,
              taskRef: payload?.task.issue,
              taskPath: payload?.task._path,
            });

            const preview = buildNudgePreview(text);
            publishDashboardEvent(
              {
                type: "message.queued",
                level: "info",
                ...(payload?.workerId ? { workerId: payload.workerId } : {}),
                ...(payload?.task.repo ? { repo: payload.task.repo } : {}),
                ...(payload?.taskId ? { taskId: payload.taskId } : {}),
                sessionId: resolvedSessionId,
                data: { id, len: preview.len, preview: preview.preview },
              },
              { sessionId: resolvedSessionId, workerId: payload?.workerId }
            );

            publishDashboardEvent(
              {
                type: "log.ralph",
                level: "info",
                ...(payload?.workerId ? { workerId: payload.workerId } : {}),
                ...(payload?.task.repo ? { repo: payload.task.repo } : {}),
                ...(payload?.taskId ? { taskId: payload.taskId } : {}),
                sessionId: resolvedSessionId,
                data: { message: `Queued nudge ${id}` },
              },
              { sessionId: resolvedSessionId, workerId: payload?.workerId }
            );

            return { id };
          },
          setTaskPriority: async ({ taskId, priority }) => {
            const normalized = normalizeTaskPriority(priority);
            const raw = taskId.startsWith("github:") ? taskId.slice("github:".length) : taskId;
            const issueRef = parseIssueRef(raw, "");

            if (issueRef) {
              const token = await resolveGitHubToken();
              if (!token) throw new Error("GitHub auth is not configured");

              const github = new GitHubClient(issueRef.repo, { getToken: resolveGitHubToken });
              const canonicalLabel = normalizePriorityInputToRalphPriorityLabel(priority);
              const labelPlan = planRalphPriorityLabelSet(canonicalLabel);

              const ops = planIssueLabelOps({
                add: labelPlan.add,
                remove: labelPlan.remove,
              });

              const result = await executeIssueLabelOps({
                github,
                repo: issueRef.repo,
                issueNumber: issueRef.number,
                ops,
                ensureLabels: async () => await ensureRalphWorkflowLabelsOnce({ repo: issueRef.repo, github }),
                ensureBefore: true,
                retryMissingLabelOnce: true,
              });

              if (!result.ok) {
                const message = result.error instanceof Error ? result.error.message : String(result.error);
                throw new Error(`Failed to update issue priority: ${message}`);
              }

              publishDashboardEvent({
                type: "log.ralph",
                level: "info",
                repo: issueRef.repo,
                taskId,
                data: { message: `Set priority ${canonicalLabel} on ${issueRef.repo}#${issueRef.number}` },
              });

              return;
            }

            const task = await getTaskByPath(taskId);
            if (!task) {
              throw new Error(`Unknown taskId: ${taskId}`);
            }

            const updated = await updateTaskStatus(task, task.status, { priority: normalized });
            if (!updated) {
              throw new Error(`Failed to update task priority for ${taskId}`);
            }

            publishDashboardEvent({
              type: "log.ralph",
              level: "info",
              repo: task.repo,
              taskId,
              sessionId: task["session-id"],
              data: { message: `Set priority ${normalized} for ${taskId}` },
            });
          },
        },
      });
      console.log(`${"[ralph:control-plane]"} Listening on ${controlPlaneServer.url}`);
    }
  }

  githubIssuePollers = startGitHubIssuePollers({
    repos: config.repos,
    baseIntervalMs: config.pollInterval,
    log: (message) => console.log(message),
    onSync: ({ repo, result }) => {
      if (isShuttingDown || queueState.backend !== "github") return;
      const repoConfig = config.repos.find((entry) => entry.name === repo);
      if (repoConfig && autoQueueRunner) {
        autoQueueRunner.schedule(repoConfig, "sync");
      }
      maybeExitIfAllReposUnschedulableDueToLegacyLabels(config.repos.map((entry) => entry.name));
      if (!result.hadChanges) return;
      scheduleQueuedTasksSoon();
    },
  });

  if (queueState.backend === "github") {
    for (const repo of config.repos) {
      autoQueueRunner?.schedule(repo, "startup");
    }
  }

  githubDoneReconciler = startGitHubDoneReconciler({
    repos: config.repos,
    baseIntervalMs: config.doneReconcileIntervalMs,
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  });

  if (queueState.backend === "github") {
    githubLabelReconciler = startGitHubLabelReconciler({
      intervalMs: config.labelReconcileIntervalMs,
      log: (message) => console.log(message),
    });

    githubCmdProcessor = startGitHubCmdProcessor({
      log: (message) => console.log(message),
    });
  }

  publishDashboardEvent({
    type: "daemon.started",
    level: "info",
    data: {},
  });

  publishDashboardEvent({
    type: "log.ralph",
    level: "info",
    data: { message: "Daemon started" },
  });

  console.log("[ralph] Configuration:");
  const backendTags = [
    queueState.health === "degraded" ? "degraded" : null,
    queueState.fallback ? "fallback" : null,
  ].filter(Boolean);
  const backendSuffix = backendTags.length > 0 ? ` (${backendTags.join(", ")})` : "";

  console.log(`        Queue backend: ${queueState.backend}${backendSuffix}`);
  if (queueState.diagnostics) {
    console.log(`        Queue diagnostics: ${queueState.diagnostics}`);
  }
  console.log(`        Max workers: ${config.maxWorkers}`);
  console.log(`        Batch size: ${config.batchSize} PRs before rollup`);
  console.log(`        Dev directory: ${config.devDir}`);
  console.log(`        Daemon ID: ${daemonId}`);
  console.log(`        Ownership TTL: ${config.ownershipTtlMs}ms`);
  console.log("");

  // Start drain monitor (operator control file)
  drainMonitor = new DrainMonitor({
    log: (message) => console.log(message),
    defaults: config.control,
    onStateChange: (state) => {
      applyControlState(state);
    },
    onModeChange: (mode) => {
      if (isShuttingDown) return;
      if (mode !== "running") return;

      void (async () => {
        const tasks = await getRunnableTasks();
        await processNewTasks(tasks, config.control ?? {});
      })();
    },
  });
  drainMonitor.start();
  applyControlState(drainMonitor.getState());

  // Initialize rollup monitor
  rollupMonitor = new RollupMonitor(config.batchSize);

  if (queueState.backend === "github") {
    console.log("[ralph] Running initial poll...");
    const initialTasks = await getRunnableTasks();
    console.log(`[ralph] Found ${initialTasks.length} runnable task(s) (queued + starting)`);

    if (initialTasks.length > 0 && getDaemonMode(config.control) !== "draining") {
      await processNewTasks(initialTasks, config.control ?? {});
    } else {
      resetIdleState(initialTasks);
    }

    console.log("[ralph] Starting queue watcher...");
    startWatching(async (tasks) => {
      if (!isShuttingDown && getDaemonMode(config.control) !== "draining") {
        await processNewTasks(tasks, config.control ?? {});
      }
    });

    void resumeTasksOnStartup({ awaitCompletion: false });
  } else {
    const detail = queueState.diagnostics ? ` ${queueState.diagnostics}` : "";
    console.log(`[ralph] Queue backend disabled; running without queued tasks.${detail}`);
    resetIdleState([]);
  }

  const escalationConsultantScheduler = createEscalationConsultantScheduler({
    getEscalationsByStatus,
    getVaultPath: () => null,
    isShuttingDown: () => isShuttingDown,
    allowModelSend: async () => {
      const requestedProfile = getRequestedOpencodeProfileName(null);
      const selection = await resolveOpencodeProfileForNewWork(Date.now(), requestedProfile);
      const gate = computeDaemonGate({ mode: getDaemonMode(config.control), throttle: selection.decision, isShuttingDown });
      return gate.allowModelSend;
    },
    repoPath: () => ".",
    editEscalation,
    getTaskByPath,
    updateTaskStatus,
    log: (message) => console.log(message),
  });
  void escalationConsultantScheduler.tick();
  const escalationConsultantTimer = setInterval(() => {
    escalationConsultantScheduler.tick().catch(() => {
      // ignore
    });
  }, ESCALATION_CONSULTANT_INTERVAL_MS);

  const ownershipTtlMs = getConfig().ownershipTtlMs;
  const heartbeatIntervalMs = computeHeartbeatIntervalMs(ownershipTtlMs);
  let heartbeatInFlight = false;

  const heartbeatTimer = setInterval(() => {
    if (isShuttingDown) return;

    // Avoid unnecessary ownership checks when idle.
    if (inFlightTasks.size === 0 && ownedTasks.size === 0) return;

    // Avoid overlapping ticks if queue/status IO is slow.
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;

    Promise.all([printHeartbeatTick(), refreshTaskOwnershipHeartbeat(Date.now())])
      .catch(() => {
        // ignore
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatIntervalMs);

  let idleRollupInFlight = false;
  const idleRollupTimer = setInterval(() => {
    if (isShuttingDown) return;
    if (idleRollupInFlight) return;
    idleRollupInFlight = true;

    checkIdleRollups()
      .catch(() => {
        // ignore
      })
      .finally(() => {
        idleRollupInFlight = false;
      });
  }, IDLE_ROLLUP_CHECK_MS);

  const throttleResumeIntervalMs = 15_000;
  let throttleResumeInFlight = false;

  const throttleResumeTimer = setInterval(() => {
    if (isShuttingDown) return;
    if (getDaemonMode(config.control) === "draining") return;
    if (throttleResumeInFlight) return;
    throttleResumeInFlight = true;

    attemptResumeThrottledTasks(config.control ?? {})
      .catch(() => {
        // ignore
      })
      .finally(() => {
        throttleResumeInFlight = false;
      });
  }, throttleResumeIntervalMs);

  console.log("");
  console.log("[ralph] Daemon running. Watching for queue changes...");
  console.log("[ralph] Press Ctrl+C to stop.");
  console.log("");
  
  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log("");
    console.log(`[ralph] Received ${signal}, shutting down...`);
    
    // Stop accepting new tasks
    stopWatching();
    githubIssuePollers?.stop();
    githubIssuePollers = null;
    githubDoneReconciler?.stop();
    githubDoneReconciler = null;
    githubLabelReconciler?.stop();
    githubLabelReconciler = null;
    githubCmdProcessor?.stop();
    githubCmdProcessor = null;
    schedulerController.clearTimers();
    drainMonitor?.stop();
    clearInterval(heartbeatTimer);
    clearInterval(idleRollupTimer);
    clearInterval(throttleResumeTimer);
    controlPlaneServer?.stop();
    
    // Terminate in-flight OpenCode runs spawned by Ralph.
    const termination = await terminateOpencodeRuns({ graceMs: 5000 });
    if (termination.total > 0) {
      const suffix = termination.remaining > 0 ? ` (${termination.remaining} required SIGKILL)` : "";
      console.log(`[ralph] Terminated ${termination.total} OpenCode run(s)${suffix}.`);
    }

    // Wait for in-flight tasks
    if (inFlightTasks.size > 0) {
      console.log(`[ralph] Waiting for ${inFlightTasks.size} in-flight task(s)...`);
      
      // Give tasks up to 60 seconds to complete
      const deadline = Date.now() + 60000;
      while (inFlightTasks.size > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (inFlightTasks.size > 0) {
        console.log(`[ralph] ${inFlightTasks.size} task(s) still running after timeout`);
      }
    }
    
    // Check if any repos need a forced rollup
    const status = rollupMonitor.getStatus();
    for (const [repo, { count }] of status) {
      if (count > 0) {
        console.log(`[ralph] ${count} unrolled PR(s) for ${repo}`);
      }
    }
    
    publishDashboardEvent({
      type: "daemon.stopped",
      level: "info",
      data: { reason: signal },
    });

    publishDashboardEvent({
      type: "log.ralph",
      level: "info",
      data: { message: `Daemon stopping (${signal})` },
    });

    if (dashboardEventPersistence) {
      const { flushed } = await dashboardEventPersistence.flush({ timeoutMs: 5000 });
      if (!flushed) {
        console.warn("[ralph] Dashboard event flush timed out; some tail events may be missing");
      }
      dashboardEventPersistence.unsubscribe();
    }

    try {
      removeDaemonRecord();
    } catch {
      // ignore
    }

    console.log("[ralph] Goodbye!");
    process.exit(0);
  };
  
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// --- CLI Commands ---

function printGlobalHelp(): void {
  console.log(
    [
      "Ralph Loop (ralph)",
      "",
      "Usage:",
      "  ralph                              Run daemon (default)",
      "  ralph resume                       Resume orphaned in-progress tasks, then exit",
      "  ralph status [--json]              Show daemon/task status",
      "  ralph runs top|show ...             List expensive runs + trace pointers",
      "  ralph gates <repo> <issue> [--json] Show deterministic gate state",
      "  ralph usage [--json] [--profile]   Show OpenAI usage meters (by profile)",
      "  ralph github-usage [--since 24h]   Summarize GitHub API request telemetry",
      "  ralph repos [--json]               List accessible repos (GitHub App installation)",
      "  ralph queue release --repo <owner/repo> --issue <n>  Release a stuck task slot locally",
      "  ralph watch                        Stream status updates (Ctrl+C to stop)",
      "  ralph nudge <taskRef> \"<message>\"    Queue an operator message for an in-flight task",
      "  ralph sandbox <tag|teardown|prune> Sandbox repo lifecycle helpers",
      "  ralph sandbox:init [--no-seed]      Provision a sandbox repo from template",
      "  ralph sandbox:seed [--run-id <id>]  Seed a sandbox repo from manifest",
      "  ralph sandbox <tag|teardown|prune> Sandbox repo lifecycle helpers",
      "  ralph sandbox:init [--no-seed]      Provision a sandbox repo from template",
      "  ralph sandbox:seed [--run-id <id>]  Seed a sandbox repo from manifest",
      "  ralph worktrees legacy ...         Manage legacy worktrees",
      "  ralph rollup <repo>                (stub) Rollup helpers",
      "  ralph sandbox seed                 Seed sandbox edge-case issues",
      "",
      "Options:",
      "  -h, --help                         Show help (also: ralph help [command])",
      "",
      "Notes:",
      "  Control file: set version=1 and mode=running|draining|paused in $XDG_STATE_HOME/ralph/control.json (fallback ~/.local/state/ralph/control.json; last resort /tmp/ralph/<uid>/control.json).",
      "  OpenCode profile: set [opencode].defaultProfile in ~/.ralph/config.toml (affects new tasks).",
      "  Reload control file immediately with SIGUSR1 (otherwise polled ~1s).",
    ].join("\n")
  );
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "resume":
      console.log(
        [
          "Usage:",
          "  ralph resume",
          "",
          "Resumes any orphaned in-progress tasks (after a daemon restart) and exits.",
        ].join("\n")
      );
      return;

    case "status":
      console.log(
        [
          "Usage:",
          "  ralph status [--json]",
          "",
          "Shows daemon mode plus starting, queued, in-progress, and throttled tasks, plus pending escalations.",
          "",
          "Options:",
          "  --json    Emit machine-readable JSON output.",
        ].join("\n")
      );
      return;

    case "runs":
      console.log(
        [
          "Usage:",
          "  ralph runs top [--since 7d] [--until <iso|ms|now>] [--limit N] [--sort tokens_total|triage_score] [--include-missing] [--all] [--json]",
          "  ralph runs show <runId> [--json]",
          "",
          "Lists top runs by tokens or triage score and links to trace artifacts.",
        ].join("\n")
      );
      return;

    case "gates":
      console.log(
        [
          "Usage:",
          "  ralph gates <repo> <issueNumber> [--json]",
          "",
          "Shows the latest deterministic gate state for an issue.",
          "",
          "Options:",
          "  --json    Emit machine-readable JSON output.",
        ].join("\n")
      );
      return;

    case "repos":
      console.log(
        [
          "Usage:",
          "  ralph repos [--json]",
          "",
          "Lists repositories accessible to the configured GitHub App installation.",
          "Output is filtered to allowed owners (guardrail).",
          "",
          "Options:",
          "  --json    Emit machine-readable JSON output.",
        ].join("\n")
      );
      return;

    case "usage":
      console.log(
        [
          "Usage:",
          "  ralph usage [--json] [--profile <name|auto>]",
          "",
          "Prints OpenAI usage meters (5h + weekly) that drive throttling and auto profile selection.",
          "",
          "Options:",
          "  --json                 Emit machine-readable JSON output.",
          "  --profile <name|auto>  Override the control/default profile for this command.",
        ].join("\n")
      );
      return;

    case "github-usage":
      console.log(
        [
          "Usage:",
          "  ralph github-usage [--since 24h] [--until <iso|ms>] [--date YYYY-MM-DD] [--limit N] [--json] [--events-dir <path>]",
          "",
          "Summarizes GitHubClient per-request telemetry from ~/.ralph/events/*.jsonl.",
          "",
          "Options:",
          "  --since <duration|iso|ms>   Lookback window (default: 24h) or absolute timestamp.",
          "  --until <iso|ms>            Range end (default: now).",
          "  --date YYYY-MM-DD           Analyze a single UTC day (overrides --since/--until).",
          "  --limit N                   Number of top endpoints to show (default: 20).",
          "  --json                      Emit machine-readable JSON output.",
          "  --events-dir <path>         Override events dir (default: ~/.ralph/events).",
        ].join("\n")
      );
      return;

    case "watch":
      console.log(
        [
          "Usage:",
          "  ralph watch",
          "",
          "Prints a line whenever an in-progress task's status changes.",
        ].join("\n")
      );
      return;

    case "nudge":
      console.log(
        [
          "Usage:",
          "  ralph nudge <taskRef> \"<message>\"",
          "",
          "Queues an operator message and delivers it at the next safe checkpoint (between continueSession runs).",
          "taskRef can be a task path, name, or a substring (must match exactly one in-progress task).",
        ].join("\n")
      );
      return;

    case "sandbox:init":
      console.log(
        [
          "Usage:",
          "  ralph sandbox:init [--no-seed]",
          "",
          "Creates a new sandbox repo from the configured template and writes a manifest.",
          "Runs seeding unless --no-seed is provided.",
        ].join("\n")
      );
      return;

    case "sandbox:seed":
      console.log(
        [
          "Usage:",
          "  ralph sandbox:seed [--run-id <id>]",
          "",
          "Seeds a sandbox repo based on the manifest (defaults to newest manifest if omitted).",
        ].join("\n")
      );
      return;

    case "rollup":
      console.log(
        [
          "Usage:",
          "  ralph rollup <repo>",
          "",
          "Rollup helpers. (Currently prints guidance; rollup is typically done via gh.)",
        ].join("\n")
      );
      return;

    case "sandbox":
      console.log(
        [
          "Usage:",
          "  ralph sandbox <tag|teardown|prune> [options]",
          "",
          "Sandbox repo lifecycle helpers.",
        ].join("\n")
      );
      return;

    case "worktrees":
      console.log(
        [
          "Usage:",
          "  ralph worktrees legacy --repo <owner/repo> --action <cleanup|migrate> [--dry-run]",
          "",
          "Manages legacy worktrees created under devDir (e.g. ~/Developer/worktree-<n>).",
        ].join("\n")
      );
      return;

    case "queue":
      console.log(
        [
          "Usage:",
          "  ralph queue release --repo <owner/repo> --issue <n>",
          "",
          "Releases a stuck task slot locally (no GitHub writes).",
        ].join("\n")
      );
      return;

    case "sandbox":
      console.log(
        [
          "Usage:",
          "  ralph sandbox seed --repo <owner/repo> [options]",
          "",
          "Seeds a sandbox repo with deterministic edge-case issues and relationships.",
        ].join("\n")
      );
      return;

    default:
      printGlobalHelp();
      return;
  }
}

function getWindow(snapshot: any, name: string): any | null {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  return windows.find((w: any) => w && typeof w === "object" && w.name === name) ?? null;
}

function formatPct(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatResetAt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  return value;
}

const args = process.argv.slice(2);
const cmd = args[0];

const hasHelpFlag = args.includes("-h") || args.includes("--help");

// Global help: `ralph --help` / `ralph -h` / `ralph help [command]`
if (cmd === "help") {
  const target = args[1];
  if (!target || target.startsWith("-")) printGlobalHelp();
  else printCommandHelp(target);
  process.exit(0);
}

if (!cmd || cmd.startsWith("-")) {
  if (hasHelpFlag) {
    printGlobalHelp();
    process.exit(0);
  }
}

if (args[0] === "resume") {
  if (hasHelpFlag) {
    printCommandHelp("resume");
    process.exit(0);
  }

  // Resume any orphaned in-progress tasks and exit
  resumeSchedulingMode = "resume-only";
  await resumeTasksOnStartup({ schedulingMode: "resume-only" });
  process.exit(0);
}

if (args[0] === "queue") {
  if (hasHelpFlag || args[1] !== "release") {
    printCommandHelp("queue");
    process.exit(0);
  }

  const repoFlagIdx = args.findIndex((arg: string) => arg === "--repo");
  const issueFlagIdx = args.findIndex((arg: string) => arg === "--issue");
  const repo = repoFlagIdx >= 0 ? (args[repoFlagIdx + 1]?.trim() ?? "") : "";
  const issueRaw = issueFlagIdx >= 0 ? (args[issueFlagIdx + 1]?.trim() ?? "") : "";
  const issueNumber = Number.parseInt(issueRaw, 10);

  if (!repo || !Number.isFinite(issueNumber)) {
    console.error("Usage: ralph queue release --repo <owner/repo> --issue <n>");
    process.exit(1);
  }

  initStateDb();
  const ok = releaseTaskSlot({
    repo,
    issueNumber,
    taskPath: `github:${repo}#${issueNumber}`,
    releasedReason: "operator-release",
    status: "queued",
  });
  if (!ok) {
    console.error(`[ralph] Failed to release slot for ${repo}#${issueNumber}`);
    process.exit(1);
  }
  console.log(`[ralph] Released slot for ${repo}#${issueNumber}`);
  process.exit(0);
}

if (args[0] === "status") {
  if (hasHelpFlag) {
    printCommandHelp("status");
    process.exit(0);
  }

  const statusControl = readControlStateSnapshot({ log: (message) => console.warn(message), defaults: getConfig().control });

  await runStatusCommand({
    args,
    drain: {
      requestedAt: drainRequestedAt,
      timeoutMs: drainTimeoutMs ?? statusControl.drainTimeoutMs ?? null,
      pauseRequested: pauseRequestedByControl || statusControl.pauseRequested === true,
      pauseAtCheckpoint: pauseAtCheckpoint ?? statusControl.pauseAtCheckpoint ?? null,
    },
  });
  process.exit(0);
}

if (args[0] === "runs") {
  if (hasHelpFlag) {
    printCommandHelp("runs");
    process.exit(0);
  }

  await runRunsCommand({ args });
  process.exit(0);
}

if (args[0] === "gates") {
  if (hasHelpFlag) {
    printCommandHelp("gates");
    process.exit(0);
  }

  await runGatesCommand({ args });
  process.exit(0);
}

if (args[0] === "usage") {
  if (hasHelpFlag) {
    printCommandHelp("usage");
    process.exit(0);
  }

  const json = args.includes("--json");
  const profileFlagIdx = args.findIndex((a) => a === "--profile");
  const profileOverride = profileFlagIdx >= 0 ? (args[profileFlagIdx + 1]?.trim() ?? "") : "";

  const now = Date.now();
  const config = getConfig();
  const requestedProfile = profileOverride || getRequestedOpencodeProfileName(null);

  const selection = await resolveOpencodeProfileForNewWork(now, requestedProfile);
  const chosenProfile = selection.profileName;

  const profileNames = listOpencodeProfileNames();
  const targets = profileNames.length > 0 ? profileNames : ["ambient"];

  const decisions = await Promise.all(
    targets.map(async (name) => {
      const opencodeProfile = name === "ambient" ? null : name;
      const decision = await getThrottleDecision(now, { opencodeProfile });
      return { name, opencodeProfile, decision };
    })
  );

  const toUsedPct = (w: any): number | null => {
    if (!w || typeof w !== "object") return null;
    if (typeof w.usedPct === "number" && Number.isFinite(w.usedPct)) return w.usedPct;
    if (
      typeof w.usedTokens === "number" &&
      Number.isFinite(w.usedTokens) &&
      typeof w.budgetTokens === "number" &&
      Number.isFinite(w.budgetTokens) &&
      w.budgetTokens > 0
    ) {
      return w.usedTokens / w.budgetTokens;
    }
    return null;
  };

  const toResetIso = (ts: unknown): string | null => {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
    return new Date(ts).toISOString();
  };

  const rows = decisions.map(({ name, decision }) => {
    const snap: any = decision.snapshot;
    const rolling = getWindow(snap, "rolling5h");
    const weekly = getWindow(snap, "weekly");

    const rollingUsed = toUsedPct(rolling);
    const weeklyUsed = toUsedPct(weekly);

    const rollingResetAt =
      typeof snap?.remoteUsage?.rolling5h?.resetAt === "string"
        ? snap.remoteUsage.rolling5h.resetAt
        : null;
    const weeklyResetAt =
      typeof snap?.remoteUsage?.weekly?.resetAt === "string"
        ? snap.remoteUsage.weekly.resetAt
        : toResetIso(weekly?.weeklyNextResetTs) ?? toResetIso(weekly?.windowEndTs);

    return {
      profile: name,
      chosen: chosenProfile ? name === chosenProfile : name === "ambient",
      state: decision.state,
      openaiSource: snap?.openaiSource ?? "remoteUsage",
      rollingUsedPct: rollingUsed,
      weeklyUsedPct: weeklyUsed,
      rollingResetAt,
      weeklyResetAt,
    };
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          computedAt: new Date(now).toISOString(),
          requestedProfile,
          selection,
          profiles: rows.map((r) => ({
            profile: r.profile,
            chosen: r.chosen,
            state: r.state,
            openaiSource: r.openaiSource,
            rolling5h: {
              usedPct: r.rollingUsedPct,
              remainingPct: typeof r.rollingUsedPct === "number" ? 1 - r.rollingUsedPct : null,
              resetAt: r.rollingResetAt,
            },
            weekly: {
              usedPct: r.weeklyUsedPct,
              remainingPct: typeof r.weeklyUsedPct === "number" ? 1 - r.weeklyUsedPct : null,
              resetAt: r.weeklyResetAt,
            },
          })),
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const header = [
    "PROFILE",
    "CHOSEN",
    "STATE",
    "SOURCE",
    "5H_USED",
    "5H_LEFT",
    "5H_RESET",
    "WEEK_USED",
    "WEEK_LEFT",
    "WEEK_RESET",
  ];

  const fmt = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s.padEnd(w));
  const widths = [12, 7, 6, 10, 8, 8, 20, 10, 10, 20];

  console.log(header.map((h, i) => fmt(h, widths[i]!)).join(" "));
  console.log(widths.map((w) => "-".repeat(w)).join(" "));

  for (const r of rows) {
    const rollingLeft = typeof r.rollingUsedPct === "number" ? 1 - r.rollingUsedPct : null;
    const weeklyLeft = typeof r.weeklyUsedPct === "number" ? 1 - r.weeklyUsedPct : null;

    const line = [
      r.profile,
      r.chosen ? "*" : "",
      r.state,
      r.openaiSource,
      formatPct(r.rollingUsedPct),
      formatPct(rollingLeft),
      formatResetAt(r.rollingResetAt),
      formatPct(r.weeklyUsedPct),
      formatPct(weeklyLeft),
      formatResetAt(r.weeklyResetAt),
    ];
    console.log(line.map((v, i) => fmt(v, widths[i]!)).join(" "));
  }

  process.exit(0);
}

if (args[0] === "sandbox:init") {
  if (hasHelpFlag) {
    printCommandHelp("sandbox:init");
    process.exit(0);
  }

  const sandbox = getSandboxProfileConfig();
  if (!sandbox) {
    console.error("[ralph:sandbox] sandbox:init requires profile=\"sandbox\" with a sandbox config block.");
    process.exit(1);
  }

  const owner = getConfig().owner;
  const ownerAllowed = sandbox.allowedOwners.some((allowed) => allowed.toLowerCase() === owner.toLowerCase());
  if (!ownerAllowed) {
    console.error(`[ralph:sandbox] sandbox:init owner ${owner} is not in sandbox.allowedOwners.`);
    process.exit(1);
  }

  const provisioning = getSandboxProvisioningConfig();
  if (!provisioning) {
    console.error("[ralph:sandbox] sandbox:init requires sandbox.provisioning config.");
    process.exit(1);
  }

  const noSeed = args.includes("--no-seed");
  const runId = `sandbox-${crypto.randomUUID()}`;

  const plan = buildProvisionPlan({
    runId,
    owner,
    botBranch: "bot/integration",
    sandbox,
    provisioning: {
      templateRepo: provisioning.templateRepo,
      templateRef: provisioning.templateRef ?? "main",
      repoVisibility: "private",
      settingsPreset: provisioning.settingsPreset ?? "minimal",
      seed: provisioning.seed,
    },
  });

  let manifest = await executeProvisionPlan(plan);
  if (!noSeed && plan.seed) {
    const seedSpec = plan.seed.preset === "baseline"
      ? getBaselineSeedSpec()
      : plan.seed.file
        ? await loadSeedSpecFromFile(plan.seed.file)
        : null;

    if (!seedSpec) {
      console.error("[ralph:sandbox] No seed spec resolved; pass --no-seed to skip.");
      process.exit(1);
    }

    manifest = await applySeedFromSpec({
      repoFullName: plan.repoFullName,
      manifest,
      seedSpec,
      seedConfig: {
        preset: plan.seed.preset,
        file: plan.seed.file,
      },
    });
    await writeSandboxManifest(getRalphSandboxManifestPath(plan.runId), manifest);
  }

  console.log(`[ralph:sandbox] Provisioned ${plan.repoFullName}`);
  console.log(`[ralph:sandbox] Manifest: ${getRalphSandboxManifestPath(plan.runId)}`);
  process.exit(0);
}

if (args[0] === "sandbox:seed") {
  if (hasHelpFlag) {
    printCommandHelp("sandbox:seed");
    process.exit(0);
  }

  const sandbox = getSandboxProfileConfig();
  if (!sandbox) {
    console.error("[ralph:sandbox] sandbox:seed requires profile=\"sandbox\" with a sandbox config block.");
    process.exit(1);
  }

  const provisioning = getSandboxProvisioningConfig();

  const runIdFlag = args.findIndex((arg) => arg === "--run-id");
  const runId = runIdFlag >= 0 ? args[runIdFlag + 1] : null;
  if (runIdFlag >= 0 && (!runId || runId.startsWith("-"))) {
    console.error("[ralph:sandbox] --run-id requires a value.");
    process.exit(1);
  }
  let manifestPath = runId ? getRalphSandboxManifestPath(runId) : null;

  if (!manifestPath) {
    manifestPath = await findLatestManifestPath(getRalphSandboxManifestsDir());
  }

  if (!manifestPath) {
    console.error("[ralph:sandbox] No manifest found. Provide --run-id or run sandbox:init.");
    process.exit(1);
  }

  const manifest = await readManifestOrNull(manifestPath);
  if (!manifest) {
    console.error(`[ralph:sandbox] Failed to load manifest: ${manifestPath}`);
    process.exit(1);
  }

  const seedFile = manifest.seed?.file ?? provisioning?.seed?.file;
  const seedPreset = manifest.seed?.preset ?? provisioning?.seed?.preset;

  let seedSpec: any = null;
  if (seedFile) {
    seedSpec = await loadSeedSpecFromFile(seedFile);
  } else if (seedPreset === "baseline") {
    seedSpec = getBaselineSeedSpec();
  }

  if (!seedSpec) {
    console.error("[ralph:sandbox] No seed spec resolved. Configure sandbox.provisioning.seed or update the manifest.");
    process.exit(1);
  }

  const updated = await applySeedFromSpec({
    repoFullName: manifest.repo.fullName,
    manifest,
    seedSpec,
    seedConfig: {
      preset: seedPreset,
      file: seedFile,
    },
  });
  await writeSandboxManifest(manifestPath, updated);

  console.log(`[ralph:sandbox] Seeded ${manifest.repo.fullName}`);
  console.log(`[ralph:sandbox] Manifest: ${manifestPath}`);
  process.exit(0);
}

if (args[0] === "github-usage") {
  if (hasHelpFlag) {
    printCommandHelp("github-usage");
    process.exit(0);
  }

  await runGithubUsageCommand({ args });
  process.exit(0);
}

if (args[0] === "repos") {
  if (hasHelpFlag) {
    printCommandHelp("repos");
    process.exit(0);
  }

  const json = args.includes("--json");

  try {
    const repos = filterReposToAllowedOwners(await listAccessibleRepos());

    if (json) {
      console.log(JSON.stringify(repos, null, 2));
      process.exit(0);
    }

    for (const repo of repos) {
      console.log(repo.fullName);
    }

    process.exit(0);
  } catch (e: any) {
    console.error(`[ralph] Failed to list accessible repos: ${e?.message ?? String(e)}`);
    process.exit(1);
  }
}

if (args[0] === "nudge") {
  if (hasHelpFlag) {
    printCommandHelp("nudge");
    process.exit(0);
  }

  const taskRefRaw = args[1];
  const messageRaw = args.slice(2).join(" ").trim();

  if (!taskRefRaw || !messageRaw) {
    console.error("Usage: ralph nudge <taskRef> \"<message>\"");
    process.exit(1);
  }

  const taskRef = taskRefRaw;
  const message = messageRaw;

  const tasks = await getTasksByStatus("in-progress");
  if (tasks.length === 0) {
    console.error("No in-progress tasks found.");
    process.exit(1);
  }

  const exactMatches = tasks.filter((t) => t._path === taskRef || t._name === taskRef || t.name === taskRef);
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : tasks.filter((t) => t.name.toLowerCase().includes(taskRef.toLowerCase()));

  if (matches.length === 0) {
    console.error(`No in-progress task matched '${taskRef}'.`);
    console.error("In-progress tasks:");
    for (const t of tasks) {
      console.error(`  - ${t._path} (${t.name})`);
    }
    process.exit(1);
  }

  if (matches.length > 1) {
    console.error(`Ambiguous task ref '${taskRef}' (${matches.length} matches).`);
    console.error("Matches:");
    for (const t of matches) {
      console.error(`  - ${t._path} (${t.name})`);
    }
    process.exit(1);
  }

  const task = matches[0]!;
  const sessionId = task["session-id"]?.trim() ?? "";
  if (!sessionId) {
    console.error(`Task has no session-id recorded; cannot nudge: ${task._path}`);
    process.exit(1);
  }

  const nudgeId = await queueNudge(sessionId, message, {
    taskRef,
    taskPath: task._path,
    repo: task.repo,
  });

  const lockPath = getRalphSessionLockPath(sessionId);
  if (existsSync(lockPath)) {
    console.log(
      `Queued nudge ${nudgeId} for session ${sessionId}; session is in-flight; will deliver at next checkpoint.`
    );
  } else {
    console.log(`Queued nudge ${nudgeId} for session ${sessionId}; will deliver at next checkpoint.`);
  }

  process.exit(0);
}

if (args[0] === "watch") {
  if (hasHelpFlag) {
    printCommandHelp("watch");
    process.exit(0);
  }

  // GitHub-backed queue queries require the SQLite state DB.
  initStateDb();

  console.log("[ralph] Watching in-progress task status (Ctrl+C to stop)...");

  const lastLines = new Map<string, string>();

  const tick = async () => {
    const tasks = await getTasksByStatus("in-progress");
    const seen = new Set<string>();

    for (const task of tasks) {
      const key = getTaskKey(task);
      seen.add(key);

      const line = await getTaskNowDoingLine(task);
      const prev = lastLines.get(key);
      if (prev !== line) {
        console.log(line);
        lastLines.set(key, line);
      }
    }

    for (const key of Array.from(lastLines.keys())) {
      if (!seen.has(key)) {
        console.log(`${key} — no longer in-progress`);
        lastLines.delete(key);
      }
    }
  };

  await tick();

  const timer = setInterval(() => {
    tick().catch(() => {
      // ignore
    });
  }, 1000);

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive.
  await new Promise(() => {
    // intentional
  });
}

if (args[0] === "rollup") {
  if (hasHelpFlag) {
    printCommandHelp("rollup");
    process.exit(0);
  }

  // Force rollup for a repo
  const repo = args[1];
  if (!repo) {
    console.error("Usage: ralph rollup <repo>");
    process.exit(1);
  }

  const monitor = new RollupMonitor();
  // Note: This won't work well since we don't persist merge counts
  // For now, just create a PR from current bot/integration state
  console.log(`Force rollup not yet implemented. Use 'gh pr create --base main --head bot/integration' manually.`);
  process.exit(0);
}

if (args[0] === "worktrees") {
  if (hasHelpFlag) {
    printCommandHelp("worktrees");
    process.exit(0);
  }

  await runWorktreesCommand(args);
  process.exit(0);
}

if (args[0] === "sandbox") {
  if (hasHelpFlag || args[1] === "help") {
    printCommandHelp("sandbox");
    process.exit(0);
  }

  if (args[1] === "seed") {
    await runSandboxSeedCommand(args.slice(2));
    process.exit(0);
  }

  await runSandboxCommand(args);
  process.exit(0);
}

// Default: run daemon
main().catch((e) => {
  console.error("[ralph] Fatal error:", e);
  process.exit(1);
});
