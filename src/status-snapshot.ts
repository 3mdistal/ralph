import type { DurableStateCapabilityVerdict } from "./durable-state-capability";

export type StatusQueueSnapshot = {
  backend: string;
  health: string;
  fallback: boolean;
  diagnostics: string | null;
};

export type StatusQueueParityRepo = {
  repo: string;
  ghQueuedLocalBlocked: number;
  localDepsBlockedGhInProgress: number;
  localDepsBlockedMissingMeta: number;
  multiStatusLabels: number;
  missingStatusWithOpState: number;
  sampleGhQueuedLocalBlocked: string[];
  sampleLocalDepsBlockedGhInProgress: string[];
  sampleLocalDepsBlockedMissingMeta: string[];
};

export type StatusQueueParitySnapshot = {
  ghQueuedLocalBlocked: number;
  localDepsBlockedGhInProgress: number;
  localDepsBlockedMissingMeta: number;
  multiStatusLabels: number;
  missingStatusWithOpState: number;
  repos: StatusQueueParityRepo[];
};

export type StatusDrainSnapshot = {
  requestedAt: string | null;
  timeoutMs: number | null;
  pauseRequested: boolean;
  pauseAtCheckpoint?: string | null;
};

export type StatusTaskBase = {
  name: string;
  repo: string;
  issue: string;
  priority: string;
  opencodeProfile: string | null;
  alerts?: StatusTaskAlerts | null;
};

export type StatusTaskAlerts = {
  totalCount: number;
  latestSummary: string | null;
  latestAt: string | null;
  latestCommentUrl: string | null;
};

export type StatusInProgressTask = StatusTaskBase & {
  sessionId: string | null;
  nowDoing: unknown | null;
  line: string | null;
  tokensTotal?: number | null;
  tokensComplete?: boolean;
};

export type StatusThrottledTask = StatusTaskBase & {
  sessionId: string | null;
  resumeAt: string | null;
};

export type StatusBlockedTask = StatusTaskBase & {
  sessionId: string | null;
  blockedAt: string | null;
  blockedSource: string | null;
  blockedReason: string | null;
  blockedDetailsSnippet: string | null;
};

export type StatusOrphanTask = {
  repo: string;
  issue: string;
  taskPath: string;
  reason: "closed" | "no-ralph-labels";
  issueState: string | null;
  labels: string[];
  heartbeatAt: string | null;
  daemonId: string | null;
  repoSlot: string | null;
  worktreePath: string | null;
};

export type StatusDaemonSnapshot = {
  daemonId: string | null;
  pid: number | null;
  startedAt: string | null;
  version: string | null;
  controlFilePath: string | null;
  command: string[] | null;
};

export type StatusDaemonLivenessSnapshot = {
  state: "alive" | "missing" | "dead" | "unknown";
  mismatch: boolean;
  hint: string | null;
  pid: number | null;
  daemonId: string | null;
};

export type StatusTriageRun = {
  runId: string;
  repo: string;
  issueNumber: number | null;
  outcome: string | null;
  score: number;
  reasons: string[];
  tokensTotal: number | null;
  toolCallCount: number;
  wallTimeMs: number | null;
  computedAt: string;
};

export type StatusDependencySatisfactionOverride = {
  repo: string;
  issueNumber: number;
  createdAt: string;
  satisfiedAt: string | null;
  via: string | null;
};

export type StatusOnboardingCheckStatus = "pass" | "warn" | "fail" | "unavailable";

export type StatusOnboardingOverallStatus = "pass" | "warn" | "fail";

export type StatusOnboardingCheck = {
  checkId: string;
  title: string;
  critical: boolean;
  status: StatusOnboardingCheckStatus;
  reason: string;
  remediation: string[];
};

export type StatusOnboardingRepo = {
  repo: string;
  status: StatusOnboardingOverallStatus;
  checks: StatusOnboardingCheck[];
};

export type StatusOnboardingSnapshot = {
  version: 1;
  repos: StatusOnboardingRepo[];
};

import type { StatusUsageSnapshot } from "./status-usage";

