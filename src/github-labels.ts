export interface LabelSpec {
  name: string;
  color: string; // 6-char hex, no leading '#'
  description: string;
}

export interface ExistingLabelSpec {
  name: string;
  color?: string | null;
  description?: string | null;
}

export const RALPH_LABEL_QUEUED = "ralph:queued";
export const RALPH_LABEL_IN_PROGRESS = "ralph:in-progress";
export const RALPH_LABEL_IN_BOT = "ralph:in-bot";
export const RALPH_LABEL_BLOCKED = "ralph:blocked";
export const RALPH_LABEL_STUCK = "ralph:stuck";
export const RALPH_LABEL_DONE = "ralph:done";
export const RALPH_LABEL_ESCALATED = "ralph:escalated";

export const RALPH_WORKFLOW_LABELS: readonly LabelSpec[] = [
  { name: RALPH_LABEL_QUEUED, color: "0366D6", description: "In queue; claimable when not blocked or escalated" },
  { name: RALPH_LABEL_IN_PROGRESS, color: "FBCA04", description: "Ralph is actively working" },
  { name: RALPH_LABEL_IN_BOT, color: "0E8A16", description: "Task PR merged to bot/integration" },
  { name: RALPH_LABEL_BLOCKED, color: "D73A4A", description: "Blocked by dependencies" },
  { name: RALPH_LABEL_STUCK, color: "F9A825", description: "CI remediation in progress" },
  { name: RALPH_LABEL_DONE, color: "1A7F37", description: "Task merged to default branch" },
  { name: RALPH_LABEL_ESCALATED, color: "B60205", description: "Waiting on human input" },
] as const;

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeLabelColor(color: string): string {
  return color.trim().replace(/^#/, "").toLowerCase();
}

function normalizeLabelDescription(description: string | null | undefined): string {
  return (description ?? "").trim();
}

export function computeRalphLabelSync(existing: ExistingLabelSpec[]): {
  toCreate: LabelSpec[];
  toUpdate: Array<{ currentName: string; patch: { color?: string; description?: string } }>;
} {
  const canonicalByName = new Map<string, LabelSpec>();
  for (const label of RALPH_WORKFLOW_LABELS) {
    canonicalByName.set(normalizeLabelName(label.name), label);
  }

  const existingByName = new Map<string, ExistingLabelSpec>();
  for (const label of existing) {
    const normalized = normalizeLabelName(label.name);
    const canonical = canonicalByName.get(normalized);
    if (!canonical) continue;

    const current = existingByName.get(normalized);
    if (!current) {
      existingByName.set(normalized, label);
      continue;
    }

    if (label.name === canonical.name && current.name !== canonical.name) {
      existingByName.set(normalized, label);
    }
  }

  const toCreate: LabelSpec[] = [];
  const toUpdate: Array<{ currentName: string; patch: { color?: string; description?: string } }> = [];

  for (const canonical of RALPH_WORKFLOW_LABELS) {
    const normalized = normalizeLabelName(canonical.name);
    const existingLabel = existingByName.get(normalized);
    if (!existingLabel) {
      toCreate.push(canonical);
      continue;
    }

    const patch: { color?: string; description?: string } = {};
    const existingColor = normalizeLabelColor(existingLabel.color ?? "");
    const canonicalColor = normalizeLabelColor(canonical.color);
    if (existingColor !== canonicalColor) {
      patch.color = canonical.color;
    }

    const existingDescription = normalizeLabelDescription(existingLabel.description);
    const canonicalDescription = normalizeLabelDescription(canonical.description);
    if (existingDescription !== canonicalDescription) {
      patch.description = canonical.description;
    }

    if (Object.keys(patch).length > 0) {
      toUpdate.push({ currentName: existingLabel.name, patch });
    }
  }

  return { toCreate, toUpdate };
}
