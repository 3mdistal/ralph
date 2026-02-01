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

// Legacy workflow labels (pre vNext taxonomy).
// NOTE: These are NOT supported by the scheduler after the big-bang cutover.
export const RALPH_LEGACY_WORKFLOW_LABELS = [
  "ralph:queued",
  "ralph:in-progress",
  "ralph:blocked",
  "ralph:escalated",
  "ralph:stuck",
  "ralph:in-bot",
  "ralph:done",
] as const;

export type RalphLegacyWorkflowLabel = (typeof RALPH_LEGACY_WORKFLOW_LABELS)[number];

export const RALPH_STATUS_LABEL_PREFIX = "ralph:status:";

export const RALPH_LABEL_STATUS_QUEUED = "ralph:status:queued";
export const RALPH_LABEL_STATUS_IN_PROGRESS = "ralph:status:in-progress";
export const RALPH_LABEL_STATUS_BLOCKED = "ralph:status:blocked";
export const RALPH_LABEL_STATUS_PAUSED = "ralph:status:paused";
export const RALPH_LABEL_STATUS_THROTTLED = "ralph:status:throttled";
export const RALPH_LABEL_STATUS_IN_BOT = "ralph:status:in-bot";
export const RALPH_LABEL_STATUS_DONE = "ralph:status:done";

// Back-compat alias exports (internal-only).
// Prefer the explicit RALPH_LABEL_STATUS_* constants in new code.
export const RALPH_LABEL_QUEUED = RALPH_LABEL_STATUS_QUEUED;
export const RALPH_LABEL_IN_PROGRESS = RALPH_LABEL_STATUS_IN_PROGRESS;
export const RALPH_LABEL_BLOCKED = RALPH_LABEL_STATUS_BLOCKED;
export const RALPH_LABEL_STUCK = RALPH_LABEL_STATUS_IN_PROGRESS;
export const RALPH_LABEL_IN_BOT = RALPH_LABEL_STATUS_IN_BOT;
export const RALPH_LABEL_DONE = RALPH_LABEL_STATUS_DONE;
export const RALPH_LABEL_ESCALATED = RALPH_LABEL_STATUS_BLOCKED;

export const RALPH_INTENT_LABELS = [
  "ralph:intent:implement",
  "ralph:intent:review-fix",
  "ralph:intent:research",
  "ralph:intent:write",
  "ralph:intent:brainstorm",
  "ralph:intent:spec",
  "ralph:intent:triage",
] as const;

export const RALPH_ARTIFACT_LABELS = [
  "ralph:artifact:comment",
  "ralph:artifact:pr",
  "ralph:artifact:merged-pr",
  "ralph:artifact:markdown",
  "ralph:artifact:pr-review-replies",
  "ralph:artifact:subissues",
] as const;

export const RALPH_WORKFLOW_LABELS: readonly LabelSpec[] = [
  // Status (Ralph-managed)
  { name: RALPH_LABEL_STATUS_QUEUED, color: "0366D6", description: "In queue; claimable" },
  { name: RALPH_LABEL_STATUS_IN_PROGRESS, color: "FBCA04", description: "Ralph is actively working" },
  { name: RALPH_LABEL_STATUS_BLOCKED, color: "D73A4A", description: "Waiting on dependencies or human input" },
  { name: RALPH_LABEL_STATUS_PAUSED, color: "6A737D", description: "Operator pause; do not claim or resume" },
  { name: RALPH_LABEL_STATUS_THROTTLED, color: "F9A825", description: "Throttled; will resume later" },
  { name: RALPH_LABEL_STATUS_IN_BOT, color: "0E8A16", description: "Task PR merged to bot/integration" },
  { name: RALPH_LABEL_STATUS_DONE, color: "1A7F37", description: "Task merged to default branch" },

  // Intent (operator-owned)
  { name: "ralph:intent:implement", color: "0B5FFF", description: "Implementation pipeline" },
  { name: "ralph:intent:review-fix", color: "0B5FFF", description: "PR review-fix autopilot" },
  { name: "ralph:intent:research", color: "5319E7", description: "Research pipeline" },
  { name: "ralph:intent:write", color: "5319E7", description: "Writing pipeline" },
  { name: "ralph:intent:brainstorm", color: "5319E7", description: "Brainstorm pipeline" },
  { name: "ralph:intent:spec", color: "5319E7", description: "Spec pipeline" },
  { name: "ralph:intent:triage", color: "5319E7", description: "Triage pipeline" },

  // Artifact (operator-owned)
  { name: "ralph:artifact:comment", color: "1D76DB", description: "Output: comment" },
  { name: "ralph:artifact:pr", color: "1D76DB", description: "Output: PR" },
  { name: "ralph:artifact:merged-pr", color: "1D76DB", description: "Output: merged PR" },
  { name: "ralph:artifact:markdown", color: "1D76DB", description: "Output: markdown" },
  { name: "ralph:artifact:pr-review-replies", color: "1D76DB", description: "Output: PR review replies" },
  { name: "ralph:artifact:subissues", color: "1D76DB", description: "Output: sub-issues" },
] as const;

export function detectLegacyWorkflowLabels(labels: string[]): RalphLegacyWorkflowLabel[] {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()).filter(Boolean));
  const out: RalphLegacyWorkflowLabel[] = [];
  for (const legacy of RALPH_LEGACY_WORKFLOW_LABELS) {
    if (normalized.has(legacy)) out.push(legacy);
  }
  return out;
}

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
