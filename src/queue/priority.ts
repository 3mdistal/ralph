export type TaskPriority = "p0-critical" | "p1-high" | "p2-medium" | "p3-low" | "p4-backlog";

const DEFAULT_PRIORITY: TaskPriority = "p2-medium";

const PRIORITY_BY_INDEX: TaskPriority[] = [
  "p0-critical",
  "p1-high",
  "p2-medium",
  "p3-low",
  "p4-backlog",
];

const PRIORITY_LABEL_RE = /^p([0-4])/i;

function parsePriorityIndex(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(PRIORITY_LABEL_RE);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index)) return null;
  return PRIORITY_BY_INDEX[index] ? index : null;
}

export function inferPriorityFromLabels(labels?: readonly string[] | null): TaskPriority {
  let bestIndex: number | null = null;
  const entries = labels ?? [];
  for (const label of entries) {
    const index = parsePriorityIndex(label);
    if (index === null) continue;
    if (bestIndex === null || index < bestIndex) bestIndex = index;
  }

  return PRIORITY_BY_INDEX[bestIndex ?? PRIORITY_BY_INDEX.indexOf(DEFAULT_PRIORITY)];
}

export function normalizeTaskPriority(value: unknown): TaskPriority {
  if (typeof value !== "string") return DEFAULT_PRIORITY;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_PRIORITY;
  if (PRIORITY_BY_INDEX.includes(normalized as TaskPriority)) {
    return normalized as TaskPriority;
  }

  const index = parsePriorityIndex(value);
  if (index === null) return DEFAULT_PRIORITY;
  return PRIORITY_BY_INDEX[index] ?? DEFAULT_PRIORITY;
}

export function priorityRank(priority: unknown): number {
  const normalized = normalizeTaskPriority(priority);
  return PRIORITY_BY_INDEX.indexOf(normalized);
}
