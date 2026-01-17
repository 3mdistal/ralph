#!/usr/bin/env bun
/**
 * Ralph Loop - Autonomous Coding Task Orchestrator
 * 
 * Watches the bwrb queue for agent-tasks and dispatches them to OpenCode agents.
 * Processes tasks in parallel across repos, sequentially within each repo.
 * Creates rollup PRs after N successful merges for batch review.
 */

import { existsSync, watch } from "fs";
import { join } from "path";

import {
  ensureBwrbVaultLayout,
  getOpencodeDefaultProfileName,
  getRepoMaxWorkers,
  getRepoPath,
  loadConfig,
} from "./config";
import { filterReposToAllowedOwners, listAccessibleRepos } from "./github-app-auth";
import {
  initialPoll,
  startWatching,
  stopWatching,
  groupByRepo,
  getQueuedTasks,
  getTasksByStatus,
  getTaskByPath,
  updateTaskStatus,
  type AgentTask,
} from "./queue";
import { RepoWorker, type AgentRun } from "./worker";
import { RollupMonitor } from "./rollup";
import { Semaphore } from "./semaphore";
import { createSchedulerController, startQueuedTasks } from "./scheduler";

import { DrainMonitor, isDraining, readControlStateSnapshot, type DaemonMode } from "./drain";
import { formatDuration, shouldLog } from "./logging";
import { getThrottleDecision, type ThrottleDecision } from "./throttle";
import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "./opencode-auto-profile";
import { formatNowDoingLine, getSessionNowDoing } from "./live-status";
import { getRalphSessionLockPath } from "./paths";
import { initStateDb, recordPrSnapshot } from "./state";
import { queueNudge } from "./nudge";
import { terminateOpencodeRuns } from "./opencode-process-registry";
import { ralphEventBus } from "./dashboard/bus";
import { buildRalphEvent } from "./dashboard/events";
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

function getDaemonMode(): DaemonMode {
  if (drainMonitor) return drainMonitor.getMode();
  return isDraining() ? "draining" : "running";
}

function getActiveOpencodeProfileName(): string | null {
  const control = drainMonitor
    ? drainMonitor.getState()
    : readControlStateSnapshot({ log: (message) => console.warn(message) });

  const fromControl = control.opencodeProfile?.trim() ?? "";
  if (fromControl) return fromControl;

  return getOpencodeDefaultProfileName();
}

