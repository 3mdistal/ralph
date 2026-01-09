import type { RoutingDecision } from "./routing";

export interface IssueMetadata {
  labels: string[];
  title: string;
}

const IMPLEMENTATION_KEYWORDS = ["dx", "refactor", "bug"] as const;

export function isImplementationTaskFromIssue(meta: IssueMetadata): boolean {
  const labels = meta.labels.map((l) => l.toLowerCase());
  const title = meta.title.toLowerCase();

  const hasLabel = labels.some((l) => IMPLEMENTATION_KEYWORDS.some((k) => k === l));
  const titleHasKeyword = new RegExp(`\\b(${IMPLEMENTATION_KEYWORDS.join("|")})\\b`, "i").test(title);

  return hasLabel || titleHasKeyword;
}

export function isContractSurfaceReason(reason?: string | null): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r) return false;

  // Owner policy: user-facing contract surfaces.
  const indicators = [
    "cli",
    "flag",
    "flags",
    "exit code",
    "stdout",
    "stderr",
    "output format",
    "public error",
    "error string",
    "config",
    "schema",
    "json output",
    "json mode",
    "machine-readable",
  ];

  return indicators.some((s) => r.includes(s));
}

export function shouldConsultDevex(opts: {
  routing: RoutingDecision | null;
  hasGap: boolean;
  isImplementationTask: boolean;
}): boolean {
  const { routing, hasGap, isImplementationTask } = opts;

  if (!isImplementationTask) return false;
  if (hasGap) return false;
  if (!routing) return false;

  const needsHelp = routing.decision === "escalate" || routing.confidence === "low";
  if (!needsHelp) return false;

  return !isContractSurfaceReason(routing.escalation_reason);
}

export function shouldEscalateAfterRouting(opts: {
  routing: RoutingDecision | null;
  hasGap: boolean;
  isImplementationTask: boolean;
}): boolean {
  const { routing, hasGap, isImplementationTask } = opts;

  // No routing decision parsed - don't escalate, let it proceed.
  if (!routing) return false;

  // Explicit escalate decision with high confidence - always escalate.
  if (routing.decision === "escalate" && routing.confidence === "high") {
    return true;
  }

  // For implementation tasks, ignore "product gap" signals unless explicit escalate.
  if (isImplementationTask && hasGap && routing.decision !== "escalate") {
    return false;
  }

  return routing.decision === "escalate" || hasGap || routing.confidence === "low";
}
