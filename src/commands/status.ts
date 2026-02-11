import { getConfig, getRequestedOpencodeProfileName, isOpencodeProfilesEnabled, listOpencodeProfileNames } from "../config";
import { readControlStateSnapshot, type DaemonMode } from "../drain";
import { readDaemonRecord } from "../daemon-record";
import { getSessionNowDoing } from "../live-status";
import { resolveOpencodeProfileForNewWork } from "../opencode-auto-profile";
import { getQueueBackendStateWithLabelHealth, getQueuedTasks, getTasksByStatus } from "../queue-backend";
import { priorityRank } from "../queue/priority";
import { buildStatusSnapshot, type StatusSnapshot } from "../status-snapshot";
import { collectStatusUsageRows, formatStatusUsageSection } from "../status-usage";
import { readRunTokenTotals } from "../status-run-tokens";
import { formatNowDoingLine } from "../live-status";
import {
  classifyDurableStateInitError,
  initStateDb,
  listDependencySatisfactionOverrides,
  listIssueAlertSummaries,
  listTopRalphRunTriages,
  probeDurableState,
} from "../state";
import { getThrottleDecision } from "../throttle";
import { computeDaemonGate } from "../daemon-gate";
import { parseIssueRef } from "../github/issue-ref";
import { formatDuration } from "../logging";
import { isHeartbeatStale, parseHeartbeatMs } from "../ownership";
import { auditQueueParityForRepo } from "../github/queue-parity-audit";
import { deriveDaemonLiveness, formatDaemonLivenessLine } from "../daemon-liveness";
import {
  formatActiveOpencodeProfileLine,
  formatBlockedIdleSuffix,
  formatTaskLabel,
  getTaskNowDoingLine,
  getTaskOpencodeProfileName,
  summarizeBlockedDetailsSnippet,
} from "../status-utils";

const STATUS_USAGE_TIMEOUT_MS = 10_000;
const STATUS_USAGE_CONCURRENCY = 2;
const STATUS_TOKEN_TIMEOUT_MS = 5_000;
const STATUS_TOKEN_CONCURRENCY = 3;
const STATUS_TOKEN_BUDGET_MS = 4_000;

const DISABLE_GITHUB_QUEUE_SWEEPS_ENV = "RALPH_GITHUB_QUEUE_DISABLE_SWEEPS";

async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

function buildQueueParitySnapshot(repos: string[]) {
  const perRepo = repos.map((repo) => auditQueueParityForRepo(repo));
  return {
    ghQueuedLocalBlocked: perRepo.reduce((sum, repo) => sum + repo.ghQueuedLocalBlocked, 0),
    multiStatusLabels: perRepo.reduce((sum, repo) => sum + repo.multiStatusLabels, 0),
    missingStatusWithOpState: perRepo.reduce((sum, repo) => sum + repo.missingStatusWithOpState, 0),
    repos: perRepo,
  };
}

type StatusTaskSets = {
  starting: Awaited<ReturnType<typeof getTasksByStatus>>;
  inProgress: Awaited<ReturnType<typeof getTasksByStatus>>;
  queued: Awaited<ReturnType<typeof getQueuedTasks>>;
  throttled: Awaited<ReturnType<typeof getTasksByStatus>>;
  blocked: Awaited<ReturnType<typeof getTasksByStatus>>;
  pendingEscalationsCount: number;
};

async function getStatusTaskSets(opts: { disableSweeps: boolean }): Promise<StatusTaskSets> {
  const run = async () => {
    const [starting, inProgress, queued, throttled, blocked, escalated] = await Promise.all([
      getTasksByStatus("starting"),
      getTasksByStatus("in-progress"),
      getQueuedTasks(),
      getTasksByStatus("throttled"),
      getTasksByStatus("blocked"),
      getTasksByStatus("escalated"),
    ]);
    return {
      starting,
      inProgress,
      queued,
      throttled,
      blocked,
      pendingEscalationsCount: escalated.length,
    };
  };

  if (!opts.disableSweeps) return run();
  return withEnv(DISABLE_GITHUB_QUEUE_SWEEPS_ENV, "1", run);
}

