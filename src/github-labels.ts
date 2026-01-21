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

export const RALPH_WORKFLOW_LABELS: readonly LabelSpec[] = [
  { name: "ralph:queued", color: "0366D6", description: "Ready to be claimed by Ralph" },
  { name: "ralph:in-progress", color: "FBCA04", description: "Ralph is actively working" },
  { name: "ralph:in-bot", color: "0E8A16", description: "Task PR merged to bot/integration" },
  { name: "ralph:blocked", color: "D73A4A", description: "Blocked by dependencies" },
  { name: "ralph:escalated", color: "B60205", description: "Waiting on human input" },
] as const;

export function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeLabelColor(color: string): string {
  return color.trim().replace(/^#/, "").toLowerCase();
}

export function normalizeLabelDescription(description: string | null | undefined): string {
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
