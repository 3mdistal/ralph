import { getRuntimeSnapshot, initStateDb, setRuntimeSnapshot } from "../state";

export type GitHubLane = "critical" | "important" | "best_effort";

export type GitHubGovernorDecision =
  | { kind: "allow" }
  | { kind: "defer"; untilTs: number; reason: "cooldown" | "lane_budget" | "pressure" };

type LanePolicy = {
  capacity: number;
  refillPerSec: number;
};

type LaneBucket = {
  tokens: number;
  lastRefillMs: number;
};

type ScopeGovernorState = {
  cooldownUntilTs: number;
  lastResetTs: number | null;
  lastRemaining: number | null;
  laneBuckets: Record<GitHubLane, LaneBucket>;
  deferredCounts: Record<GitHubLane, number>;
  allowedCounts: Record<GitHubLane, number>;
  starvationCount: number;
  lastStarvationAtTs: number | null;
};

export type GitHubGovernorSummary = {
  version: 1;
  enabled: boolean;
  dryRun: boolean;
  capturedAtMs: number;
  cooldown: {
    active: boolean;
    untilTs: number | null;
  };
  lanes: Record<GitHubLane, { allowed: number; deferred: number }>;
  starvation: {
    count: number;
    lastAtTs: number | null;
  };
};

const SNAPSHOT_KEY = "github_budget_governor_v1";
const SNAPSHOT_WRITE_MIN_INTERVAL_MS = 1000;
let lastSnapshotWriteAtMs = 0;

const scopeState = new Map<string, ScopeGovernorState>();

function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return raw;
}

function lanePolicy(lane: GitHubLane): LanePolicy {
  if (lane === "critical") {
    return {
      capacity: 1_000_000,
      refillPerSec: 1_000_000,
    };
  }
  if (lane === "important") {
    return {
      capacity: Math.max(1, Math.floor(readEnvNumber("RALPH_GITHUB_BUDGET_IMPORTANT_CAPACITY", 16))),
      refillPerSec: Math.max(0.1, readEnvNumber("RALPH_GITHUB_BUDGET_IMPORTANT_REFILL_PER_SEC", 0.75)),
    };
  }
  return {
    capacity: Math.max(1, Math.floor(readEnvNumber("RALPH_GITHUB_BUDGET_BEST_EFFORT_CAPACITY", 8))),
    refillPerSec: Math.max(0.05, readEnvNumber("RALPH_GITHUB_BUDGET_BEST_EFFORT_REFILL_PER_SEC", 0.35)),
  };
}

function requestCost(isWrite: boolean): number {
  return isWrite ? 2 : 1;
}

function makeInitialState(nowMs: number): ScopeGovernorState {
  return {
    cooldownUntilTs: 0,
    lastResetTs: null,
    lastRemaining: null,
    laneBuckets: {
      critical: { tokens: 1_000_000, lastRefillMs: nowMs },
      important: { tokens: lanePolicy("important").capacity, lastRefillMs: nowMs },
      best_effort: { tokens: lanePolicy("best_effort").capacity, lastRefillMs: nowMs },
    },
    deferredCounts: { critical: 0, important: 0, best_effort: 0 },
    allowedCounts: { critical: 0, important: 0, best_effort: 0 },
    starvationCount: 0,
    lastStarvationAtTs: null,
  };
}

function normalizeScopeKey(params: { repo: string; scopeKey?: string | null }): string {
  const scope = params.scopeKey?.trim();
  if (scope) return scope;
  return `repo:${params.repo}`;
}

function getState(scopeKey: string, nowMs: number): ScopeGovernorState {
  const existing = scopeState.get(scopeKey);
  if (existing) return existing;
  const created = makeInitialState(nowMs);
  scopeState.set(scopeKey, created);
  return created;
}

function refillBucket(bucket: LaneBucket, policy: LanePolicy, nowMs: number): void {
  if (nowMs <= bucket.lastRefillMs) return;
  const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(policy.capacity, bucket.tokens + elapsedSec * policy.refillPerSec);
  bucket.lastRefillMs = nowMs;
}

