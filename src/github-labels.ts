export interface LabelSpec {
  name: string;
  color: string; // 6-char hex, no leading '#'
  description: string;
}

export const BASELINE_LABELS: readonly LabelSpec[] = [
  { name: "dx", color: "1D76DB", description: "Developer experience" },
  { name: "refactor", color: "BFDADC", description: "Refactoring" },
  { name: "bug", color: "D73A4A", description: "Something isn't working" },
  { name: "chore", color: "C5DEF5", description: "Maintenance" },
  { name: "test", color: "0E8A16", description: "Tests" },
  { name: "allow-main", color: "F9D0C4", description: "Allow Ralph to merge PRs to main" },
] as const;

export const RALPH_WORKFLOW_LABELS: readonly LabelSpec[] = [
  { name: "ralph:queued", color: "0366D6", description: "Queued for Ralph" },
  { name: "ralph:in-progress", color: "FBCA04", description: "Ralph is working" },
  { name: "ralph:in-bot", color: "0E8A16", description: "Merged to bot/integration" },
  { name: "ralph:blocked", color: "D73A4A", description: "Blocked by dependencies" },
  { name: "ralph:escalated", color: "B60205", description: "Needs human input" },
] as const;

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

export function computeMissingBaselineLabels(existing: string[]): LabelSpec[] {
  const existingSet = new Set(existing.map(normalizeLabelName));
  return BASELINE_LABELS.filter((l) => !existingSet.has(normalizeLabelName(l.name)));
}

export function computeMissingRalphLabels(existing: string[]): LabelSpec[] {
  const existingSet = new Set(existing.map(normalizeLabelName));
  return RALPH_WORKFLOW_LABELS.filter((l) => !existingSet.has(normalizeLabelName(l.name)));
}
