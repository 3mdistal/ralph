import { getConfig } from "../config";
import { shouldLog } from "../logging";
import {
  getIdempotencyPayload,
  getIssueLabels,
  hasIdempotencyKey,
  recordIdempotencyKey,
  recordIssueLabelsSnapshot,
  releaseTaskSlot,
  upsertIdempotencyKey,
} from "../state";
import {
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_STOP,
  RALPH_LABEL_STATUS_ESCALATED,
  RALPH_LABEL_STATUS_PAUSED,
  RALPH_LABEL_STATUS_QUEUED,
  RALPH_LABEL_STATUS_STOPPED,
} from "../github-labels";
import { statusToRalphLabelDelta } from "../github-queue/core";
import { GitHubClient, splitRepoFullName } from "./client";
import { createRalphWorkflowLabelsEnsurer } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps, planIssueLabelOps } from "./issue-label-io";
import {
  buildCmdCommentBody,
  createCmdComment,
  findCmdComment,
  type CmdCommentState,
  updateCmdComment,
} from "./cmd-comment";
import { listIssueSnapshotsWithRalphLabels } from "../state";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ISSUES_PER_TICK = 25;
const TELEMETRY_PREFIX = "[ralph:cmd]";

const CMD_LABEL_ORDER = [
  RALPH_LABEL_CMD_STOP,
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_QUEUE,
] as const;

type CmdLabel = (typeof CMD_LABEL_ORDER)[number];

type CmdRecord = {
  version: 1;
  phase: "started" | "completed";
  repo: string;
  issueNumber: number;
  cmdLabel: string;
  eventId: string | null;
  startedAt: string;
  completedAt?: string;
  decision?: "applied" | "refused" | "failed";
  reason?: string;
};

type IssueTimelineLabelEvent = {
  id?: number | string | null;
  event?: string | null;
  label?: { name?: string | null } | null;
};

type LabelEventSummary = {
  latestLabeledEventId: string | null;
  latestUnlabeledEventId: string | null;
  activeLabeledEventId: string | null;
};

type QueueOnEscalatedDecision = { outcome: "apply" | "refuse" | "unknown"; reason?: string };

const CMD_LIVE_LABELS_TELEMETRY_SOURCE = "cmd-live-labels";

function nowIso(): string {
  return new Date().toISOString();
}

function buildCmdEventKey(params: { repo: string; issueNumber: number; cmdLabel: string; eventId: string | null }): string {
  const event = params.eventId ? params.eventId.trim() : "unknown";
  return `ralph:cmd:v1:${params.repo}#${params.issueNumber}:${params.cmdLabel}:${event}`;
}

function buildSatisfactionKey(repo: string, issueNumber: number): string {
  return `ralph:satisfy:v1:${repo}#${issueNumber}`;
}

function buildQueueLabelDelta(currentLabels: string[]): { add: string[]; remove: string[] } {
  // Queue command must reliably clear stop-switch labels even if local snapshot labels are stale.
  const withForcedRemovals = [
    ...currentLabels,
    RALPH_LABEL_STATUS_PAUSED,
    RALPH_LABEL_STATUS_ESCALATED,
    RALPH_LABEL_STATUS_STOPPED,
  ];
  // Force-add queued even if local snapshots claim it already exists.
  // This prevents a cmd:queue from being "processed" while leaving the issue without any status label.
  const labelsForDelta = withForcedRemovals.filter((label) => label !== RALPH_LABEL_STATUS_QUEUED);
  return statusToRalphLabelDelta("queued", labelsForDelta);
}

async function fetchLiveIssueLabelsBestEffort(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  fallback: string[];
}): Promise<string[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    const response = await params.github.request<Array<{ name?: string | null }>>(
      `/repos/${owner}/${name}/issues/${params.issueNumber}/labels?per_page=100`,
      { source: CMD_LIVE_LABELS_TELEMETRY_SOURCE }
    );
    if (!Array.isArray(response.data)) {
      throw new Error("Unexpected GitHub label list response");
    }
    const rows = response.data;
    const labels = rows.map((label) => label?.name ?? "").filter(Boolean);
    return labels;
  } catch (error: any) {
    if (shouldLog(`ralph:cmd:live-labels:${params.repo}#${params.issueNumber}`, 60_000)) {
      const message = error?.message ?? String(error);
      console.warn(
        `${TELEMETRY_PREFIX} ${params.repo}#${params.issueNumber} live-label-fetch-failed: ${message} (falling back to snapshot)`
      );
    }
    return [...params.fallback];
  }
}