export function isGitHubBudgetGovernorEnabled(): boolean {
  return readEnvBool("RALPH_GITHUB_BUDGET_GOVERNOR", false);
}

export function isGitHubBudgetGovernorDryRun(): boolean {
  return readEnvBool("RALPH_GITHUB_BUDGET_GOVERNOR_DRY_RUN", false);
}

function buildSummary(nowMs: number): GitHubGovernorSummary {
  const summary: GitHubGovernorSummary = {
    version: 1,
    enabled: isGitHubBudgetGovernorEnabled(),
    dryRun: isGitHubBudgetGovernorDryRun(),
    capturedAtMs: nowMs,
    cooldown: { active: false, untilTs: null },
    lanes: {
      critical: { allowed: 0, deferred: 0 },
      important: { allowed: 0, deferred: 0 },
      best_effort: { allowed: 0, deferred: 0 },
    },
    starvation: { count: 0, lastAtTs: null },
  };

  for (const state of scopeState.values()) {
    for (const lane of ["critical", "important", "best_effort"] as const) {
      summary.lanes[lane].allowed += state.allowedCounts[lane];
      summary.lanes[lane].deferred += state.deferredCounts[lane];
    }
    summary.starvation.count += state.starvationCount;
    if (typeof state.lastStarvationAtTs === "number") {
      summary.starvation.lastAtTs = Math.max(summary.starvation.lastAtTs ?? 0, state.lastStarvationAtTs);
    }
    if (state.cooldownUntilTs > nowMs) {
      summary.cooldown.active = true;
      summary.cooldown.untilTs = Math.max(summary.cooldown.untilTs ?? 0, state.cooldownUntilTs);
    }
  }

  return summary;
}

function persistSummaryBestEffort(nowMs: number): void {
  if (!isGitHubBudgetGovernorEnabled()) return;
  if (nowMs - lastSnapshotWriteAtMs < SNAPSHOT_WRITE_MIN_INTERVAL_MS) return;
  lastSnapshotWriteAtMs = nowMs;
  try {
    initStateDb();
    setRuntimeSnapshot(SNAPSHOT_KEY, buildSummary(nowMs));
  } catch {
    // best-effort only
  }
}

function isValidSummary(value: unknown): value is GitHubGovernorSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return (
    v.version === 1 &&
    typeof v.enabled === "boolean" &&
    typeof v.dryRun === "boolean" &&
    typeof v.capturedAtMs === "number" &&
    v.cooldown &&
    typeof v.cooldown.active === "boolean" &&
    (v.cooldown.untilTs === null || typeof v.cooldown.untilTs === "number") &&
    v.lanes &&
    v.starvation
  );
}

export function decideGitHubBudget(params: {
  repo: string;
  scopeKey?: string | null;
  lane: GitHubLane;
  isWrite: boolean;
  nowMs: number;
}): GitHubGovernorDecision {
  if (!isGitHubBudgetGovernorEnabled()) return { kind: "allow" };

  const scopeKey = normalizeScopeKey({ repo: params.repo, scopeKey: params.scopeKey });
  const state = getState(scopeKey, params.nowMs);
  const lane = params.lane;

  if (state.cooldownUntilTs > params.nowMs) {
    if (lane === "critical") {
      state.allowedCounts[lane] += 1;
      if (state.lastRemaining !== null && state.lastRemaining <= 0) {
        state.starvationCount += 1;
        state.lastStarvationAtTs = params.nowMs;
      }
      persistSummaryBestEffort(params.nowMs);
      return { kind: "allow" };
    }
    state.deferredCounts[lane] += 1;
    persistSummaryBestEffort(params.nowMs);
    return { kind: "defer", untilTs: state.cooldownUntilTs, reason: "cooldown" };
  }

  const pressureThreshold = Math.max(0, Math.floor(readEnvNumber("RALPH_GITHUB_BUDGET_PRESSURE_THRESHOLD", 25)));
  if (lane === "best_effort" && state.lastRemaining !== null && state.lastRemaining <= pressureThreshold) {
    state.deferredCounts[lane] += 1;
    const fallbackUntilTs = state.lastResetTs ?? params.nowMs + 30_000;
    persistSummaryBestEffort(params.nowMs);
    return { kind: "defer", untilTs: fallbackUntilTs, reason: "pressure" };
  }

  if (lane !== "critical") {
    const bucket = state.laneBuckets[lane];
    const policy = lanePolicy(lane);
    refillBucket(bucket, policy, params.nowMs);
    const cost = requestCost(params.isWrite);
    if (bucket.tokens < cost) {
      state.deferredCounts[lane] += 1;
      const deficit = cost - bucket.tokens;
      const waitMs = Math.ceil((deficit / policy.refillPerSec) * 1000);
      persistSummaryBestEffort(params.nowMs);
      return { kind: "defer", untilTs: params.nowMs + Math.max(1000, waitMs), reason: "lane_budget" };
    }
    bucket.tokens -= cost;
  }

  state.allowedCounts[lane] += 1;
  persistSummaryBestEffort(params.nowMs);
  return { kind: "allow" };
}

