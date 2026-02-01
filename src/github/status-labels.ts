import type { QueueTaskStatus } from "../queue/types";

const STATUS_PREFIX = "ralph:status:";

export const RALPH_STATUS_LABELS = {
  queued: `${STATUS_PREFIX}queued`,
  inProgress: `${STATUS_PREFIX}in-progress`,
  blocked: `${STATUS_PREFIX}blocked`,
  paused: `${STATUS_PREFIX}paused`,
  throttled: `${STATUS_PREFIX}throttled`,
  inBot: `${STATUS_PREFIX}in-bot`,
  done: `${STATUS_PREFIX}done`,
  stuck: `${STATUS_PREFIX}stuck`,
} as const;

const STATUS_LABEL_ORDER = [
  RALPH_STATUS_LABELS.queued,
  RALPH_STATUS_LABELS.inProgress,
  RALPH_STATUS_LABELS.blocked,
  RALPH_STATUS_LABELS.paused,
  RALPH_STATUS_LABELS.throttled,
  RALPH_STATUS_LABELS.inBot,
  RALPH_STATUS_LABELS.done,
  RALPH_STATUS_LABELS.stuck,
] as const;

export type RalphStatusLabel = (typeof STATUS_LABEL_ORDER)[number];

const NORMALIZED_STATUS_LABELS = new Map<string, RalphStatusLabel>(
  STATUS_LABEL_ORDER.map((label) => [label.toLowerCase(), label])
);

const LEGACY_STATUS_LABELS = [
  "ralph:queued",
  "ralph:in-progress",
  "ralph:blocked",
  "ralph:paused",
  "ralph:throttled",
  "ralph:in-bot",
  "ralph:done",
  "ralph:escalated",
  "ralph:stuck",
] as const;

export function isStatusLabel(label: string): label is RalphStatusLabel {
  if (typeof label !== "string") return false;
  return NORMALIZED_STATUS_LABELS.has(label.trim().toLowerCase());
}

export function getStatusLabels(labels: string[]): RalphStatusLabel[] {
  if (!Array.isArray(labels)) return [];
  const seen = new Set<string>();
  const out: RalphStatusLabel[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    const canonical = NORMALIZED_STATUS_LABELS.get(normalized);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export function detectLegacyStatusLabels(labels: string[]): string[] {
  if (!Array.isArray(labels)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (!LEGACY_STATUS_LABELS.includes(normalized as (typeof LEGACY_STATUS_LABELS)[number])) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const STATUS_TO_LABEL: Record<QueueTaskStatus, RalphStatusLabel | null> = {
  queued: RALPH_STATUS_LABELS.queued,
  "in-progress": RALPH_STATUS_LABELS.inProgress,
  starting: RALPH_STATUS_LABELS.inProgress,
  blocked: RALPH_STATUS_LABELS.blocked,
  throttled: RALPH_STATUS_LABELS.throttled,
  escalated: RALPH_STATUS_LABELS.blocked,
  done: RALPH_STATUS_LABELS.done,
};

const LABEL_TO_STATUS: Record<RalphStatusLabel, QueueTaskStatus> = {
  [RALPH_STATUS_LABELS.queued]: "queued",
  [RALPH_STATUS_LABELS.inProgress]: "in-progress",
  [RALPH_STATUS_LABELS.blocked]: "blocked",
  [RALPH_STATUS_LABELS.paused]: "blocked",
  [RALPH_STATUS_LABELS.throttled]: "throttled",
  [RALPH_STATUS_LABELS.inBot]: "done",
  [RALPH_STATUS_LABELS.done]: "done",
  [RALPH_STATUS_LABELS.stuck]: "blocked",
};

export function mapStatusToLabel(status: QueueTaskStatus): RalphStatusLabel | null {
  return STATUS_TO_LABEL[status] ?? null;
}

export function mapLabelToStatus(label: RalphStatusLabel): QueueTaskStatus {
  return LABEL_TO_STATUS[label];
}

export function planSetStatus(params: {
  desired: QueueTaskStatus;
  currentLabels: string[];
}): { add: string[]; remove: string[]; statusLabel: RalphStatusLabel | null; problems: string[] } {
  const desiredLabel = mapStatusToLabel(params.desired);
  if (!desiredLabel) return { add: [], remove: [], statusLabel: null, problems: [] };

  const statusLabels = getStatusLabels(params.currentLabels);
  const add = statusLabels.includes(desiredLabel) ? [] : [desiredLabel];
  const remove = statusLabels.filter((label) => label !== desiredLabel);
  const problems: string[] = [];
  if (statusLabels.length > 1) problems.push("multiple_status_labels");
  return { add, remove, statusLabel: desiredLabel, problems };
}

export function resolveStatusFromLabels(params: {
  labels: string[];
  issueState?: string | null;
}): {
  status: QueueTaskStatus | null;
  statusLabel: RalphStatusLabel | null;
  statusLabels: RalphStatusLabel[];
  legacyLabels: string[];
  problems: string[];
} {
  const statusLabels = getStatusLabels(params.labels);
  const legacyLabels = detectLegacyStatusLabels(params.labels);
  const problems: string[] = [];
  if (statusLabels.length > 1) problems.push("multiple_status_labels");

  const normalizedState = params.issueState?.toUpperCase();
  if (normalizedState === "CLOSED") {
    return {
      status: "done",
      statusLabel: RALPH_STATUS_LABELS.done,
      statusLabels,
      legacyLabels,
      problems,
    };
  }

  const statusLabel = statusLabels.length === 1 ? statusLabels[0] : null;
  const status = statusLabel ? mapLabelToStatus(statusLabel) : null;
  return { status, statusLabel, statusLabels, legacyLabels, problems };
}

export function formatLegacyStatusDiagnostic(params: { repo: string; issueNumber: number; legacyLabels: string[] }): string {
  const labels = params.legacyLabels.join(", ");
  return `[ralph:queue:${params.repo}] Legacy status labels on #${params.issueNumber}: ${labels}. Relabel to ralph:status:* (for example, ralph:status:queued).`;
}
