export type TaskPriority = "p0-critical" | "p1-high" | "p2-medium" | "p3-low" | "p4-backlog";

const PRIORITY_BY_INDEX: TaskPriority[] = [
  "p0-critical",
  "p1-high",
  "p2-medium",
  "p3-low",
  "p4-backlog",
];

export function inferPriorityFromLabels(labels: string[]): TaskPriority {
  let bestIndex: number | null = null;
  for (const label of labels) {
    const match = label.match(/^p([0-4])/i);
    if (!match) continue;
    const index = Number.parseInt(match[1], 10);
    if (!Number.isFinite(index)) continue;
    if (bestIndex === null || index < bestIndex) bestIndex = index;
  }

  return PRIORITY_BY_INDEX[bestIndex ?? 2];
}

export function priorityRank(priority: unknown): number {
  if (typeof priority !== "string") return 2;
  const normalized = priority.trim().toLowerCase();
  const index = PRIORITY_BY_INDEX.indexOf(normalized as TaskPriority);
  return index === -1 ? 2 : index;
}
