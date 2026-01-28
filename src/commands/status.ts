import { getConfig, getOpencodeDefaultProfileName, isOpencodeProfilesEnabled, listOpencodeProfileNames } from "../config";
import { readControlStateSnapshot, type DaemonMode } from "../drain";
import { readDaemonRecord } from "../daemon-record";
import { getEscalationsByStatus } from "../escalation-notes";
import { getSessionNowDoing } from "../live-status";
import { resolveOpencodeProfileForNewWork } from "../opencode-auto-profile";
import { getQueueBackendState, getQueuedTasks, getTasksByStatus } from "../queue-backend";
import { priorityRank } from "../queue/priority";
import { buildStatusSnapshot, type StatusSnapshot } from "../status-snapshot";
import { collectStatusUsageRows, formatStatusUsageSection } from "../status-usage";
import { readRunTokenTotals, type SessionTokenReadResult } from "../status-run-tokens";
import { formatNowDoingLine } from "../live-status";
import { initStateDb, listIssueAlertSummaries } from "../state";
import { getThrottleDecision } from "../throttle";
import { computeDaemonGate } from "../daemon-gate";
import { parseIssueRef } from "../github/issue-ref";
import {
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

type StatusDrainState = {
  requestedAt: number | null;
  timeoutMs: number | null;
  pauseRequested: boolean;
  pauseAtCheckpoint: string | null;
};

export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const config = getConfig();
  const queueState = getQueueBackendState();

  initStateDb();

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
  const controlProfile = control.opencodeProfile?.trim() || "";

  const requestedProfile =
    controlProfile === "auto" ? "auto" : controlProfile || getOpencodeDefaultProfileName() || null;

  const now = Date.now();
  const selection = await resolveOpencodeProfileForNewWork(now, requestedProfile);
  const resolvedProfile: string | null = selection.profileName;
  const throttle = selection.decision;
  const gate = computeDaemonGate({ mode: control.mode as DaemonMode, throttle, isShuttingDown: false });

  const mode = gate.reason === "hard-throttled"
    ? "hard-throttled"
    : gate.reason === "paused"
      ? "paused"
      : gate.reason === "draining"
        ? "draining"
        : throttle.state === "soft"
          ? "soft-throttled"
          : "running";

  const [starting, inProgress, queued, throttled, blocked, pendingEscalations] = await Promise.all([
    getTasksByStatus("starting"),
    getTasksByStatus("in-progress"),
    getQueuedTasks(),
    getTasksByStatus("throttled"),
    getTasksByStatus("blocked"),
    getEscalationsByStatus("pending"),
  ]);

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
        alerts: getAlertSummary(task),
      };
    })
  );

  return buildStatusSnapshot({
    mode,
    queue: {
      backend: queueState.backend,
      health: queueState.health,
      fallback: queueState.fallback,
      diagnostics: queueState.diagnostics ?? null,
    },
    daemon,
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
      alerts: getAlertSummary(t),
    })),
    drain: {
      requestedAt: null,
      timeoutMs: control.drainTimeoutMs ?? null,
      pauseRequested: control.pauseRequested === true,
      pauseAtCheckpoint: control.pauseAtCheckpoint ?? null,
    },
    queued: queued.map((t) => ({
      name: t.name,
      repo: t.repo,
      issue: t.issue,
      priority: t.priority ?? "p2-medium",
      opencodeProfile: getTaskOpencodeProfileName(t),
      alerts: getAlertSummary(t),
    })),
    throttled: throttled.map((t) => ({
      name: t.name,
      repo: t.repo,
      issue: t.issue,
      priority: t.priority ?? "p2-medium",
      opencodeProfile: getTaskOpencodeProfileName(t),
      sessionId: t["session-id"]?.trim() || null,
      resumeAt: t["resume-at"]?.trim() || null,
      alerts: getAlertSummary(t),
    })),
    blocked: blockedSorted.map((t) => {
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
        alerts: getAlertSummary(t),
      };
    }),
  });
}