function computeDesiredMode(params: { gateReason: string; throttleState: string }): string {
  return params.gateReason === "hard-throttled"
    ? "hard-throttled"
    : params.gateReason === "paused"
      ? "paused"
      : params.gateReason === "draining"
        ? "draining"
        : params.throttleState === "soft"
          ? "soft-throttled"
          : "running";
}

type StatusBaseData = {
  config: ReturnType<typeof getConfig>;
  depSatisfaction: NonNullable<StatusSnapshot["dependencySatisfactionOverrides"]>;
  queueState: ReturnType<typeof getQueueBackendStateWithLabelHealth>;
  parity: ReturnType<typeof buildQueueParitySnapshot>;
  daemon: StatusSnapshot["daemon"];
  desiredMode: string;
  mode: string;
  daemonLiveness: NonNullable<StatusSnapshot["daemonLiveness"]>;
  controlProfile: string;
  requestedProfile: string | null;
  selection: Awaited<ReturnType<typeof resolveOpencodeProfileForNewWork>>;
  resolvedProfile: string | null;
  throttle: Awaited<ReturnType<typeof resolveOpencodeProfileForNewWork>>["decision"];
  starting: Awaited<ReturnType<typeof getTasksByStatus>>;
  inProgress: Awaited<ReturnType<typeof getTasksByStatus>>;
  queued: Awaited<ReturnType<typeof getQueuedTasks>>;
  throttled: Awaited<ReturnType<typeof getTasksByStatus>>;
  blockedSorted: Awaited<ReturnType<typeof getTasksByStatus>>;
  pendingEscalationsCount: number;
  triageRuns: ReturnType<typeof listTopRalphRunTriages>;
  getAlertSummary: (task: { repo: string; issue: string }) =>
    | {
        totalCount: number;
        latestSummary: string | null;
        latestAt: string | null;
        latestCommentUrl: string | null;
      }
    | null;
  control: ReturnType<typeof readControlStateSnapshot>;
};

