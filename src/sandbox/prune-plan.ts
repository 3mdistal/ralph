import type { SandboxAction } from "./plan-executor";
import type { SandboxRetentionDecision } from "./retention";
import { hasSandboxMarker } from "./selector";

function parseTimestampMs(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

export type SandboxPrunePlan = {
  actions: SandboxAction[];
  skippedMissingMarker: SandboxRetentionDecision[];
  skippedAlreadyArchived: SandboxRetentionDecision[];
  keepCount: number;
  candidateCount: number;
  truncated: boolean;
};

export function buildSandboxPrunePlan(params: {
  decisions: SandboxRetentionDecision[];
  action: "archive" | "delete";
  max: number | null;
}): SandboxPrunePlan {
  const keepCount = params.decisions.filter((decision) => decision.keep).length;
  const candidateDecisions = params.decisions.filter((decision) => !decision.keep);
  const skippedMissingMarker = candidateDecisions.filter((decision) => !hasSandboxMarker(decision.repo));
  const eligible = candidateDecisions.filter((decision) => hasSandboxMarker(decision.repo));

  const skippedAlreadyArchived: SandboxRetentionDecision[] = [];
  const mutable =
    params.action === "archive"
      ? eligible.filter((decision) => {
          if (!decision.repo.archived) return true;
          skippedAlreadyArchived.push(decision);
          return false;
        })
      : eligible;

  const ordered = [...mutable].sort((a, b) => {
    const aMs = parseTimestampMs(a.repo.createdAt) ?? 0;
    const bMs = parseTimestampMs(b.repo.createdAt) ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    return a.repo.fullName.localeCompare(b.repo.fullName);
  });

  const cap = params.max ?? ordered.length;
  if (cap <= 0) {
    return {
      actions: [],
      skippedMissingMarker,
      skippedAlreadyArchived,
      keepCount,
      candidateCount: eligible.length,
      truncated: ordered.length > 0,
    };
  }

  const truncated = ordered.length > cap;
  const selected = truncated ? ordered.slice(0, cap) : ordered;
  const actions = selected.map((decision) => ({
    repoFullName: decision.repo.fullName,
    action: params.action,
    reason: decision.reason,
  }));

  return {
    actions,
    skippedMissingMarker,
    skippedAlreadyArchived,
    keepCount,
    candidateCount: eligible.length,
    truncated,
  };
}