export async function runStatusCommand(opts: { args: string[]; drain: StatusDrainState }): Promise<void> {
  const json = opts.args.includes("--json");

  const config = getConfig();
  const queueState = getQueueBackendState();

  // Status reads from the durable SQLite state DB (GitHub issue snapshots, task op
  // state, idempotency). The daemon initializes this during startup, but CLI
  // subcommands need to do it explicitly.
  initStateDb();

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
  const controlProfile = control.opencodeProfile?.trim() || "";

  const requestedProfile =
    controlProfile === "auto" ? "auto" : controlProfile || getOpencodeDefaultProfileName() || null;

  const now = Date.now();
  const selection = await resolveOpencodeProfileForNewWork(now, requestedProfile);
  const resolvedProfile: string | null = selection.profileName;
  const throttle = selection.decision;
  const gate = computeDaemonGate({ mode: control.mode as DaemonMode, throttle, isShuttingDown: false });

  const mode = gate.reason === "hard-throttled"
    ? "hard-throttled"
    : gate.reason === "paused"
      ? "paused"
      : gate.reason === "draining"
        ? "draining"
        : throttle.state === "soft"
          ? "soft-throttled"
          : "running";

  const [starting, inProgress, queued, throttled, blocked, pendingEscalations] = await Promise.all([
    getTasksByStatus("starting"),
    getTasksByStatus("in-progress"),
    getQueuedTasks(),
    getTasksByStatus("throttled"),
    getTasksByStatus("blocked"),
    getEscalationsByStatus("pending"),
  ]);

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

  const profileNames = isOpencodeProfilesEnabled() ? listOpencodeProfileNames() : [];
  const usageRows = await collectStatusUsageRows({
    profiles: profileNames,
    activeProfile: resolvedProfile,
    activeDecision: throttle,
    decide: (profileKey) => getThrottleDecision(now, { opencodeProfile: profileKey }),
    concurrency: STATUS_USAGE_CONCURRENCY,
    timeoutMs: STATUS_USAGE_TIMEOUT_MS,
  });

  if (json) {
    const tokenReadCache = new Map<string, Promise<SessionTokenReadResult>>();
    const inProgressWithStatus = await Promise.all(
      inProgress.map(async (task) => {
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
          cache: tokenReadCache,
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
          alerts: getAlertSummary(task),
        };
      })
    );

    const snapshot = buildStatusSnapshot({
      mode,
      queue: {
        backend: queueState.backend,
        health: queueState.health,
        fallback: queueState.fallback,
        diagnostics: queueState.diagnostics ?? null,
      },
      daemon,
      controlProfile: controlProfile || null,
      activeProfile: resolvedProfile ?? null,
      throttle: throttle.snapshot,
      usage: { profiles: usageRows },
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
        alerts: getAlertSummary(t),
      })),
      drain: {
        requestedAt: opts.drain.requestedAt ? new Date(opts.drain.requestedAt).toISOString() : null,
        timeoutMs: opts.drain.timeoutMs ?? null,
        pauseRequested: opts.drain.pauseRequested,
        pauseAtCheckpoint: opts.drain.pauseAtCheckpoint,
      },
      queued: queued.map((t) => ({
        name: t.name,
        repo: t.repo,
        issue: t.issue,
        priority: t.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(t),
        alerts: getAlertSummary(t),
      })),
      throttled: throttled.map((t) => ({
        name: t.name,
        repo: t.repo,
        issue: t.issue,
        priority: t.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(t),
        sessionId: t["session-id"]?.trim() || null,
        resumeAt: t["resume-at"]?.trim() || null,
        alerts: getAlertSummary(t),
      })),
      blocked: blockedSorted.map((t) => {
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
          alerts: getAlertSummary(t),
        };
      }),
    });

    console.log(JSON.stringify(snapshot, null, 2));
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

  if (daemon) {
    const version = daemon.version ?? "unknown";
    console.log(`Daemon: id=${daemon.daemonId ?? "unknown"} pid=${daemon.pid ?? "unknown"} version=${version}`);
  }

  if (opts.drain.pauseRequested) {
    console.log(
      `Pause requested: true${opts.drain.pauseAtCheckpoint ? ` (checkpoint: ${opts.drain.pauseAtCheckpoint})` : ""}`
    );
  }
  if (controlProfile === "auto") {
    console.log(`Active OpenCode profile: auto (resolved: ${resolvedProfile ?? "ambient"})`);
  } else if (selection.source === "failover") {
    console.log(`Active OpenCode profile: ${resolvedProfile ?? "ambient"} (failover from: ${requestedProfile ?? "default"})`);
  } else if (resolvedProfile) {
    console.log(`Active OpenCode profile: ${resolvedProfile}`);
  }

  const usageLines = formatStatusUsageSection(usageRows);
  for (const line of usageLines) console.log(line);

  console.log(`Escalations: ${pendingEscalations.length} pending`);
  console.log(`Starting tasks: ${starting.length}`);
  for (const task of starting) {
    console.log(`  - ${await getTaskNowDoingLine(task)}`);
  }

  console.log(`In-progress tasks: ${inProgress.length}`);
  const tokenReadCache = new Map<string, Promise<SessionTokenReadResult>>();
  for (const task of inProgress) {
    const opencodeProfile = getTaskOpencodeProfileName(task);
    const tokens = await readRunTokenTotals({
      repo: task.repo,
      issue: task.issue,
      opencodeProfile,
      timeoutMs: STATUS_TOKEN_TIMEOUT_MS,
      concurrency: STATUS_TOKEN_CONCURRENCY,
      budgetMs: STATUS_TOKEN_BUDGET_MS,
      cache: tokenReadCache,
    });
    const tokensLabel = tokens.tokensComplete && typeof tokens.tokensTotal === "number" ? tokens.tokensTotal : "?";
    console.log(`  - ${await getTaskNowDoingLine(task)} tokens=${tokensLabel}`);
  }

  console.log(`Blocked tasks: ${blockedSorted.length}`);
  for (const task of blockedSorted) {
    const reason = task["blocked-reason"]?.trim() || "(no reason)";
    const source = task["blocked-source"]?.trim();
    const idleSuffix = formatBlockedIdleSuffix(task);
    const sourceSuffix = source ? ` source=${source}` : "";
    const alerts = getAlertSummary(task);
    const alertSummary = alerts?.latestSummary ? ` latest="${alerts.latestSummary}"` : "";
    const alertSuffix = alerts ? ` alerts=${alerts.totalCount}${alertSummary}` : "";
    console.log(
      `  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}] reason=${reason}${sourceSuffix}${idleSuffix}${alertSuffix}`
    );
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