async function collectBaseStatusData(opts?: { disableGitHubQueueSweeps?: boolean }): Promise<StatusBaseData> {
  const config = getConfig();
  const depSatisfaction = listDependencySatisfactionOverrides({ limit: 50 }).map((row) => ({
    repo: row.repo,
    issueNumber: row.issueNumber,
    createdAt: row.createdAt,
    satisfiedAt: row.satisfiedAt,
    via: row.via,
  }));
  const queueState = getQueueBackendStateWithLabelHealth();
  const parity = buildQueueParitySnapshot(config.repos.map((repo) => repo.name));

  const daemonRecord = readDaemonRecord();
  const daemon = daemonRecord
    ? {
        daemonId: daemonRecord.daemonId ?? null,
        pid: typeof daemonRecord.pid === "number" ? daemonRecord.pid : null,
        startedAt: daemonRecord.startedAt ?? null,
        version: daemonRecord.ralphVersion ?? null,
        controlFilePath: daemonRecord.controlFilePath ?? null,
        command: Array.isArray(daemonRecord.command) ? daemonRecord.command : null,
      }
    : null;

  const control = readControlStateSnapshot({ log: (message) => console.warn(message), defaults: config.control });
  const controlProfile = "";
  const requestedProfile = getRequestedOpencodeProfileName(null);

  const now = Date.now();
  const selection = await resolveOpencodeProfileForNewWork(now, requestedProfile);
  const resolvedProfile: string | null = selection.profileName;
  const throttle = selection.decision;
  const gate = computeDaemonGate({ mode: control.mode as DaemonMode, throttle, isShuttingDown: false });

  const desiredMode = computeDesiredMode({ gateReason: gate.reason, throttleState: throttle.state });
  const liveness = deriveDaemonLiveness({ desiredMode, daemonRecord });

  const { starting, inProgress, queued, throttled, blocked, pendingEscalationsCount } = await getStatusTaskSets({
    disableSweeps: opts?.disableGitHubQueueSweeps === true,
  });


  const blockedSorted = [...blocked].sort((a, b) => {
    const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDelta !== 0) return priorityDelta;
    const aTime = Date.parse(a["blocked-at"]?.trim() ?? "");
    const bTime = Date.parse(b["blocked-at"]?.trim() ?? "");
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
    if (Number.isFinite(aTime)) return -1;
    if (Number.isFinite(bTime)) return 1;
    const repoCompare = a.repo.localeCompare(b.repo);
    if (repoCompare !== 0) return repoCompare;
    return a.issue.localeCompare(b.issue);
  });

  const tasksForAlerts = [...starting, ...inProgress, ...queued, ...throttled, ...blocked];
  const issuesByRepo = new Map<string, Set<number>>();
  for (const task of tasksForAlerts) {
    const ref = parseIssueRef(task.issue, task.repo);
    if (!ref) continue;
    const set = issuesByRepo.get(ref.repo) ?? new Set<number>();
    set.add(ref.number);
    issuesByRepo.set(ref.repo, set);
  }

  const alertSummaryByKey = new Map<string, ReturnType<typeof listIssueAlertSummaries>[number]>();
  for (const [repo, numbers] of issuesByRepo.entries()) {
    const summaries = listIssueAlertSummaries({ repo, issueNumbers: [...numbers] });
    for (const summary of summaries) {
      alertSummaryByKey.set(`${summary.repo}#${summary.issueNumber}`, summary);
    }
  }

  const getAlertSummary = (task: { repo: string; issue: string }) => {
    const ref = parseIssueRef(task.issue, task.repo);
    if (!ref) return null;
    const summary = alertSummaryByKey.get(`${ref.repo}#${ref.number}`);
    if (!summary || summary.totalCount <= 0) return null;
    return {
      totalCount: summary.totalCount,
      latestSummary: summary.latestSummary ?? null,
      latestAt: summary.latestAt ?? null,
      latestCommentUrl: summary.latestCommentUrl ?? null,
    };
  };

  const triageRuns = listTopRalphRunTriages({ limit: 5, sinceDays: 14 });

  return {
    config,
    depSatisfaction,
    queueState,
    parity,
    daemon,
    desiredMode: liveness.desiredMode,
    mode: liveness.effectiveMode,
    daemonLiveness: liveness.daemonLiveness,
    controlProfile,
    requestedProfile,
    selection,
    resolvedProfile,
    throttle,
    starting,
    inProgress,
    queued,
    throttled,
    blockedSorted,
    pendingEscalationsCount,
    triageRuns,
    getAlertSummary,
    control,
  };
}

export type StatusDrainState = {
  requestedAt: number | null;
  timeoutMs: number | null;
  pauseRequested: boolean;
  pauseAtCheckpoint: string | null;
};

export async function collectStatusSnapshot(opts: { drain: StatusDrainState; initStateDb?: boolean }): Promise<StatusSnapshot> {
  const snapshot = await getStatusSnapshot();

  // Allow callers to override drain info (e.g. derived from CLI flags).
  return buildStatusSnapshot({
    ...snapshot,
    drain: {
      requestedAt: opts.drain.requestedAt ? new Date(opts.drain.requestedAt).toISOString() : null,
      timeoutMs: opts.drain.timeoutMs ?? null,
      pauseRequested: opts.drain.pauseRequested,
      pauseAtCheckpoint: opts.drain.pauseAtCheckpoint,
    },
  });
}