function applyLabelDeltaSnapshot(params: {
  repo: string;
  issueNumber: number;
  add: string[];
  remove: string[];
  nowIso: string;
}): void {
  const current = getIssueLabels(params.repo, params.issueNumber);
  const set = new Set(current);
  for (const label of params.remove) set.delete(label);
  for (const label of params.add) set.add(label);
  recordIssueLabelsSnapshot({
    repo: params.repo,
    issue: `${params.repo}#${params.issueNumber}`,
    labels: Array.from(set),
    at: params.nowIso,
  });
}

function parseEventIdBigInt(value: string | null | undefined): bigint | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function toEventIdString(value: number | string | null | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? String(normalized) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function summarizeLabelEvents(events: IssueTimelineLabelEvent[], label: string): LabelEventSummary {
  const target = label.toLowerCase();
  let lastLabeled: bigint | null = null;
  let lastUnlabeled: bigint | null = null;
  let latestLabeledEventId: string | null = null;
  let latestUnlabeledEventId: string | null = null;

  for (const ev of events) {
    const name = (ev?.label?.name ?? "").toLowerCase();
    if (!name || name !== target) continue;
    const rawId = toEventIdString(ev?.id ?? null);
    const eventId = parseEventIdBigInt(rawId);
    if (!eventId || !rawId) continue;
    const kind = (ev?.event ?? "").toLowerCase();
    if (kind === "labeled") {
      if (!lastLabeled || eventId > lastLabeled) {
        lastLabeled = eventId;
        latestLabeledEventId = rawId;
      }
    } else if (kind === "unlabeled") {
      if (!lastUnlabeled || eventId > lastUnlabeled) {
        lastUnlabeled = eventId;
        latestUnlabeledEventId = rawId;
      }
    }
  }

  const activeLabeledEventId =
    lastLabeled && (!lastUnlabeled || lastLabeled > lastUnlabeled) ? latestLabeledEventId : null;

  return {
    latestLabeledEventId,
    latestUnlabeledEventId,
    activeLabeledEventId,
  };
}

function decideQueueOnEscalated(params: {
  hasEscalatedLabel: boolean;
  cmdEventId: string | null;
  escalatedEventId: string | null;
}): QueueOnEscalatedDecision {
  if (!params.hasEscalatedLabel) return { outcome: "apply" };
  const queueEventId = parseEventIdBigInt(params.cmdEventId);
  const escalatedEventId = parseEventIdBigInt(params.escalatedEventId);
  if (!queueEventId || !escalatedEventId) {
    return { outcome: "unknown" };
  }
  if (queueEventId <= escalatedEventId) {
    return {
      outcome: "refuse",
      reason:
        "Queue command predates the active escalation. Apply `ralph:cmd:queue` again after reviewing the escalation note.",
    };
  }
  return { outcome: "apply" };
}

async function fetchIssueLabelEventSummaries(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  labels: string[];
}): Promise<Map<string, LabelEventSummary>> {
  const { owner, name } = splitRepoFullName(params.repo);
  const out = new Map<string, LabelEventSummary>();
  const targets = new Set(params.labels.map((label) => label.toLowerCase()));
  try {
    const response = await params.github.request<IssueTimelineLabelEvent[]>(
      `/repos/${owner}/${name}/issues/${params.issueNumber}/events?per_page=100`
    );
    const events = response.data ?? [];
    for (const label of targets) {
      out.set(label, summarizeLabelEvents(events, label));
    }
  } catch {
    for (const label of targets) {
      out.set(label, {
        latestLabeledEventId: null,
        latestUnlabeledEventId: null,
        activeLabeledEventId: null,
      });
    }
  }
  return out;
}

