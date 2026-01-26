import {
  getConfig,
  getOpencodeDefaultProfileName,
  isOpencodeProfilesEnabled,
  listOpencodeProfileNames,
} from "../config";
import { readControlStateSnapshot, type DaemonMode } from "../drain";
import { readDaemonRecord } from "../daemon-record";
import { getEscalationsByStatus } from "../escalation-notes";
import { getSessionNowDoing } from "../live-status";
import { resolveOpencodeProfileForNewWork } from "../opencode-auto-profile";
import { getQueueBackendState, getQueuedTasks, getTasksByStatus } from "../queue-backend";
import { priorityRank } from "../queue/priority";
import { buildStatusSnapshot, type StatusSnapshot } from "../status-snapshot";
import { collectStatusUsageRows, formatStatusUsageSection } from "../status-usage";
import { formatNowDoingLine } from "../live-status";
import { initStateDb } from "../state";
import { getThrottleDecision } from "../throttle";
import { computeDaemonGate } from "../daemon-gate";
import { formatDuration } from "../logging";
import { formatTaskLabel, getTaskOpencodeProfileName, summarizeBlockedDetailsSnippet } from "../status-utils";

const STATUS_USAGE_TIMEOUT_MS = 10_000;
const STATUS_USAGE_CONCURRENCY = 2;

export type StatusDrainState = {
  requestedAt?: number | null;
  timeoutMs?: number | null;
  pauseRequested?: boolean;
  pauseAtCheckpoint?: string | null;
};

function resolveDrainState(
  control: ReturnType<typeof readControlStateSnapshot>,
  opts?: StatusDrainState
): Required<StatusDrainState> {
  return {
    requestedAt: opts?.requestedAt ?? null,
    timeoutMs: opts?.timeoutMs ?? control.drainTimeoutMs ?? null,
    pauseRequested: opts?.pauseRequested ?? control.pauseRequested === true,
    pauseAtCheckpoint: opts?.pauseAtCheckpoint ?? control.pauseAtCheckpoint ?? null,
  };
}

export async function getStatusSnapshot(opts?: { drain?: StatusDrainState }): Promise<StatusSnapshot> {
  const config = getConfig();
  const queueState = getQueueBackendState();

  initStateDb();

  const control = readControlStateSnapshot({ log: (message) => console.warn(message), defaults: config.control });
  const drain = resolveDrainState(control, opts?.drain);
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

  const inProgressWithStatus = await Promise.all(
    inProgress.map(async (task) => {
      const sessionId = task["session-id"]?.trim() || null;
      const label = formatTaskLabel(task);
      const nowDoing = sessionId ? await getSessionNowDoing(sessionId) : null;
      const line = sessionId
        ? nowDoing
          ? formatNowDoingLine(nowDoing, label)
          : `${label} — waiting (no events yet)`
        : `${label} — starting session...`;
      return {
        name: task.name,
        repo: task.repo,
        issue: task.issue,
        priority: task.priority ?? "p2-medium",
        opencodeProfile: getTaskOpencodeProfileName(task),
        sessionId,
        nowDoing,
        line,
      };
    })
  );

  const daemonRecord = readDaemonRecord();
  const daemon = daemonRecord
    ? {
        daemonId: daemonRecord.daemonId,
        pid: daemonRecord.pid,
        startedAt: daemonRecord.startedAt,
        version: daemonRecord.ralphVersion ?? null,
        controlFilePath: daemonRecord.controlFilePath,
        command: daemonRecord.command,
      }
    : null;

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
      requestedAt: drain.requestedAt ? new Date(drain.requestedAt).toISOString() : null,
      timeoutMs: drain.timeoutMs ?? null,
      pauseRequested: drain.pauseRequested,
      pauseAtCheckpoint: drain.pauseAtCheckpoint,
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

export async function runStatusCommand(opts: { args: string[]; drain?: StatusDrainState }): Promise<void> {
  const json = opts.args.includes("--json");
  const snapshot = await getStatusSnapshot({ drain: opts.drain });

  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(`Mode: ${snapshot.mode}`);
  const statusTags = [
    snapshot.queue.health === "degraded" ? "degraded" : null,
    snapshot.queue.fallback ? "fallback" : null,
  ].filter(Boolean);
  const statusSuffix = statusTags.length > 0 ? ` (${statusTags.join(", ")})` : "";
  console.log(`Queue backend: ${snapshot.queue.backend}${statusSuffix}`);
  if (snapshot.queue.diagnostics) {
    console.log(`Queue diagnostics: ${snapshot.queue.diagnostics}`);
  }

  if (snapshot.daemon) {
    const version = snapshot.daemon.version ?? "unknown";
    console.log(
      `Daemon: id=${snapshot.daemon.daemonId ?? "unknown"} pid=${snapshot.daemon.pid ?? "unknown"} version=${version}`
    );
  }

  if (snapshot.drain.pauseRequested) {
    console.log(
      `Pause requested: true${snapshot.drain.pauseAtCheckpoint ? ` (checkpoint: ${snapshot.drain.pauseAtCheckpoint})` : ""}`
    );
  }

  if (snapshot.controlProfile === "auto") {
    console.log(`Active OpenCode profile: auto (resolved: ${snapshot.activeProfile ?? "ambient"})`);
  } else if (snapshot.activeProfile) {
    console.log(`Active OpenCode profile: ${snapshot.activeProfile}`);
  }

  const usageLines = formatStatusUsageSection(snapshot.usage?.profiles ?? []);
  for (const line of usageLines) console.log(line);

  console.log(`Escalations: ${snapshot.escalations.pending} pending`);
  console.log(`Starting tasks: ${snapshot.starting.length}`);
  for (const task of snapshot.starting) {
    const label = formatTaskLabel(task);
    console.log(`  - ${label} — starting session...`);
  }

  console.log(`In-progress tasks: ${snapshot.inProgress.length}`);
  for (const task of snapshot.inProgress) {
    console.log(`  - ${task.line ?? formatTaskLabel(task)}`);
  }

  console.log(`Blocked tasks: ${snapshot.blocked.length}`);
  for (const task of snapshot.blocked) {
    const reason = task.blockedReason ?? "(no reason)";
    const sourceSuffix = task.blockedSource ? ` source=${task.blockedSource}` : "";
    let idleSuffix = "";
    if (task.blockedAt) {
      const blockedAtMs = Date.parse(task.blockedAt);
      if (Number.isFinite(blockedAtMs)) {
        idleSuffix = ` [idle ${formatDuration(Date.now() - blockedAtMs)}]`;
      }
    }
    console.log(
      `  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}] reason=${reason}${sourceSuffix}${idleSuffix}`
    );
  }

  console.log(`Queued tasks: ${snapshot.queued.length}`);
  for (const task of snapshot.queued) {
    console.log(`  - ${task.name} (${task.repo}) [${task.priority || "p2-medium"}]`);
  }

  console.log(`Throttled tasks: ${snapshot.throttled.length}`);
  for (const task of snapshot.throttled) {
    const resumeAt = task.resumeAt ?? "unknown";
    console.log(`  - ${task.name} (${task.repo}) resumeAt=${resumeAt} [${task.priority || "p2-medium"}]`);
  }
}
