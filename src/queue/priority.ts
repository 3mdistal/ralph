export type TaskPriority = "p0-critical" | "p1-high" | "p2-medium" | "p3-low" | "p4-backlog";

export type RalphPriorityLabel =
  | "ralph:priority:p0"
  | "ralph:priority:p1"
  | "ralph:priority:p2"
  | "ralph:priority:p3"
  | "ralph:priority:p4";

const DEFAULT_PRIORITY: TaskPriority = "p2-medium";

const PRIORITY_BY_INDEX: TaskPriority[] = [
  "p0-critical",
  "p1-high",
  "p2-medium",
  "p3-low",
  "p4-backlog",
];

export const RALPH_PRIORITY_LABELS: RalphPriorityLabel[] = [
  "ralph:priority:p0",
  "ralph:priority:p1",
  "ralph:priority:p2",
  "ralph:priority:p3",
  "ralph:priority:p4",
];

const RALPH_PRIORITY_LABEL_RE = /^ralph:priority:p([0-4])$/i;
const LEGACY_PRIORITY_LABEL_RE = /^p([0-4])(?:$|[^0-9])/i;

function parseRalphPriorityIndex(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(RALPH_PRIORITY_LABEL_RE);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index)) return null;
  return PRIORITY_BY_INDEX[index] ? index : null;
}

function parseLegacyPriorityIndex(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(LEGACY_PRIORITY_LABEL_RE);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index)) return null;
  return PRIORITY_BY_INDEX[index] ? index : null;
}

function isRalphPriorityLabel(label: string): label is RalphPriorityLabel {
  return parseRalphPriorityIndex(label) !== null;
}

export function toRalphPriorityLabel(priority: TaskPriority): RalphPriorityLabel {
  const index = PRIORITY_BY_INDEX.indexOf(priority);
  const clamped = index >= 0 ? index : PRIORITY_BY_INDEX.indexOf(DEFAULT_PRIORITY);
  return RALPH_PRIORITY_LABELS[clamped] ?? "ralph:priority:p2";
}

export function planRalphPriorityLabelDelta(
  desired: TaskPriority,
  currentLabels: readonly string[]
): { add: string[]; remove: string[] } {
  const target = toRalphPriorityLabel(desired);
  const labelSet = new Set(currentLabels);
  const add = labelSet.has(target) ? [] : [target];
  const remove = currentLabels.filter((label) => isRalphPriorityLabel(label) && label !== target);
  return { add, remove };
}

export function inferPriorityFromLabels(labels?: readonly string[] | null): TaskPriority {
  let bestRalph: number | null = null;
  let bestLegacy: number | null = null;
  const entries = labels ?? [];
  for (const label of entries) {
    const ralphIndex = parseRalphPriorityIndex(label);
    if (ralphIndex !== null) {
      if (bestRalph === null || ralphIndex < bestRalph) bestRalph = ralphIndex;
      continue;
    }

    const legacyIndex = parseLegacyPriorityIndex(label);
    if (legacyIndex === null) continue;
    if (bestLegacy === null || legacyIndex < bestLegacy) bestLegacy = legacyIndex;
  }

  const index = bestRalph ?? bestLegacy ?? PRIORITY_BY_INDEX.indexOf(DEFAULT_PRIORITY);
  return PRIORITY_BY_INDEX[index];
}

export function normalizeTaskPriority(value: unknown): TaskPriority {
  if (typeof value !== "string") return DEFAULT_PRIORITY;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_PRIORITY;
  if (PRIORITY_BY_INDEX.includes(normalized as TaskPriority)) {
    return normalized as TaskPriority;
  }

  const ralphIndex = parseRalphPriorityIndex(value);
  if (ralphIndex !== null) return PRIORITY_BY_INDEX[ralphIndex] ?? DEFAULT_PRIORITY;

  const index = parseLegacyPriorityIndex(value);
  if (index === null) return DEFAULT_PRIORITY;
  return PRIORITY_BY_INDEX[index] ?? DEFAULT_PRIORITY;
}

function taskPriorityToRalphPriorityLabel(priority: TaskPriority): RalphPriorityLabel {
  const index = PRIORITY_BY_INDEX.indexOf(priority);
  return RALPH_PRIORITY_LABELS[index] ?? RALPH_PRIORITY_LABELS[PRIORITY_BY_INDEX.indexOf(DEFAULT_PRIORITY)];
}

export function normalizePriorityInputToRalphPriorityLabel(value: unknown): RalphPriorityLabel {
  const normalized = normalizeTaskPriority(value);
  return taskPriorityToRalphPriorityLabel(normalized);
}

export function taskPriorityToCanonicalLabel(priority: TaskPriority): RalphPriorityLabel {
  return taskPriorityToRalphPriorityLabel(priority);
}

export function planRalphPriorityLabelSet(target: RalphPriorityLabel): {
  add: RalphPriorityLabel[];
  remove: RalphPriorityLabel[];
} {
  return {
    add: [target],
    remove: RALPH_PRIORITY_LABELS.filter((label) => label !== target),
  };
}

export function priorityRank(priority: unknown): number {
  const normalized = normalizeTaskPriority(priority);
  return PRIORITY_BY_INDEX.indexOf(normalized);
}

export function issuePriorityWeight(priority: unknown): number {
  const rank = priorityRank(priority);
  const weight = PRIORITY_BY_INDEX.length - rank;
  return weight > 0 ? weight : 1;
}
