export type TaskPriority = "p0-critical" | "p1-high" | "p2-medium" | "p3-low" | "p4-backlog";

const DEFAULT_PRIORITY: TaskPriority = "p2-medium";

const PRIORITY_BY_INDEX: TaskPriority[] = [
  "p0-critical",
  "p1-high",
  "p2-medium",
  "p3-low",
  "p4-backlog",
];

export function inferPriorityFromLabels(labels?: readonly string[] | null): TaskPriority {
  let bestIndex: number | null = null;
  const entries = labels ?? [];
  for (const label of entries) {
    const match = label.match(/^p([0-4])/i);
    if (!match) continue;
    const index = Number.parseInt(match[1], 10);
    if (!Number.isFinite(index)) continue;
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

  const match = normalized.match(/^p([0-4])/);
  if (!match) return DEFAULT_PRIORITY;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index)) return DEFAULT_PRIORITY;
  return PRIORITY_BY_INDEX[index] ?? DEFAULT_PRIORITY;
}

export function priorityRank(priority: unknown): number {
  const normalized = normalizeTaskPriority(priority);
  return PRIORITY_BY_INDEX.indexOf(normalized);
}