function parseCmdRecord(payload: string | null): CmdRecord | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as CmdRecord;
    if (!parsed || parsed.version !== 1) return null;
    if (parsed.phase !== "started" && parsed.phase !== "completed") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function ensureCmdComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  key: string;
  state: CmdCommentState;
  lines: string[];
}): Promise<void> {
  const match = await findCmdComment({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    key: params.key,
  });
  const body = buildCmdCommentBody({ key: params.key, state: params.state, lines: params.lines });
  if (match.comment) {
    await updateCmdComment({ github: params.github, repo: params.repo, commentId: match.comment.id, body });
  } else {
    await createCmdComment({ github: params.github, repo: params.repo, issueNumber: params.issueNumber, body });
  }
}

type ProcessOneCommandParams = {
  repo: string;
  issueNumber: number;
  cmdLabel: CmdLabel;
  currentLabels: string[];
  issueState: string | null;
};

export async function processOneCommand(
  params: ProcessOneCommandParams
): Promise<{ processed: boolean; removedCmdLabel: boolean }> {
  const github = new GitHubClient(params.repo);
  const at = nowIso();
  const issueRef = `${params.repo}#${params.issueNumber}`;

  const eventSummaries = await fetchIssueLabelEventSummaries({
    github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    labels: [params.cmdLabel, RALPH_LABEL_STATUS_ESCALATED],
  });
  const cmdSummary = eventSummaries.get(params.cmdLabel.toLowerCase());
  const escalationSummary = eventSummaries.get(RALPH_LABEL_STATUS_ESCALATED.toLowerCase());
  const eventId = cmdSummary?.activeLabeledEventId ?? cmdSummary?.latestLabeledEventId ?? null;
  const escalatedEventId = escalationSummary?.activeLabeledEventId ?? null;
  const key = buildCmdEventKey({ repo: params.repo, issueNumber: params.issueNumber, cmdLabel: params.cmdLabel, eventId });

  const existingPayload = getIdempotencyPayload(key);
  const existing = parseCmdRecord(existingPayload);
  const completed = existing?.phase === "completed";

  const markerStateBase = {
    version: 1 as const,
    key,
    repo: params.repo,
    issueNumber: params.issueNumber,
    cmdLabel: params.cmdLabel,
    eventId,
    processedAt: at,
  };

  const labelEnsurer = createRalphWorkflowLabelsEnsurer({
    githubFactory: (repo) => new GitHubClient(repo),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  });

  const removeOnlyOps = planIssueLabelOps({ add: [], remove: [params.cmdLabel] });

  if (completed) {
    const removeResult = await executeIssueLabelOps({
      github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      ops: removeOnlyOps,
      ensureLabels: async () => await labelEnsurer.ensure(params.repo),
      retryMissingLabelOnce: true,
      ensureBefore: false,
      log: (message) => console.warn(`${TELEMETRY_PREFIX} ${issueRef} ${message}`),
      logLabel: issueRef,
    });

    const removed = removeResult.ok ? removeResult.remove.includes(params.cmdLabel) : false;
    if (removeResult.ok && removed) {
      applyLabelDeltaSnapshot({ repo: params.repo, issueNumber: params.issueNumber, add: [], remove: [params.cmdLabel], nowIso: at });
    }
    return { processed: true, removedCmdLabel: removed };
  }

  if (!existing) {
    upsertIdempotencyKey({
      key,
      scope: "cmd",
      payloadJson: JSON.stringify({
        version: 1,
        phase: "started",
        repo: params.repo,
        issueNumber: params.issueNumber,
        cmdLabel: params.cmdLabel,
        eventId,
        startedAt: at,
      } satisfies CmdRecord),
      createdAt: at,
    });
  }

  const isClosed = (params.issueState ?? "").toUpperCase() === "CLOSED";
  if (isClosed) {
    const state: CmdCommentState = {
      ...markerStateBase,
      decision: "refused",
      reason: "Issue is closed; ignoring command",
    };
    await ensureCmdComment({
      github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      key,
      state,
      lines: [
        `Refused: \`${params.cmdLabel}\` on closed issue.`,
        "",
        "If you meant to re-open and resume: re-open the issue, then apply `ralph:cmd:queue`.",
      ],
    });
    const result = await executeIssueLabelOps({
      github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      ops: removeOnlyOps,
      ensureLabels: async () => await labelEnsurer.ensure(params.repo),
      retryMissingLabelOnce: true,
      ensureBefore: false,
      log: (message) => console.warn(`${TELEMETRY_PREFIX} ${issueRef} ${message}`),
      logLabel: issueRef,
    });
    const removed = result.ok ? result.remove.includes(params.cmdLabel) : false;
    if (result.ok && removed) {
      applyLabelDeltaSnapshot({ repo: params.repo, issueNumber: params.issueNumber, add: [], remove: [params.cmdLabel], nowIso: at });
    }

    if (removed) {
      upsertIdempotencyKey({
        key,
        scope: "cmd",
        payloadJson: JSON.stringify({
          version: 1,
          phase: "completed",
          repo: params.repo,
          issueNumber: params.issueNumber,
          cmdLabel: params.cmdLabel,
          eventId,
          startedAt: existing?.startedAt ?? at,
          completedAt: at,
          decision: "refused",
          reason: "Issue closed",
        } satisfies CmdRecord),
        createdAt: at,
      });
    }

    return { processed: true, removedCmdLabel: removed };
  }

  let decision: CmdCommentState["decision"] = "applied";
  let reason: string | undefined;
  let addLabels: string[] = [];
  let removeLabels: string[] = [params.cmdLabel];
  let removedCmdLabel = false;

  try {
    if (params.cmdLabel === RALPH_LABEL_CMD_SATISFY) {
      const satKey = buildSatisfactionKey(params.repo, params.issueNumber);
      if (!hasIdempotencyKey(satKey)) {
        recordIdempotencyKey({
          key: satKey,
          scope: "dependency-satisfaction",
          payloadJson: JSON.stringify({ version: 1, satisfiedAt: at, via: "ralph:cmd:satisfy" }),
          createdAt: at,
        });
      }
      reason = "Recorded dependency satisfaction (internal override).";
    } else {
      let labelsForPlan = params.currentLabels;
      if (params.cmdLabel === RALPH_LABEL_CMD_QUEUE) {
        // Harden cmd:queue against stale local label snapshots.
        // We rely on status labels as the queue source-of-truth, so use live GitHub labels when possible.
        labelsForPlan = await fetchLiveIssueLabelsBestEffort({
          github,
          repo: params.repo,
          issueNumber: params.issueNumber,
          fallback: params.currentLabels,
        });
      }

      const desiredStatus =
        params.cmdLabel === RALPH_LABEL_CMD_QUEUE
          ? "queued"
          : params.cmdLabel === RALPH_LABEL_CMD_PAUSE
            ? "paused"
            : "stopped";

      if (params.cmdLabel === RALPH_LABEL_CMD_QUEUE) {
        const queueDecision = decideQueueOnEscalated({
          hasEscalatedLabel: labelsForPlan.includes(RALPH_LABEL_STATUS_ESCALATED),
          cmdEventId: eventId,
          escalatedEventId,
        });
        if (queueDecision.outcome === "refuse") {
          decision = "refused";
          reason = queueDecision.reason;
          addLabels = [];
          removeLabels = [params.cmdLabel];
        } else if (queueDecision.outcome === "unknown") {
          console.warn(
            `${TELEMETRY_PREFIX} ${issueRef} queue-causality-unknown cmdEventId=${eventId ?? "none"} escalatedEventId=${escalatedEventId ?? "none"}`
          );
        }
      }

      if (decision !== "refused") {
        releaseTaskSlot({
          repo: params.repo,
          issueNumber: params.issueNumber,
          status: desiredStatus,
          releasedReason: `cmd:${params.cmdLabel}`,
        });

        const delta =
          desiredStatus === "queued"
            ? buildQueueLabelDelta(labelsForPlan)
            : statusToRalphLabelDelta(desiredStatus as any, labelsForPlan);
        addLabels = delta.add;
        removeLabels = [...delta.remove, params.cmdLabel];
        reason =
          desiredStatus === "queued"
            ? "Re-queued."
            : desiredStatus === "paused"
              ? "Paused."
              : "Stopped (operator cancel).";
      }
    }

    const ops = planIssueLabelOps({ add: addLabels, remove: removeLabels });
    const result = await executeIssueLabelOps({
      github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      ops,
      ensureLabels: async () => await labelEnsurer.ensure(params.repo),
      retryMissingLabelOnce: true,
      ensureBefore: false,
      log: (message) => console.warn(`${TELEMETRY_PREFIX} ${issueRef} ${message}`),
      logLabel: issueRef,
    });

    if (!result.ok) {
      decision = "failed";
      reason = `GitHub label update failed (${result.kind}).`;
    } else {
      applyLabelDeltaSnapshot({ repo: params.repo, issueNumber: params.issueNumber, add: result.add, remove: result.remove, nowIso: at });
      removedCmdLabel = result.remove.includes(params.cmdLabel);
    }
  } catch (error: any) {
    decision = "failed";
    reason = error?.message ?? String(error);
  }

  const state: CmdCommentState = {
    ...markerStateBase,
    decision,
    reason,
  };

  const statusLine =
    decision === "refused"
      ? "Refused: stale `ralph:cmd:queue` command did not clear escalation."
      : params.cmdLabel === RALPH_LABEL_CMD_QUEUE
      ? `Applied: set ${RALPH_LABEL_STATUS_QUEUED}.`
      : params.cmdLabel === RALPH_LABEL_CMD_PAUSE
        ? `Applied: set ${RALPH_LABEL_STATUS_PAUSED}.`
        : params.cmdLabel === RALPH_LABEL_CMD_STOP
          ? `Applied: set ${RALPH_LABEL_STATUS_STOPPED}.`
          : "Applied: recorded dependency satisfaction.";

  await ensureCmdComment({
    github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    key,
    state,
    lines: [
      `Processed \`${params.cmdLabel}\`.`,
      statusLine,
      reason ? `Reason: ${reason}` : "",
    ].filter((line) => line.trim().length > 0),
  });

  if (removedCmdLabel && decision !== "failed") {
    upsertIdempotencyKey({
      key,
      scope: "cmd",
      payloadJson: JSON.stringify({
        version: 1,
        phase: "completed",
        repo: params.repo,
        issueNumber: params.issueNumber,
        cmdLabel: params.cmdLabel,
        eventId,
        startedAt: existing?.startedAt ?? at,
        completedAt: at,
        decision,
        reason,
      } satisfies CmdRecord),
      createdAt: at,
    });
  }

  return { processed: true, removedCmdLabel };
}