export function observeGitHubRateLimit(params: {
  repo: string;
  scopeKey?: string | null;
  nowMs: number;
  resumeAtTs: number | null;
  remaining?: number | null;
  resetAtTs?: number | null;
}): void {
  if (!isGitHubBudgetGovernorEnabled()) return;
  const scopeKey = normalizeScopeKey({ repo: params.repo, scopeKey: params.scopeKey });
  const state = getState(scopeKey, params.nowMs);
  if (typeof params.remaining === "number" && Number.isFinite(params.remaining)) {
    state.lastRemaining = params.remaining;
  }
  if (typeof params.resetAtTs === "number" && Number.isFinite(params.resetAtTs)) {
    state.lastResetTs = params.resetAtTs;
  }
  const untilTs =
    typeof params.resumeAtTs === "number" && Number.isFinite(params.resumeAtTs)
      ? params.resumeAtTs
      : typeof params.resetAtTs === "number" && Number.isFinite(params.resetAtTs)
        ? params.resetAtTs
        : params.nowMs + 60_000;
  state.cooldownUntilTs = Math.max(state.cooldownUntilTs, untilTs);
  persistSummaryBestEffort(params.nowMs);
}

export function observeGitHubHeaders(params: {
  repo: string;
  scopeKey?: string | null;
  nowMs: number;
  remaining?: number | null;
  resetAtTs?: number | null;
}): void {
  if (!isGitHubBudgetGovernorEnabled()) return;
  const scopeKey = normalizeScopeKey({ repo: params.repo, scopeKey: params.scopeKey });
  const state = getState(scopeKey, params.nowMs);
  if (typeof params.remaining === "number" && Number.isFinite(params.remaining)) {
    state.lastRemaining = params.remaining;
  }
  if (typeof params.resetAtTs === "number" && Number.isFinite(params.resetAtTs)) {
    state.lastResetTs = params.resetAtTs;
  }
  if (state.cooldownUntilTs > 0 && state.cooldownUntilTs <= params.nowMs) {
    state.cooldownUntilTs = 0;
  }
  persistSummaryBestEffort(params.nowMs);
}

export function getGitHubGovernorSummary(nowMs: number = Date.now()): GitHubGovernorSummary {
  return buildSummary(nowMs);
}

export function getGitHubGovernorSummaryForStatus(nowMs: number = Date.now()): GitHubGovernorSummary {
  const inMemory = buildSummary(nowMs);
  try {
    initStateDb();
    const stored = getRuntimeSnapshot<GitHubGovernorSummary>(SNAPSHOT_KEY);
    if (isValidSummary(stored)) return stored;
  } catch {
    // best-effort only
  }
  return inMemory;
}

export function __resetGitHubGovernorForTests(): void {
  scopeState.clear();
  lastSnapshotWriteAtMs = 0;
  try {
    initStateDb();
    setRuntimeSnapshot(SNAPSHOT_KEY, null);
  } catch {
    // ignore in tests without state db
  }
}

export function __setGitHubGovernorCooldownForTests(repo: string, untilTs: number): void {
  const nowMs = Date.now();
  const state = getState(`repo:${repo}`, nowMs);
  state.cooldownUntilTs = untilTs;
}
