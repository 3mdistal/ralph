#!/usr/bin/env bun
/**
 * Ralph Loop - Autonomous Coding Task Orchestrator
 * 
 * Watches the queue backend (GitHub-first, bwrb legacy) for agent-tasks and dispatches them to OpenCode agents.
 * Processes tasks in parallel across repos, sequentially within each repo.
 * Creates rollup PRs after N successful merges for batch review.
 */

import { existsSync, watch } from "fs";
import { join } from "path";
import crypto from "crypto";

import {
  ensureBwrbVaultLayout,
  getConfig,
  getOpencodeDefaultProfileName,
  getRepoMaxWorkers,
  getRepoPath,
  type ControlConfig,
} from "./config";
import { filterReposToAllowedOwners, listAccessibleRepos } from "./github-app-auth";
import {
  getBwrbVaultIfValid,
  getQueueBackendState,
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

import { DrainMonitor, readControlStateSnapshot, type DaemonMode } from "./drain";
import { isRalphCheckpoint, type RalphCheckpoint } from "./dashboard/events";
import { formatDuration, shouldLog } from "./logging";
import { getThrottleDecision, type ThrottleDecision } from "./throttle";
import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "./opencode-auto-profile";
import { formatNowDoingLine, getSessionNowDoing } from "./live-status";
import { getRalphSessionLockPath } from "./paths";
import { computeHeartbeatIntervalMs, parseHeartbeatMs } from "./ownership";
import { initStateDb, recordPrSnapshot } from "./state";
import { queueNudge } from "./nudge";
import { terminateOpencodeRuns } from "./opencode-process-registry";
import { ralphEventBus } from "./dashboard/bus";
import { buildRalphEvent } from "./dashboard/events";
import { startGitHubIssuePollers } from "./github-issues-sync";
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

// --- State ---

const workers = new Map<string, RepoWorker>();
let rollupMonitor: RollupMonitor;
let isShuttingDown = false;
let drainMonitor: DrainMonitor | null = null;
let drainRequestedAt: number | null = null;
let drainTimeoutMs: number | null = null;
let pauseRequestedByControl = false;
let pauseAtCheckpoint: RalphCheckpoint | null = null;
let githubIssuePollers: { stop: () => void } | null = null;

const daemonId = `d_${crypto.randomUUID()}`;

const IDLE_ROLLUP_CHECK_MS = 15_000;
const IDLE_ROLLUP_THRESHOLD_MS = 5 * 60_000;

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

type DaemonGate = {
  allowDequeue: boolean;
  allowResume: boolean;
  allowModelSend: boolean;
  reason: "running" | "draining" | "paused" | "hard-throttled";
};

function computeDaemonGate(opts: {
  mode: DaemonMode;
  throttle: ThrottleDecision;
  isShuttingDown: boolean;
}): DaemonGate {
  if (opts.isShuttingDown) {
    return { allowDequeue: false, allowResume: false, allowModelSend: false, reason: "paused" };
  }
  if (opts.mode === "paused") {
    return { allowDequeue: false, allowResume: false, allowModelSend: false, reason: "paused" };
  }
  if (opts.throttle.state === "hard") {
    return { allowDequeue: false, allowResume: false, allowModelSend: false, reason: "hard-throttled" };
  }
  if (opts.mode === "draining") {
    return { allowDequeue: false, allowResume: true, allowModelSend: true, reason: "draining" };
  }
  if (opts.throttle.state === "soft") {
    return { allowDequeue: false, allowResume: true, allowModelSend: true, reason: "running" };
  }
  return { allowDequeue: true, allowResume: true, allowModelSend: true, reason: "running" };
}

function getActiveOpencodeProfileName(defaults?: Partial<ControlConfig>): string | null {
  const control = drainMonitor
    ? drainMonitor.getState()
    : readControlStateSnapshot({ log: (message) => console.warn(message), defaults });

  const fromControl = control.opencodeProfile?.trim() ?? "";
  if (fromControl) return fromControl;

  return getOpencodeDefaultProfileName();
}

async function resolveEffectiveOpencodeProfileNameForNewTasks(
  now: number,
  defaults?: Partial<ControlConfig>
): Promise<string | null> {
  const requested = getActiveOpencodeProfileName(defaults);
  const resolved = await resolveOpencodeProfileForNewWork(now, requested);
  return resolved.profileName;
}

function getTaskOpencodeProfileName(task: Pick<AgentTask, "opencode-profile">): string | null {
  const raw = task["opencode-profile"];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
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

function requireBwrbQueueOrExit(action: string): void {
  const state = getQueueBackendState();
  if (state.backend === "bwrb" && state.health === "ok") {
    if (!ensureBwrbVaultLayout(getConfig().bwrbVault)) process.exit(1);
    return;
  }

  if (state.backend !== "bwrb") {
    console.warn(`[ralph] ${action} requires bwrb queue backend (current: ${state.backend}).`);
    process.exit(1);
  }

  const reason = state.diagnostics ? ` ${state.diagnostics}` : "";
  console.error(`[ralph] bwrb queue backend unavailable.${reason}`);
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
    sem = new Semaphore(getRepoMaxWorkers(repo));
    repoSemaphores.set(repo, sem);
  }
  return sem;
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
  void created.runStartupCleanup();
  return created;
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

let escalationWatcher: ReturnType<typeof watch> | null = null;
let escalationDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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
    getVaultPathForLogs: () => getBwrbVaultIfValid() ?? "<unknown>",

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
        recordPrSnapshot({ repo, issue: "", prUrl, state: "merged" });
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
             recordPrSnapshot({ repo: task.repo, issue: task.issue, prUrl: run.pr, state: "merged" });
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

  try {
    const nowMs = Date.now();
    const claim = await tryClaimTask({ task, daemonId, nowMs });

    if (!claim.claimed || !claim.task) {
      if (claim.reason && shouldLog(`ownership:skip:${task._path}`, 60_000)) {
        console.log(`[ralph] Skipping task ${task.name}: ${claim.reason}`);
      }
      releaseGlobal();
      releaseRepo();
      if (!isShuttingDown) scheduleQueuedTasksSoon();
      return false;
    }

    const claimedTask = claim.task;
    recordOwnedTask(claimedTask);

    const key = getTaskKey(claimedTask);
    inFlightTasks.add(key);

    void getOrCreateWorker(repo)
      .processTask(claimedTask)
      .then(async (run: AgentRun) => {
        if (run.outcome === "success" && run.pr) {
          try {
            recordPrSnapshot({ repo, issue: claimedTask.issue, prUrl: run.pr, state: "merged" });
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
        releaseGlobal();
        releaseRepo();
        if (!isShuttingDown) {
          scheduleQueuedTasksSoon();
          void checkIdleRollups();
        }
      });
    return true;
  } catch (error: any) {
    console.error(`[ralph] Error claiming task ${task.name}:`, error);
    releaseGlobal();
    releaseRepo();
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

  pendingResumeTasks.delete(key);
  inFlightTasks.add(key);

  void getOrCreateWorker(repo)
    .resumeTask(task)
    .then(() => {
      // ignore
    })
    .catch((e: any) => {
      console.error(`[ralph] Error resuming task ${task.name}:`, e);
    })
    .finally(() => {
      inFlightTasks.delete(key);
      forgetOwnedTask(task);
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

  if (queueTasks.length > 0) {
    resetIdleState(queueTasks);
  } else if (!isDraining) {
    resetIdleState(tasks);
  }

  const startedCount = await startQueuedTasks({
    gate: "running",
    tasks: queueTasks,
    priorityTasks: Array.from(pendingResumeTasks.values()),
    inFlightTasks,
    getTaskKey: (t) => getTaskKey(t),
    groupByRepo,
    globalSemaphore,
    getRepoSemaphore,
    rrCursor,
    shouldLog,
    log: (message) => console.log(message),
    startTask,
    startPriorityTask: startResumeTask,
  });

  if (startedCount > 0) {
    console.log(`[ralph] Started ${startedCount} task(s)`);
  }
}

function formatTaskLabel(task: Pick<AgentTask, "name" | "issue" | "repo">): string {
  const issueMatch = task.issue.match(/#(\d+)$/);
  const issueNumber = issueMatch?.[1] ?? "?";
  const repoShort = task.repo.includes("/") ? task.repo.split("/")[1] : task.repo;
  return `${repoShort}#${issueNumber} ${task.name}`;
}

async function getTaskNowDoingLine(task: AgentTask): Promise<string> {
  const sessionId = task["session-id"]?.trim();
  const label = formatTaskLabel(task);

  if (!sessionId) return `${label} — starting session…`;

  const nowDoing = await getSessionNowDoing(sessionId);
  if (!nowDoing) return `${label} — waiting (no events yet)`;

  return formatNowDoingLine(nowDoing, label);
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

    ralphEventBus.publish(
      buildRalphEvent({
        type: "worker.activity.updated",
        level: "info",
        workerId: params.workerId,
        repo: params.task.repo,
        taskId: params.taskId,
        sessionId,
        data: { activity: snapshot.activity },
      })
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

      const limit = getRepoMaxWorkers(repo);
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
  const queueState = getQueueBackendState();

  if (queueState.health === "unavailable") {
    const reason = queueState.diagnostics ? ` ${queueState.diagnostics}` : "";
    console.error(`[ralph] Queue backend ${queueState.backend} unavailable.${reason}`);
    process.exit(1);
  }

  if (queueState.backend === "bwrb") {
    if (!ensureBwrbVaultLayout(config.bwrbVault)) process.exit(1);
  }

  // Initialize durable local state (SQLite)
  initStateDb();

  githubIssuePollers = startGitHubIssuePollers({
    repos: config.repos,
    baseIntervalMs: config.pollInterval,
    log: (message) => console.log(message),
    onSync: ({ result }) => {
      if (!result.hadChanges || isShuttingDown || queueState.backend !== "github") return;
      scheduleQueuedTasksSoon();
    },
  });

  ralphEventBus.publish(
    buildRalphEvent({
      type: "daemon.started",
      level: "info",
      data: {},
    })
  );

  console.log("[ralph] Configuration:");
  const backendTags = [
    queueState.health === "degraded" ? "degraded" : null,
    queueState.fallback ? "fallback" : null,
  ].filter(Boolean);
  const backendSuffix = backendTags.length > 0 ? ` (${backendTags.join(", ")})` : "";

  console.log(`        Queue backend: ${queueState.backend}${backendSuffix}`);
  if (queueState.backend === "bwrb") {
    console.log(`        Vault: ${config.bwrbVault}`);
  }
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

  if (queueState.backend === "bwrb") {
    // Do initial poll on startup
    console.log("[ralph] Running initial poll...");
    const initialTasks = await initialPoll();
    console.log(`[ralph] Found ${initialTasks.length} runnable task(s) (queued + starting)`);

    if (initialTasks.length > 0 && getDaemonMode(config.control) !== "draining") {
      await processNewTasks(initialTasks, config.control ?? {});
    } else {
      resetIdleState(initialTasks);
    }

    // Start file watching (no polling - watcher is reliable)
    console.log("[ralph] Starting queue watcher...");
    startWatching(async (tasks) => {
      if (!isShuttingDown && getDaemonMode(config.control) !== "draining") {
        await processNewTasks(tasks, config.control ?? {});
      }
    });

    // Resume orphaned tasks from previous daemon runs.
    void resumeTasksOnStartup({ awaitCompletion: false });

    // Resume any resolved escalations (HITL checkpoint) from the same session.
    void attemptResumeResolvedEscalations();

    // Resume any tasks paused by hard throttle.
    void attemptResumeThrottledTasks(config.control ?? {});

    // Watch escalations for resolution and resume the same OpenCode session.
    const escalationsDir = join(config.bwrbVault, "orchestration/escalations");
    if (existsSync(escalationsDir)) {
      console.log(`[ralph:escalations] Watching ${escalationsDir} for changes`);

      escalationWatcher = watch(escalationsDir, { recursive: true }, async (_eventType: string, filename: string | null) => {
        if (!filename || !filename.endsWith(".md")) return;

        if (escalationDebounceTimer) clearTimeout(escalationDebounceTimer);
        escalationDebounceTimer = setTimeout(() => {
          attemptResumeResolvedEscalations().catch(() => {
            // ignore
          });
        }, 750);
      });
    } else {
      console.log(`[ralph:escalations] Escalations dir not found: ${escalationsDir}`);
    }
  } else if (queueState.backend === "github") {
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

  const ownershipTtlMs = getConfig().ownershipTtlMs;
  const heartbeatIntervalMs = computeHeartbeatIntervalMs(ownershipTtlMs);
  let heartbeatInFlight = false;

  const heartbeatTimer = setInterval(() => {
    if (isShuttingDown) return;

    // Avoid hitting bwrb repeatedly when the daemon is idle.
    if (inFlightTasks.size === 0 && ownedTasks.size === 0) return;

    // Avoid overlapping ticks if bwrb/filesystem are slow.
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
    if (escalationWatcher) {
      escalationWatcher.close();
      escalationWatcher = null;
    }
    if (escalationDebounceTimer) {
      clearTimeout(escalationDebounceTimer);
      escalationDebounceTimer = null;
    }
    schedulerController.clearTimers();
    drainMonitor?.stop();
    clearInterval(heartbeatTimer);
    clearInterval(idleRollupTimer);
    clearInterval(throttleResumeTimer);
    
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
    
    ralphEventBus.publish(
      buildRalphEvent({
        type: "daemon.stopped",
        level: "info",
        data: { reason: signal },
      })
    );

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
      "  ralph repos [--json]               List accessible repos (GitHub App installation)",
      "  ralph watch                        Stream status updates (Ctrl+C to stop)",
      "  ralph nudge <taskRef> \"<message>\"    Queue an operator message for an in-flight task",
      "  ralph rollup <repo>                (stub) Rollup helpers",
      "",
      "Options:",
      "  -h, --help                         Show help (also: ralph help [command])",
      "",
      "Notes:",
      "  Control file: set version=1 and mode=running|draining|paused in $XDG_STATE_HOME/ralph/control.json (fallback ~/.local/state/ralph/control.json; last resort /tmp/ralph/<uid>/control.json).",
      "  OpenCode profile: set opencode_profile=\"<name>\" in the same control file (affects new tasks).",
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

    default:
      printGlobalHelp();
      return;
  }
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

  requireBwrbQueueOrExit("resume");

  // Resume any orphaned in-progress tasks and exit
  resumeSchedulingMode = "resume-only";
  await resumeTasksOnStartup({ schedulingMode: "resume-only" });
  process.exit(0);
}

if (args[0] === "status") {
  if (hasHelpFlag) {
    printCommandHelp("status");
    process.exit(0);
  }

  const json = args.includes("--json");

  const config = getConfig();
  const queueState = getQueueBackendState();
  const control = readControlStateSnapshot({ log: (message) => console.warn(message), defaults: config.control });
  const controlProfile = control.opencodeProfile?.trim() || "";

  const requestedProfile =
    controlProfile === "auto" ? "auto" : controlProfile || getOpencodeDefaultProfileName() || null;

  const selection = await resolveOpencodeProfileForNewWork(Date.now(), requestedProfile);
  const resolvedProfile: string | null = selection.profileName;
  const throttle = selection.decision;
  const gate = computeDaemonGate({ mode: control.mode, throttle, isShuttingDown: false });

  const mode = gate.reason === "hard-throttled"
    ? "hard-throttled"
    : gate.reason === "paused"
      ? "paused"
      : gate.reason === "draining"
        ? "draining"
        : throttle.state === "soft"
          ? "soft-throttled"
          : "running";

  const [starting, inProgress, queued, throttled, pendingEscalations] = await Promise.all([
    getTasksByStatus("starting"),
    getTasksByStatus("in-progress"),
    getQueuedTasks(),
    getTasksByStatus("throttled"),
    getEscalationsByStatus("pending"),
  ]);

  if (json) {
    const inProgressWithStatus = await Promise.all(
      inProgress.map(async (task) => {
        const sessionId = task["session-id"]?.trim() || null;
        const nowDoing = sessionId ? await getSessionNowDoing(sessionId) : null;
          return {
            name: task.name,
            repo: task.repo,
            issue: task.issue,
            priority: task.priority ?? "p2-medium",
            opencodeProfile: getTaskOpencodeProfileName(task),
            sessionId,
            nowDoing,
            line: sessionId && nowDoing ? formatNowDoingLine(nowDoing, formatTaskLabel(task)) : null,
          };

      })
    );

    console.log(
      JSON.stringify(
        {
          mode,
          queue: {
            backend: queueState.backend,
            health: queueState.health,
            fallback: queueState.fallback,
            diagnostics: queueState.diagnostics ?? null,
          },
          controlProfile: controlProfile || null,
          activeProfile: resolvedProfile ?? null,
          throttle: throttle.snapshot,
          escalations: {
            pending: pendingEscalations.length,
          },
          inProgress: inProgressWithStatus,
          starting: starting.map((t) => ({
            name: t.name,
            repo: t.repo,
            issue: t.issue,
            priority: t.priority ?? "p2-medium",
            opencodeProfile: getTaskOpencodeProfileName(t),
          })),
          drain: {
            requestedAt: drainRequestedAt ? new Date(drainRequestedAt).toISOString() : null,
            timeoutMs: drainTimeoutMs ?? null,
            pauseRequested: pauseRequestedByControl,
            pauseAtCheckpoint,
          },
          queued: queued.map((t) => ({
            name: t.name,
            repo: t.repo,
            issue: t.issue,
            priority: t.priority ?? "p2-medium",
            opencodeProfile: getTaskOpencodeProfileName(t),
          })),
          throttled: throttled.map((t) => ({
            name: t.name,
            repo: t.repo,
            issue: t.issue,
            priority: t.priority ?? "p2-medium",
            opencodeProfile: getTaskOpencodeProfileName(t),
            sessionId: t["session-id"]?.trim() || null,
            resumeAt: t["resume-at"]?.trim() || null,
          })),
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.log(`Mode: ${mode}`);
  const statusTags = [
    queueState.health === "degraded" ? "degraded" : null,
    queueState.fallback ? "fallback" : null,
  ].filter(Boolean);
  const statusSuffix = statusTags.length > 0 ? ` (${statusTags.join(", ")})` : "";
  console.log(`Queue backend: ${queueState.backend}${statusSuffix}`);
  if (queueState.diagnostics) {
    console.log(`Queue diagnostics: ${queueState.diagnostics}`);
  }
  if (pauseRequestedByControl) {
    console.log(`Pause requested: true${pauseAtCheckpoint ? ` (checkpoint: ${pauseAtCheckpoint})` : ""}`);
  }
  if (controlProfile === "auto") {
    console.log(`Active OpenCode profile: auto (resolved: ${resolvedProfile ?? "ambient"})`);
  } else if (selection.source === "failover") {
    console.log(`Active OpenCode profile: ${resolvedProfile ?? "ambient"} (failover from: ${requestedProfile ?? "default"})`);
  } else if (resolvedProfile) {
    console.log(`Active OpenCode profile: ${resolvedProfile}`);
  }

  console.log(`Escalations: ${pendingEscalations.length} pending`);
  console.log(`Starting tasks: ${starting.length}`);
  for (const task of starting) {
    console.log(`  - ${await getTaskNowDoingLine(task)}`);
  }

  console.log(`In-progress tasks: ${inProgress.length}`);
  for (const task of inProgress) {
    console.log(`  - ${await getTaskNowDoingLine(task)}`);
  }

  console.log(`Queued tasks: ${queued.length}`);
  for (const task of queued) {
    console.log(`  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}]`);
  }

  console.log(`Throttled tasks: ${throttled.length}`);
  for (const task of throttled) {
    const resumeAt = task["resume-at"]?.trim() || "unknown";
    console.log(`  - ${task.name} (${task.repo}) resumeAt=${resumeAt} [${task.priority || "p2-medium"}]`);
  }

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

  requireBwrbQueueOrExit("nudge");

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

  requireBwrbQueueOrExit("watch");

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

// Default: run daemon
main().catch((e) => {
  console.error("[ralph] Fatal error:", e);
  process.exit(1);
});