export async function __processOneCommandForTests(
  params: ProcessOneCommandParams
): Promise<{ processed: boolean; removedCmdLabel: boolean }> {
  return await processOneCommand(params);
}

async function processRepoOnce(repo: string, maxIssues: number): Promise<number> {
  const issues = listIssueSnapshotsWithRalphLabels(repo);
  if (issues.length === 0) return 0;

  let processed = 0;
  for (const issue of issues) {
    if (processed >= maxIssues) break;
    const cmdLabels = CMD_LABEL_ORDER.filter((label) => issue.labels.includes(label));
    if (cmdLabels.length === 0) continue;

    for (const cmdLabel of cmdLabels) {
      const result = await processOneCommand({
        repo,
        issueNumber: issue.number,
        cmdLabel,
        currentLabels: issue.labels,
        issueState: issue.state ?? null,
      });
      if (result.processed) {
        processed += 1;
        break;
      }
    }
  }

  return processed;
}

export function startGitHubCmdProcessor(params?: {
  intervalMs?: number;
  maxIssuesPerTick?: number;
  log?: (message: string) => void;
}): { stop: () => void } {
  const intervalMs = Math.max(1_000, params?.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxIssuesPerTick = Math.max(1, Math.floor(params?.maxIssuesPerTick ?? DEFAULT_MAX_ISSUES_PER_TICK));
  const log = params?.log ?? ((message: string) => console.log(message));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (running) {
      timer = setTimeout(tick, intervalMs);
      return;
    }

    running = true;
    try {
      const repos = getConfig().repos.map((entry) => entry.name);
      let remaining = maxIssuesPerTick;
      for (const repo of repos) {
        if (remaining <= 0) break;
        const count = await processRepoOnce(repo, remaining);
        remaining -= count;
      }
      if (shouldLog("cmd:tick", 5 * 60_000)) {
        log("[ralph:cmd] Cmd processor tick complete");
      }
    } catch (error: any) {
      log(`[ralph:cmd] Cmd processor tick failed: ${error?.message ?? String(error)}`);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
