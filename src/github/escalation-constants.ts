export const RALPH_LABEL_QUEUED = "ralph:status:queued";
export const RALPH_LABEL_IN_PROGRESS = "ralph:status:in-progress";

export const RALPH_LABEL_ESCALATED = "ralph:status:escalated";

// Legacy "stuck" maps to "in-progress" in the vNext taxonomy.
export const RALPH_LABEL_STUCK = "ralph:status:in-progress";

const ESCALATION_TYPES = [
  "product-gap",
  "low-confidence",
  "ambiguous-requirements",
  "blocked",
  "merge-conflict",
  "other",
] as const;

export type EscalationType = (typeof ESCALATION_TYPES)[number];

export function normalizeEscalationType(input: string | null | undefined): EscalationType {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if ((ESCALATION_TYPES as readonly string[]).includes(normalized)) {
    return normalized as EscalationType;
  }
  return "other";
}

export const RALPH_ESCALATION_MARKER_PREFIX = "<!-- ralph-escalation:id=";
export const RALPH_ESCALATION_MARKER_REGEX = /<!--\s*ralph-escalation:id=([a-f0-9]+)\s*-->/i;
