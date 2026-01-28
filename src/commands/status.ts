import { getConfig, getOpencodeDefaultProfileName, isOpencodeProfilesEnabled, listOpencodeProfileNames } from "../config";
import { readControlStateSnapshot, type DaemonMode } from "../drain";
import { getEscalationsByStatus } from "../escalation-notes";
import { getSessionNowDoing } from "../live-status";
import { resolveOpencodeProfileForNewWork } from "../opencode-auto-profile";
import { getQueueBackendState, getQueuedTasks, getTasksByStatus } from "../queue-backend";
import { priorityRank } from "../queue/priority";
import { buildStatusSnapshot } from "../status-snapshot";
import { collectStatusUsageRows, formatStatusUsageSection } from "../status-usage";
import { readRunTokenTotals, type SessionTokenReadResult } from "../status-run-tokens";
import { formatNowDoingLine } from "../live-status";
import { initStateDb } from "../state";
import { getThrottleDecision } from "../throttle";
import { computeDaemonGate } from "../daemon-gate";
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

export type StatusDrainState = {
  requestedAt: number | null;
  timeoutMs: number | null;
  pauseRequested: boolean;
  pauseAtCheckpoint: string | null;
};

export async function collectStatusSnapshot(opts: {
  drain: StatusDrainState;
  initStateDb?: boolean;
}): Promise<ReturnType<typeof buildStatusSnapshot>> {
  if (opts.initStateDb) initStateDb();

  const config = getConfig();
  const queueState = getQueueBackendState();

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

  const profileNames = isOpencodeProfilesEnabled() ? listOpencodeProfileNames() : [];
  const usageRows = await collectStatusUsageRows({
    profiles: profileNames,
    activeProfile: resolvedProfile,
    activeDecision: throttle,
    decide: (profileKey) => getThrottleDecision(now, { opencodeProfile: profileKey }),
    concurrency: STATUS_USAGE_CONCURRENCY,
    timeoutMs: STATUS_USAGE_TIMEOUT_MS,
  });

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
      };
    }),
  });
}

export async function runStatusCommand(opts: { args: string[]; drain: StatusDrainState }): Promise<void> {
  const json = opts.args.includes("--json");

  if (json) {
    // Status reads from the durable SQLite state DB (GitHub issue snapshots, task op
    // state, idempotency). The daemon initializes this during startup, but CLI
    // subcommands need to do it explicitly.
    initStateDb();
    const snapshot = await collectStatusSnapshot({ drain: opts.drain, initStateDb: false });
    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  }

  const config = getConfig();
  const queueState = getQueueBackendState();

  // Status reads from the durable SQLite state DB (GitHub issue snapshots, task op
  // state, idempotency). The daemon initializes this during startup, but CLI
  // subcommands need to do it explicitly.
  initStateDb();

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

  const profileNames = isOpencodeProfilesEnabled() ? listOpencodeProfileNames() : [];
  const usageRows = await collectStatusUsageRows({
    profiles: profileNames,
    activeProfile: resolvedProfile,
    activeDecision: throttle,
    decide: (profileKey) => getThrottleDecision(now, { opencodeProfile: profileKey }),
    concurrency: STATUS_USAGE_CONCURRENCY,
    timeoutMs: STATUS_USAGE_TIMEOUT_MS,
  });

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
    console.log(
      `  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}] reason=${reason}${sourceSuffix}${idleSuffix}`
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