async function resolveEffectiveOpencodeProfileNameForNewTasks(now: number): Promise<string | null> {
  const requested = getActiveOpencodeProfileName();
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

function requireBwrbVaultOrExit(): void {
  const vault = loadConfig().bwrbVault;
  if (!ensureBwrbVaultLayout(vault)) process.exit(1);
}

function ensureSemaphores(): void {
  if (globalSemaphore) return;
  const config = loadConfig();
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
  if (getDaemonMode() === "draining") return;
  if (inFlightTasks.size > 0) return;

  const queued = await getRunnableTasks();
  if (queued.length > 0) {
    resetIdleState(queued);
    return;
  }

  const repos = new Set(loadConfig().repos.map((repo) => repo.name));
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

const schedulerController = createSchedulerController({
  getDaemonMode: () => getDaemonMode(),
  isShuttingDown: () => isShuttingDown,
  getRunnableTasks: () => getRunnableTasks(),
  onRunnableTasks: (tasks) => processNewTasks(tasks),
  getPendingResumeTasks: () => Array.from(pendingResumeTasks.values()),
  onPendingResumeTasks: (priorityTasks) => {
    ensureSemaphores();
    if (!globalSemaphore) return;

    startQueuedTasks({
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
    getVaultPathForLogs: () => loadConfig().bwrbVault,

    ensureSemaphores,
    getGlobalSemaphore: () => globalSemaphore,
    getRepoSemaphore,

    getTaskKey,
    inFlightTasks,

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

async function attemptResumeThrottledTasks(): Promise<void> {
  if (getDaemonMode() === "draining" || isShuttingDown) return;

  ensureSemaphores();
  if (!globalSemaphore) return;

  const throttled = await getTasksByStatus("throttled");
  if (throttled.length === 0) return;

  const controlProfile = getActiveOpencodeProfileName();
  const activeProfile = controlProfile === "auto" ? await resolveAutoOpencodeProfileName(Date.now()) : controlProfile;
  const profileKeys = Array.from(
    new Set(throttled.map((t) => getTaskOpencodeProfileName(t) ?? activeProfile ?? ""))
  );

  const hardByProfile = new Map<string, { hard: boolean; decision: ThrottleDecision }>();

  await Promise.all(
    profileKeys.map(async (profileKey) => {
      const decision = await getThrottleDecision(Date.now(), { opencodeProfile: profileKey ? profileKey : null });
      hardByProfile.set(profileKey, { hard: decision.state === "hard", decision });
    })
  );

  const now = Date.now();

  for (const task of throttled) {
    if (getDaemonMode() === "draining" || isShuttingDown) return;

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
      releaseGlobal();
      releaseRepo();
      if (!isShuttingDown) {
        scheduleQueuedTasksSoon();
        void checkIdleRollups();
      }
    });

  }
}

function startTask(opts: {
  repo: string;
  task: AgentTask;
  releaseGlobal: () => void;
  releaseRepo: () => void;
}): void {
  const { repo, task, releaseGlobal, releaseRepo } = opts;
  const key = getTaskKey(task);

  inFlightTasks.add(key);

  void getOrCreateWorker(repo)
    .processTask(task)
      .then(async (run: AgentRun) => {
        if (run.outcome === "success" && run.pr) {
          try {
            recordPrSnapshot({ repo, issue: task.issue, prUrl: run.pr, state: "merged" });
          } catch {
            // best-effort
          }

          await rollupMonitor.recordMerge(repo, run.pr);
        }
      })
    .catch((e) => {
      console.error(`[ralph] Error processing task ${task.name}:`, e);
    })
    .finally(() => {
      inFlightTasks.delete(key);
      releaseGlobal();
      releaseRepo();
      if (!isShuttingDown) {
        scheduleQueuedTasksSoon();
        void checkIdleRollups();
      }
    });
}

function startResumeTask(opts: {
  repo: string;
  task: AgentTask;
  releaseGlobal: () => void;
  releaseRepo: () => void;
}): void {
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
      releaseGlobal();
      releaseRepo();
      resolveResumeCompletion(key);
      if (!isShuttingDown) {
        const scheduleNext = resumeSchedulingMode === "resume-only" ? scheduleResumeTasksSoon : scheduleQueuedTasksSoon;
        scheduleNext();
        void checkIdleRollups();
      }
    });
}

// --- Main Logic ---

async function processNewTasks(tasks: AgentTask[]): Promise<void> {
  ensureSemaphores();
  if (!globalSemaphore) return;

  const isDraining = getDaemonMode() === "draining";
  if (isDraining && pendingResumeTasks.size === 0) return;

  const selection = await resolveOpencodeProfileForNewWork(Date.now(), getActiveOpencodeProfileName());
  const throttle = selection.decision;

  if (selection.source === "failover") {
    const requested = selection.requestedProfile ?? "default";
    const chosen = throttle.snapshot.opencodeProfile ?? "ambient";

    if (shouldLog(`daemon:opencode-profile-failover:${requested}->${chosen}`, 60_000)) {
      console.warn(`[ralph] Hard throttle on profile=${requested}; failing over to profile=${chosen} for new tasks`);
    }
  }

  if (throttle.state === "hard") {
    if (shouldLog("daemon:hard-throttle", 30_000)) {
      console.warn(
        `[ralph] Hard throttle active (profile=${throttle.snapshot.opencodeProfile ?? "ambient"}); skipping task scheduling until ${
          throttle.snapshot.resumeAt ?? "unknown"
        }`
      );
    }
    return;
  }

  if (throttle.state === "soft") return;

  const queueTasks = isDraining ? [] : tasks;

  if (queueTasks.length > 0) {
    resetIdleState(queueTasks);
  }

  const startedCount = startQueuedTasks({
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

async function printHeartbeatTick(): Promise<void> {
  const [starting, inProgress] = await Promise.all([getTasksByStatus("starting"), getTasksByStatus("in-progress")]);
  const tasks = [...starting, ...inProgress];
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const line = await getTaskNowDoingLine(task);
    console.log(`[ralph:hb] ${line}`);
  }
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

  const inProgressByRepo = groupByRepo(inProgress);
  await Promise.all(
    Array.from(inProgressByRepo.entries()).map(async ([repo, tasks]) => {
      const worker = getOrCreateWorker(repo);
      await worker.runTaskCleanup(tasks);
    })
  );

  if (inProgress.length === 0) return;

  const withoutSession = inProgress.filter((t) => !(t["session-id"]?.trim()));
  for (const task of withoutSession) {
    console.warn(`[ralph] In-progress task has no session ID, resetting to starting: ${task.name}`);
    await updateTaskStatus(task, "starting", { "session-id": "" });
  }

  const withSession = inProgress.filter((t) => t["session-id"]?.trim());
  if (withSession.length === 0) return;

  const globalLimit = loadConfig().maxWorkers;

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
  const config = loadConfig();

  // Ensure the configured vault is valid and ready.
  if (!ensureBwrbVaultLayout(config.bwrbVault)) {
    throw new Error(`Invalid bwrbVault: ${JSON.stringify(config.bwrbVault)}`);
  }

  // Initialize durable local state (SQLite)
  initStateDb();

  ralphEventBus.publish(
    buildRalphEvent({
      type: "daemon.started",
      level: "info",
      data: {},
    })
  );

  console.log("[ralph] Configuration:");
  console.log(`        Vault: ${config.bwrbVault}`);
  console.log(`        Max workers: ${config.maxWorkers}`);
  console.log(`        Batch size: ${config.batchSize} PRs before rollup`);
  console.log(`        Dev directory: ${config.devDir}`);
  console.log("");

  // Start drain monitor (operator control file)
  drainMonitor = new DrainMonitor({
    log: (message) => console.log(message),
    onModeChange: (mode) => {
      if (isShuttingDown) return;
      if (mode !== "running") return;

      void (async () => {
        const tasks = await getRunnableTasks();
        await processNewTasks(tasks);
      })();
    },
  });
  drainMonitor.start();

  // Initialize rollup monitor
  rollupMonitor = new RollupMonitor(config.batchSize);

  // Do initial poll on startup
  console.log("[ralph] Running initial poll...");
  const initialTasks = await initialPoll();
  console.log(`[ralph] Found ${initialTasks.length} runnable task(s) (queued + starting)`);

  if (initialTasks.length > 0 && getDaemonMode() !== "draining") {
    await processNewTasks(initialTasks);
  } else {
    resetIdleState(initialTasks);
  }

  // Start file watching (no polling - watcher is reliable)
  console.log("[ralph] Starting queue watcher...");
  startWatching(async (tasks) => {
    if (!isShuttingDown && getDaemonMode() !== "draining") {
      await processNewTasks(tasks);
    }
  });

  // Resume orphaned tasks from previous daemon runs.
  void resumeTasksOnStartup({ awaitCompletion: false });

  // Resume any resolved escalations (HITL checkpoint) from the same session.
  void attemptResumeResolvedEscalations();

  // Resume any tasks paused by hard throttle.
  void attemptResumeThrottledTasks();

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

  const heartbeatIntervalMs = 5_000;
  let heartbeatInFlight = false;

  const heartbeatTimer = setInterval(() => {
    if (isShuttingDown) return;

    // Avoid hitting bwrb repeatedly when the daemon is idle.
    if (inFlightTasks.size === 0) return;

    // Avoid overlapping ticks if bwrb/filesystem are slow.
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;

    printHeartbeatTick()
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
    if (getDaemonMode() === "draining") return;
    if (throttleResumeInFlight) return;
    throttleResumeInFlight = true;

    attemptResumeThrottledTasks()
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
      "  Drain mode: set mode=draining|running in $XDG_STATE_HOME/ralph/control.json (fallback ~/.local/state/ralph/control.json; last resort /tmp/ralph/<uid>/control.json).",
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

  requireBwrbVaultOrExit();

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

  requireBwrbVaultOrExit();

  const json = args.includes("--json");

  const control = readControlStateSnapshot({ log: (message) => console.warn(message) });
  const controlProfile = control.opencodeProfile?.trim() || "";

  const requestedProfile =
    controlProfile === "auto" ? "auto" : controlProfile || getOpencodeDefaultProfileName() || null;

  const selection = await resolveOpencodeProfileForNewWork(Date.now(), requestedProfile);
  const resolvedProfile: string | null = selection.profileName;
  const throttle = selection.decision;

  const mode = control.mode === "draining"
    ? "draining"
    : throttle.state === "hard"
      ? "hard-throttled"
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

  requireBwrbVaultOrExit();

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

  requireBwrbVaultOrExit();

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