export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  initStateDb();
  const base = await collectBaseStatusData({ disableGitHubQueueSweeps: true });

  const inProgressWithStatus = await Promise.all(
    base.inProgress.map(async (task) => {
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
        alerts: base.getAlertSummary(task),
      };
    })
  );

  return buildStatusSnapshot({
    mode: base.mode,
    desiredMode: base.desiredMode,
    queue: {
      backend: base.queueState.backend,
      health: base.queueState.health,
      fallback: base.queueState.fallback,
      diagnostics: base.queueState.diagnostics ?? null,
    },
    parity: base.parity,
    daemon: base.daemon,
    daemonLiveness: base.daemonLiveness,
    controlProfile: base.controlProfile || null,
    activeProfile: base.resolvedProfile ?? null,
    throttle: base.throttle.snapshot,
    dependencySatisfactionOverrides: base.depSatisfaction,
    triageRuns: base.triageRuns.map((r) => ({
      runId: r.runId,
      repo: r.repo,
      issueNumber: r.issueNumber,
      outcome: r.outcome,
      score: r.score,
      reasons: r.reasons,
      tokensTotal: r.tokensTotal,
      toolCallCount: r.toolCallCount,
      wallTimeMs: r.wallTimeMs,
      computedAt: r.computedAt,
    })),
    escalations: {
      pending: base.pendingEscalationsCount,
    },
    inProgress: inProgressWithStatus,
    starting: base.starting.map((t) => ({
      name: t.name,
      repo: t.repo,
      issue: t.issue,
      priority: t.priority ?? "p2-medium",
      opencodeProfile: getTaskOpencodeProfileName(t),
      alerts: base.getAlertSummary(t),
    })),
    drain: {
      requestedAt: null,
      timeoutMs: base.control.drainTimeoutMs ?? null,
      pauseRequested: base.control.pauseRequested === true,
      pauseAtCheckpoint: base.control.pauseAtCheckpoint ?? null,
    },
    queued: base.queued.map((t) => ({
      name: t.name,
      repo: t.repo,
      issue: t.issue,
      priority: t.priority ?? "p2-medium",
      opencodeProfile: getTaskOpencodeProfileName(t),
      alerts: base.getAlertSummary(t),
    })),
    throttled: base.throttled.map((t) => ({
      name: t.name,
      repo: t.repo,
      issue: t.issue,
      priority: t.priority ?? "p2-medium",
      opencodeProfile: getTaskOpencodeProfileName(t),
      sessionId: t["session-id"]?.trim() || null,
      resumeAt: t["resume-at"]?.trim() || null,
      alerts: base.getAlertSummary(t),
    })),
    blocked: base.blockedSorted.map((t) => {
      const details = t["blocked-details"]?.trim() ?? "";
      return {
        name: t.name,
        repo: t.repo,
        issue: t.issue,
        priority: t.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(t),
        sessionId: t["session-id"]?.trim() || null,
        blockedAt: t["blocked-at"]?.trim() || null,
        blockedSource: t["blocked-source"]?.trim() || null,
        blockedReason: t["blocked-reason"]?.trim() || null,
        blockedDetailsSnippet: details ? summarizeBlockedDetailsSnippet(details) : null,
        alerts: base.getAlertSummary(t),
      };
    }),
  });
}

function buildDegradedStatusSnapshot(reason: ReturnType<typeof classifyDurableStateInitError>): StatusSnapshot {
  const config = getConfig();
  const queueState = getQueueBackendStateWithLabelHealth();
  const daemonRecord = readDaemonRecord();
  const daemon = daemonRecord
    ? {
        daemonId: daemonRecord.daemonId ?? null,
        pid: typeof daemonRecord.pid === "number" ? daemonRecord.pid : null,
        startedAt: daemonRecord.startedAt ?? null,
        version: daemonRecord.ralphVersion ?? null,
        controlFilePath: daemonRecord.controlFilePath ?? null,
        command: Array.isArray(daemonRecord.command) ? daemonRecord.command : null,
      }
    : null;
  const control = readControlStateSnapshot({ log: (message) => console.warn(message), defaults: config.control });

  return buildStatusSnapshot({
    mode: control.mode,
    desiredMode: control.mode,
    durableState: {
      ok: false,
      code: reason.code,
      message: reason.message,
      schemaVersion: reason.schemaVersion,
      supportedRange: reason.supportedRange,
    },
    queue: {
      backend: queueState.backend,
      health: queueState.health,
      fallback: queueState.fallback,
      diagnostics: queueState.diagnostics ?? null,
    },
    daemon,
    controlProfile: null,
    activeProfile: null,
    throttle: {},
    escalations: { pending: 0 },
    inProgress: [],
    starting: [],
    queued: [],
    throttled: [],
    blocked: [],
    drain: {
      requestedAt: null,
      timeoutMs: control.drainTimeoutMs ?? null,
      pauseRequested: control.pauseRequested === true,
      pauseAtCheckpoint: control.pauseAtCheckpoint ?? null,
    },
  });
}