export type StatusSnapshot = {
  mode: string;
  desiredMode?: string;
  durableState?: {
    ok: boolean;
    code?: string;
    verdict?: DurableStateCapabilityVerdict;
    canReadState?: boolean;
    canWriteState?: boolean;
    requiresMigration?: boolean;
    message?: string;
    schemaVersion?: number;
    minReadableSchema?: number;
    maxReadableSchema?: number;
    maxWritableSchema?: number;
    supportedRange?: string;
    writableRange?: string;
  };
  queue: StatusQueueSnapshot;
  parity?: StatusQueueParitySnapshot;
  daemon: StatusDaemonSnapshot | null;
  daemonLiveness?: StatusDaemonLivenessSnapshot;
  controlProfile: string | null;
  activeProfile: string | null;
  throttle: unknown;
  usage?: StatusUsageSnapshot;
  triageRuns?: StatusTriageRun[];
  dependencySatisfactionOverrides?: StatusDependencySatisfactionOverride[];
  escalations: { pending: number };
  inProgress: StatusInProgressTask[];
  starting: StatusTaskBase[];
  queued: StatusTaskBase[];
  throttled: StatusThrottledTask[];
  blocked: StatusBlockedTask[];
  orphans?: StatusOrphanTask[];
  drain: StatusDrainSnapshot;
  githubGovernor?: {
    enabled: boolean;
    dryRun: boolean;
    cooldown: { active: boolean; untilTs: number | null };
    lanes: {
      critical: { allowed: number; deferred: number };
      important: { allowed: number; deferred: number };
      best_effort: { allowed: number; deferred: number };
    };
    starvation: { count: number; lastAtTs: number | null };
  };
  onboarding?: StatusOnboardingSnapshot;
};

const normalizeOrphanTask = (task: StatusOrphanTask): StatusOrphanTask => ({
  ...task,
  issueState: normalizeOptionalString(task.issueState),
  heartbeatAt: normalizeOptionalString(task.heartbeatAt),
  daemonId: normalizeOptionalString(task.daemonId),
  repoSlot: normalizeOptionalString(task.repoSlot),
  worktreePath: normalizeOptionalString(task.worktreePath),
  labels: Array.isArray(task.labels) ? task.labels.map((label) => String(label ?? "").trim()).filter(Boolean) : [],
});

const normalizeOptionalString = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeDaemonLiveness = (
  liveness?: StatusDaemonLivenessSnapshot
): StatusDaemonLivenessSnapshot | undefined => {
  if (!liveness) return undefined;
  return {
    state: liveness.state,
    mismatch: liveness.mismatch === true,
    hint: normalizeOptionalString(liveness.hint),
    pid: typeof liveness.pid === "number" ? liveness.pid : null,
    daemonId: normalizeOptionalString(liveness.daemonId),
  };
};

const normalizeAlerts = (alerts?: StatusTaskAlerts | null): StatusTaskAlerts | null => {
  if (!alerts || typeof alerts.totalCount !== "number" || alerts.totalCount <= 0) return null;
  return {
    totalCount: alerts.totalCount,
    latestSummary: normalizeOptionalString(alerts.latestSummary),
    latestAt: normalizeOptionalString(alerts.latestAt),
    latestCommentUrl: normalizeOptionalString(alerts.latestCommentUrl),
  };
};

const normalizeTaskBase = <T extends StatusTaskBase>(task: T): T => ({
  ...task,
  alerts: normalizeAlerts(task.alerts),
});

const normalizeBlockedTask = (task: StatusBlockedTask): StatusBlockedTask => ({
  ...normalizeTaskBase(task),
  sessionId: normalizeOptionalString(task.sessionId),
  blockedAt: normalizeOptionalString(task.blockedAt),
  blockedSource: normalizeOptionalString(task.blockedSource),
  blockedReason: normalizeOptionalString(task.blockedReason),
  blockedDetailsSnippet: normalizeOptionalString(task.blockedDetailsSnippet),
});

const normalizeThrottledTask = (task: StatusThrottledTask): StatusThrottledTask => ({
  ...normalizeTaskBase(task),
  sessionId: normalizeOptionalString(task.sessionId),
  resumeAt: normalizeOptionalString(task.resumeAt),
});

const normalizeInProgressTask = (task: StatusInProgressTask): StatusInProgressTask => ({
  ...normalizeTaskBase(task),
  sessionId: normalizeOptionalString(task.sessionId),
  line: normalizeOptionalString(task.line),
});

const normalizeOnboarding = (onboarding?: StatusOnboardingSnapshot): StatusOnboardingSnapshot | undefined => {
  if (!onboarding || onboarding.version !== 1 || !Array.isArray(onboarding.repos)) return undefined;
  const repos = onboarding.repos
    .map((repo) => {
      const repoName = normalizeOptionalString(repo.repo);
      if (!repoName) return null;
      const status = repo.status === "pass" || repo.status === "warn" || repo.status === "fail" ? repo.status : "warn";
      const checks = Array.isArray(repo.checks)
        ? repo.checks
            .map((check) => {
              const checkId = normalizeOptionalString(check.checkId);
              const title = normalizeOptionalString(check.title);
              if (!checkId || !title) return null;
              const checkStatus =
                check.status === "pass" || check.status === "warn" || check.status === "fail" || check.status === "unavailable"
                  ? check.status
                  : "unavailable";
              return {
                checkId,
                title,
                critical: check.critical === true,
                status: checkStatus,
                reason: normalizeOptionalString(check.reason) ?? "No details",
                remediation: Array.isArray(check.remediation)
                  ? check.remediation.map((item) => String(item ?? "").trim()).filter(Boolean)
                  : [],
              };
            })
            .filter((check): check is StatusOnboardingCheck => Boolean(check))
        : [];
      return { repo: repoName, status, checks };
    })
    .filter((repo): repo is StatusOnboardingRepo => Boolean(repo));
  return { version: 1, repos };
};

