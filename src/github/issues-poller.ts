import { type RepoConfig } from "../config";
import { isRepoAllowed } from "../github-app-auth";
import { shouldLog } from "../logging";
import type { SchedulerTimers } from "../scheduler";
import { getRepoGithubIssueLastSyncAt } from "../state";
import { reconcileEscalationResolutions } from "./escalation-resolution";
import { syncRepoIssuesOnce } from "./issues-sync-service";
import type { SyncResult } from "./issues-sync-types";

type PollerHandle = { stop: () => void };

type RepoPollerDeps = {
  nowMs: () => number;
  random: () => number;
  timers: SchedulerTimers;
  syncOnce: typeof syncRepoIssuesOnce;
  getLastSyncAt: (repo: string) => string | null;
};

const DEFAULT_JITTER_PCT = 0.2;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const DEFAULT_ERROR_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MULTIPLIER = 10;
const MIN_DELAY_MS = 1000;
const ESCALATION_RECONCILE_MIN_INTERVAL_MS = 60_000;

const DEFAULT_REPO_POLLER_DEPS: RepoPollerDeps = {
  nowMs: () => Date.now(),
  random: () => Math.random(),
  timers: { setTimeout, clearTimeout },
  syncOnce: syncRepoIssuesOnce,
  getLastSyncAt: getRepoGithubIssueLastSyncAt,
};

function resolveRepoPollerDeps(overrides?: Partial<RepoPollerDeps>): RepoPollerDeps {
  if (!overrides) return DEFAULT_REPO_POLLER_DEPS;
  return {
    nowMs: overrides.nowMs ?? DEFAULT_REPO_POLLER_DEPS.nowMs,
    random: overrides.random ?? DEFAULT_REPO_POLLER_DEPS.random,
    timers: overrides.timers ?? DEFAULT_REPO_POLLER_DEPS.timers,
    syncOnce: overrides.syncOnce ?? DEFAULT_REPO_POLLER_DEPS.syncOnce,
    getLastSyncAt: overrides.getLastSyncAt ?? DEFAULT_REPO_POLLER_DEPS.getLastSyncAt,
  };
}

function applyJitter(valueMs: number, pct = DEFAULT_JITTER_PCT, random = Math.random): number {
  const clamped = Math.max(valueMs, MIN_DELAY_MS);
  const variance = clamped * pct;
  const delta = (random() * 2 - 1) * variance;
  return Math.max(MIN_DELAY_MS, Math.round(clamped + delta));
}

function nextDelayMs(params: {
  baseMs: number;
  previousMs: number;
  hadChanges: boolean;
  hadError: boolean;
  maxMultiplier?: number;
}): number {
  if (params.hadChanges) return params.baseMs;
  const multiplier = params.hadError ? DEFAULT_ERROR_MULTIPLIER : DEFAULT_BACKOFF_MULTIPLIER;
  const maxMultiplier = params.maxMultiplier ?? DEFAULT_MAX_BACKOFF_MULTIPLIER;
  const next = params.previousMs * multiplier;
  return Math.min(next, params.baseMs * maxMultiplier);
}

function resolveRateLimitDelayMs(resetAtMs: number, nowMs: number): number {
  return Math.max(MIN_DELAY_MS, resetAtMs - nowMs);
}

function formatRepoLabel(repo: string): string {
  return repo.includes("/") ? repo.split("/")[1] : repo;
}

function resolveBaseIntervalMs(baseIntervalMs: number): number {
  return Math.max(baseIntervalMs, MIN_DELAY_MS);
}