export async function getStatusSnapshotBestEffort(): Promise<StatusSnapshot> {
  const probe = probeDurableState();
  if (!probe.ok) return buildDegradedStatusSnapshot(probe);

  try {
    return await getStatusSnapshot();
  } catch (error) {
    const reason = classifyDurableStateInitError(error);
    return buildDegradedStatusSnapshot(reason);
  }
}

export async function runStatusCommand(opts: { args: string[]; drain: StatusDrainState }): Promise<void> {
  const json = opts.args.includes("--json");

  // Status reads from the durable SQLite state DB (GitHub issue snapshots, task op
  // state, idempotency). The daemon initializes this during startup, but CLI
  // subcommands need to do it explicitly.
  initStateDb();
  const base = await collectBaseStatusData();

  const profileNames = isOpencodeProfilesEnabled() ? listOpencodeProfileNames() : [];
  const usageRows = await collectStatusUsageRows({
    profiles: profileNames,
    activeProfile: base.resolvedProfile,
    activeDecision: base.throttle,
    decide: (profileKey) => getThrottleDecision(Date.now(), { opencodeProfile: profileKey }),
    concurrency: STATUS_USAGE_CONCURRENCY,
    timeoutMs: STATUS_USAGE_TIMEOUT_MS,
  });

  if (json) {
    const inProgressWithStatus = await Promise.all(
      base.inProgress.map(async (task) => {
        const sessionId = task["session-id"]?.trim() || null;
        const nowDoing = sessionId ? await getSessionNowDoing(sessionId) : null;
        const opencodeProfile = getTaskOpencodeProfileName(task);
        const tokens = await readRunTokenTotals({
          repo: task.repo,
          issue: task.issue,
          opencodeProfile,
          timeoutMs: STATUS_TOKEN_TIMEOUT_MS,
          concurrency: STATUS_TOKEN_CONCURRENCY,
          budgetMs: STATUS_TOKEN_BUDGET_MS,
        });
        return {
          name: task.name,
          repo: task.repo,
          issue: task.issue,
          priority: task.priority ?? "p2-medium",
          opencodeProfile,
          sessionId,
          nowDoing,
          line: sessionId && nowDoing ? formatNowDoingLine(nowDoing, formatTaskLabel(task)) : null,
          tokensTotal: tokens.tokensTotal,
          tokensComplete: tokens.tokensComplete,
          alerts: base.getAlertSummary(task),
        };
      })
    );

    const snapshot = buildStatusSnapshot({
      mode: base.mode,
      desiredMode: base.desiredMode,
      queue: {
        backend: base.queueState.backend,
        health: base.queueState.health,
        fallback: base.queueState.fallback,
        diagnostics: base.queueState.diagnostics ?? null,
      },
      parity: base.parity,
      daemon: base.daemon,
      daemonLiveness: base.daemonLiveness,
      controlProfile: base.controlProfile || null,
      activeProfile: base.resolvedProfile ?? null,
      throttle: base.throttle.snapshot,
      usage: { profiles: usageRows },
      dependencySatisfactionOverrides: base.depSatisfaction,
      triageRuns: base.triageRuns.map((r) => ({
        runId: r.runId,
        repo: r.repo,
        issueNumber: r.issueNumber,
        outcome: r.outcome,
        score: r.score,
        reasons: r.reasons,
        tokensTotal: r.tokensTotal,
        toolCallCount: r.toolCallCount,
        wallTimeMs: r.wallTimeMs,
        computedAt: r.computedAt,
      })),
      escalations: {
        pending: base.pendingEscalationsCount,
      },
      inProgress: inProgressWithStatus,
      starting: base.starting.map((t) => ({
        name: t.name,
        repo: t.repo,
        issue: t.issue,
        priority: t.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(t),
        alerts: base.getAlertSummary(t),
      })),
      drain: {
        requestedAt: opts.drain.requestedAt ? new Date(opts.drain.requestedAt).toISOString() : null,
        timeoutMs: opts.drain.timeoutMs ?? null,
        pauseRequested: opts.drain.pauseRequested,
        pauseAtCheckpoint: opts.drain.pauseAtCheckpoint,
      },
      queued: base.queued.map((t) => ({
        name: t.name,
        repo: t.repo,
        issue: t.issue,
        priority: t.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(t),
        alerts: base.getAlertSummary(t),
      })),
      throttled: base.throttled.map((t) => ({
        name: t.name,
        repo: t.repo,
        issue: t.issue,
        priority: t.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(t),
        sessionId: t["session-id"]?.trim() || null,
        resumeAt: t["resume-at"]?.trim() || null,
        alerts: base.getAlertSummary(t),
      })),
      blocked: base.blockedSorted.map((t) => {
        const details = t["blocked-details"]?.trim() ?? "";
        return {
          name: t.name,
          repo: t.repo,
          issue: t.issue,
          priority: t.priority ?? "p2-medium",
          opencodeProfile: getTaskOpencodeProfileName(t),
          sessionId: t["session-id"]?.trim() || null,
          blockedAt: t["blocked-at"]?.trim() || null,
          blockedSource: t["blocked-source"]?.trim() || null,
          blockedReason: t["blocked-reason"]?.trim() || null,
          blockedDetailsSnippet: details ? summarizeBlockedDetailsSnippet(details) : null,
          alerts: base.getAlertSummary(t),
        };
      }),
    });

    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  }

  console.log(`Mode: ${base.mode}`);
  if (base.desiredMode !== base.mode) {
    console.log(`Desired mode: ${base.desiredMode}`);
  }
  const statusTags = [
    base.queueState.health === "degraded" ? "degraded" : null,
    base.queueState.fallback ? "fallback" : null,
  ].filter(Boolean);
  const statusSuffix = statusTags.length > 0 ? ` (${statusTags.join(", ")})` : "";
  console.log(`Queue backend: ${base.queueState.backend}${statusSuffix}`);
  if (base.queueState.diagnostics) {
    console.log(`Queue diagnostics: ${base.queueState.diagnostics}`);
  }
  console.log(
    `Queue parity: ghQueued/localBlocked=${base.parity.ghQueuedLocalBlocked} multiStatus=${base.parity.multiStatusLabels} missingStatus=${base.parity.missingStatusWithOpState}`
  );
  if (base.parity.ghQueuedLocalBlocked > 0) {
    const samples = base.parity.repos.flatMap((repo) => repo.sampleGhQueuedLocalBlocked).slice(0, 5);
    if (samples.length > 0) {
      console.log(`Queue parity samples: ${samples.join(", ")}`);
    }
  }

  if (base.daemon) {
    const version = base.daemon.version ?? "unknown";
    console.log(`Daemon: id=${base.daemon.daemonId ?? "unknown"} pid=${base.daemon.pid ?? "unknown"} version=${version}`);
  }
  const daemonLivenessLine = formatDaemonLivenessLine(base.daemonLiveness);
  if (daemonLivenessLine) console.log(daemonLivenessLine);

  if (opts.drain.pauseRequested) {
    console.log(
      `Pause requested: true${opts.drain.pauseAtCheckpoint ? ` (checkpoint: ${opts.drain.pauseAtCheckpoint})` : ""}`
    );
  }
  const activeProfileLine = formatActiveOpencodeProfileLine({
    requestedProfile: base.requestedProfile,
    resolvedProfile: base.resolvedProfile,
    selectionSource: base.selection.source,
  });
  if (activeProfileLine) console.log(activeProfileLine);

  const usageLines = formatStatusUsageSection(usageRows);
  for (const line of usageLines) console.log(line);

  console.log(`Escalations: ${base.pendingEscalationsCount} pending`);

  console.log(`Dependency satisfaction overrides: ${base.depSatisfaction.length}`);
  for (const row of base.depSatisfaction.slice(0, 10)) {
    const when = row.satisfiedAt ?? row.createdAt;
    const via = row.via ? ` via=${row.via}` : "";
    console.log(`  - ${row.repo}#${row.issueNumber} at=${when}${via}`);
  }

  if (base.triageRuns.length > 0) {
    console.log(`Triage runs (last 14d): ${base.triageRuns.length}`);
    for (const run of base.triageRuns) {
      const issueLabel = run.issueNumber ? `#${run.issueNumber}` : "(no issue)";
      const runShort = run.runId.slice(0, 8);
      const reasons = run.reasons.length > 0 ? run.reasons.join(",") : "(none)";
      console.log(
        `  - score=${run.score} outcome=${run.outcome ?? "unknown"} ${run.repo}${issueLabel} run=${runShort} reasons=${reasons}`
      );
    }
  }
  console.log(`Starting tasks: ${base.starting.length}`);
  for (const task of base.starting) {
    console.log(`  - ${await getTaskNowDoingLine(task)}`);
  }

  console.log(`In-progress tasks: ${base.inProgress.length}`);
  for (const task of base.inProgress) {
    const ttlMs = base.config.ownershipTtlMs;
    const sessionId = task["session-id"]?.trim() ?? "";
    const heartbeatAt = task["heartbeat-at"]?.trim() ?? "";
    const owner = task["daemon-id"]?.trim() ?? "";
    const heartbeatMs = parseHeartbeatMs(heartbeatAt);
    const heartbeatAge = heartbeatMs ? formatDuration(Date.now() - heartbeatMs) : heartbeatAt ? "invalid" : "missing";
    const orphanReason = !sessionId
      ? "missing-session-id"
      : isHeartbeatStale(heartbeatAt, Date.now(), ttlMs)
        ? "stale-heartbeat"
        : null;

    const opencodeProfile = getTaskOpencodeProfileName(task);
    const tokens = await readRunTokenTotals({
      repo: task.repo,
      issue: task.issue,
      opencodeProfile,
      timeoutMs: STATUS_TOKEN_TIMEOUT_MS,
      concurrency: STATUS_TOKEN_CONCURRENCY,
      budgetMs: STATUS_TOKEN_BUDGET_MS,
    });
    const tokensLabel = tokens.tokensComplete && typeof tokens.tokensTotal === "number" ? tokens.tokensTotal : "?";

    const statusBits: string[] = [];
    if (owner) statusBits.push(`owner=${owner}`);
    statusBits.push(`hb=${heartbeatAge}`);
    if (orphanReason) statusBits.push(`orphan=${orphanReason}`);
    const statusSuffix = statusBits.length > 0 ? ` ${statusBits.join(" ")}` : "";

    console.log(`  - ${await getTaskNowDoingLine(task)} tokens=${tokensLabel}${statusSuffix}`);
  }

  console.log(`Blocked tasks: ${base.blockedSorted.length}`);
  for (const task of base.blockedSorted) {
    const reason = task["blocked-reason"]?.trim() || "(no reason)";
    const source = task["blocked-source"]?.trim();
    const idleSuffix = formatBlockedIdleSuffix(task);
    const sourceSuffix = source ? ` source=${source}` : "";
    const alerts = base.getAlertSummary(task);
    const alertSummary = alerts?.latestSummary ? ` latest="${alerts.latestSummary}"` : "";
    const alertSuffix = alerts ? ` alerts=${alerts.totalCount}${alertSummary}` : "";
    console.log(
      `  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}] reason=${reason}${sourceSuffix}${idleSuffix}${alertSuffix}`
    );
  }

  console.log(`Queued tasks: ${base.queued.length}`);
  for (const task of base.queued) {
    console.log(`  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}]`);
  }

  console.log(`Throttled tasks: ${base.throttled.length}`);
  for (const task of base.throttled) {
    const resumeAt = task["resume-at"]?.trim() || "unknown";
    console.log(`  - ${task.name} (${task.repo}) resumeAt=${resumeAt} [${task.priority || "p2-medium"}]`);
  }

  process.exit(0);
}