export function buildStatusSnapshot(input: StatusSnapshot): StatusSnapshot {
  const desiredMode = normalizeOptionalString(input.desiredMode);
  const durableState = input.durableState
    ? (() => {
        const verdict =
          input.durableState.verdict === "readable_writable" ||
          input.durableState.verdict === "readable_readonly_forward_newer" ||
          input.durableState.verdict === "unreadable_forward_incompatible" ||
          input.durableState.verdict === "unreadable_invariant_failure"
            ? input.durableState.verdict
            : undefined;
        const canReadState =
          typeof input.durableState.canReadState === "boolean"
            ? input.durableState.canReadState
            : input.durableState.ok === true;
        const canWriteState =
          typeof input.durableState.canWriteState === "boolean"
            ? input.durableState.canWriteState
            : input.durableState.ok === true && verdict !== "readable_readonly_forward_newer";
        const requiresMigration =
          typeof input.durableState.requiresMigration === "boolean"
            ? input.durableState.requiresMigration
            : !canWriteState;

        return {
        ok: input.durableState.ok === true,
        code: normalizeOptionalString(input.durableState.code) ?? undefined,
        verdict,
        message: normalizeOptionalString(input.durableState.message) ?? undefined,
        canReadState,
        canWriteState,
        requiresMigration,
        schemaVersion:
          typeof input.durableState.schemaVersion === "number" && Number.isFinite(input.durableState.schemaVersion)
            ? Math.floor(input.durableState.schemaVersion)
            : undefined,
        minReadableSchema:
          typeof input.durableState.minReadableSchema === "number" && Number.isFinite(input.durableState.minReadableSchema)
            ? Math.floor(input.durableState.minReadableSchema)
            : undefined,
        maxReadableSchema:
          typeof input.durableState.maxReadableSchema === "number" && Number.isFinite(input.durableState.maxReadableSchema)
            ? Math.floor(input.durableState.maxReadableSchema)
            : undefined,
        maxWritableSchema:
          typeof input.durableState.maxWritableSchema === "number" && Number.isFinite(input.durableState.maxWritableSchema)
            ? Math.floor(input.durableState.maxWritableSchema)
            : undefined,
        supportedRange: normalizeOptionalString(input.durableState.supportedRange) ?? undefined,
        writableRange: normalizeOptionalString(input.durableState.writableRange) ?? undefined,
      };
      })()
    : undefined;
  return {
    ...input,
    desiredMode: desiredMode ?? undefined,
    durableState,
    daemonLiveness: normalizeDaemonLiveness(input.daemonLiveness),
    blocked: input.blocked.map(normalizeBlockedTask),
    orphans: input.orphans?.map(normalizeOrphanTask),
    inProgress: input.inProgress.map(normalizeInProgressTask),
    starting: input.starting.map(normalizeTaskBase),
    queued: input.queued.map(normalizeTaskBase),
    throttled: input.throttled.map(normalizeThrottledTask),
    githubGovernor: input.githubGovernor
      ? {
          enabled: input.githubGovernor.enabled === true,
          dryRun: input.githubGovernor.dryRun === true,
          cooldown: {
            active: input.githubGovernor.cooldown.active === true,
            untilTs:
              typeof input.githubGovernor.cooldown.untilTs === "number" && Number.isFinite(input.githubGovernor.cooldown.untilTs)
                ? input.githubGovernor.cooldown.untilTs
                : null,
          },
          lanes: {
            critical: {
              allowed: Math.max(0, Math.floor(input.githubGovernor.lanes.critical.allowed ?? 0)),
              deferred: Math.max(0, Math.floor(input.githubGovernor.lanes.critical.deferred ?? 0)),
            },
            important: {
              allowed: Math.max(0, Math.floor(input.githubGovernor.lanes.important.allowed ?? 0)),
              deferred: Math.max(0, Math.floor(input.githubGovernor.lanes.important.deferred ?? 0)),
            },
            best_effort: {
              allowed: Math.max(0, Math.floor(input.githubGovernor.lanes.best_effort.allowed ?? 0)),
              deferred: Math.max(0, Math.floor(input.githubGovernor.lanes.best_effort.deferred ?? 0)),
            },
          },
          starvation: {
            count: Math.max(0, Math.floor(input.githubGovernor.starvation.count ?? 0)),
            lastAtTs:
              typeof input.githubGovernor.starvation.lastAtTs === "number" && Number.isFinite(input.githubGovernor.starvation.lastAtTs)
                ? input.githubGovernor.starvation.lastAtTs
                : null,
          },
        }
      : undefined,
    onboarding: normalizeOnboarding(input.onboarding),
  };
}