function startRepoPoller(params: {
  repo: RepoConfig;
  baseIntervalMs: number;
  log: (msg: string) => void;
  onSync?: (payload: { repo: string; result: SyncResult }) => void;
  deps?: Partial<RepoPollerDeps>;
}): PollerHandle {
  const deps = resolveRepoPollerDeps(params.deps);
  const timers = deps.timers;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let delayMs = resolveBaseIntervalMs(params.baseIntervalMs);
  let lastEscalationReconcileAt = 0;
  const repoName = params.repo.name;
  const repoLabel = formatRepoLabel(repoName);

  const scheduleNext = (nextDelayMsValue: number, applyJitterValue = true) => {
    if (stopped) return;
    const delay = applyJitterValue
      ? applyJitter(nextDelayMsValue, DEFAULT_JITTER_PCT, deps.random)
      : Math.max(MIN_DELAY_MS, nextDelayMsValue);
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    timer = timers.setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped) return;
    const lastSyncAt = deps.getLastSyncAt(repoName);

    const autoQueue = (params.repo as any).autoQueue as { enabled?: boolean; scope?: string } | undefined;
    const storeAllOpen = Boolean(autoQueue?.enabled && autoQueue?.scope === "all-open");
    const controller = new AbortController();
    activeController = controller;
    let result: SyncResult;
    try {
      result = await deps.syncOnce({
        repo: repoName,
        repoPath: params.repo.path,
        botBranch: params.repo.botBranch,
        lastSyncAt,
        persistCursor: true,
        storeAllOpen,
        signal: controller.signal,
      });
    } finally {
      if (activeController === controller) activeController = null;
    }

    if (stopped) return;
    if (result.status === "aborted") {
      scheduleNext(delayMs, false);
      return;
    }

    if (result.status === "ok") {
      delayMs = nextDelayMs({
        baseMs: params.baseIntervalMs,
        previousMs: delayMs,
        hadChanges: result.hadChanges,
        hadError: false,
      });

      params.log(
        `[ralph:gh-sync:${repoLabel}] fetched=${result.fetched} stored=${result.stored} ` +
          `ralph=${result.ralphCount} cursor=${lastSyncAt ?? "none"}->${result.newLastSyncAt ?? "none"} ` +
          `delayMs=${delayMs}`
      );

      const nowMs = deps.nowMs();
      const elapsedMs = nowMs - lastEscalationReconcileAt;
      if (elapsedMs < ESCALATION_RECONCILE_MIN_INTERVAL_MS) {
        if (shouldLog(`ralph:gh-sync:${repoLabel}:escalation-defer`, ESCALATION_RECONCILE_MIN_INTERVAL_MS)) {
          const remaining = Math.max(0, ESCALATION_RECONCILE_MIN_INTERVAL_MS - elapsedMs);
          params.log(`[ralph:gh-sync:${repoLabel}] escalation reconcile deferred for ${Math.round(remaining / 1000)}s`);
        }
      } else {
        lastEscalationReconcileAt = nowMs;
        try {
          await reconcileEscalationResolutions({ repo: repoName, log: params.log });
        } catch (error: any) {
          params.log(
            `[ralph:gh-sync:${repoLabel}] escalation resolution reconcile failed: ${error?.message ?? String(error)}`
          );
        }
      }

      if (params.onSync) {
        params.onSync({ repo: repoName, result });
      }

      scheduleNext(delayMs, false);
      return;
    }

    if (result.status === "error" && result.rateLimitResetMs) {
      const nowMs = deps.nowMs();
      const resetDelay = resolveRateLimitDelayMs(result.rateLimitResetMs, nowMs);
      delayMs = Math.max(delayMs, resetDelay);
      params.log(`[ralph:gh-sync:${repoLabel}] rate-limit reset in ${Math.round(resetDelay / 1000)}s (delayMs=${delayMs})`);
      scheduleNext(delayMs);
      return;
    }

    delayMs = nextDelayMs({
      baseMs: params.baseIntervalMs,
      previousMs: delayMs,
      hadChanges: false,
      hadError: true,
    });
    params.log(`[ralph:gh-sync:${repoLabel}] error=${result.error ?? "unknown"} delayMs=${delayMs}`);
    scheduleNext(delayMs);
  };

  scheduleNext(delayMs);

  return {
    stop: () => {
      stopped = true;
      activeController?.abort();
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

export function __testOnlyStartRepoPoller(params: {
  repo: RepoConfig;
  baseIntervalMs: number;
  log: (msg: string) => void;
  onSync?: (payload: { repo: string; result: SyncResult }) => void;
  deps?: Partial<RepoPollerDeps>;
}): PollerHandle {
  return startRepoPoller(params);
}

export function startGitHubIssuePollers(params: {
  repos: RepoConfig[];
  baseIntervalMs: number;
  log?: (msg: string) => void;
  onSync?: (payload: { repo: string; result: SyncResult }) => void;
}): PollerHandle {
  const log = params.log ?? ((msg: string) => console.log(msg));
  const handles: PollerHandle[] = [];

  for (const repo of params.repos) {
    if (!isRepoAllowed(repo.name)) {
      log(`[ralph:gh-sync] Skipping ${repo.name} (owner not in allowlist)`);
      continue;
    }

    if (!repo.name || !repo.path || !repo.botBranch) {
      log(`[ralph:gh-sync] Skipping repo with missing config: ${JSON.stringify(repo.name)}`);
      continue;
    }

    handles.push(
      startRepoPoller({
        repo,
        baseIntervalMs: params.baseIntervalMs,
        log,
        onSync: params.onSync,
      })
    );
  }

  if (handles.length === 0) {
    log("[ralph:gh-sync] No repos configured for polling.");
  } else {
    log(`[ralph:gh-sync] Started polling ${handles.length} repo(s).`);
  }

  return {
    stop: () => {
      for (const handle of handles) handle.stop();
      handles.length = 0;
    },
  };
}
