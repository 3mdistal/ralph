import type { RoutingDecision } from "./routing";

export interface IssueMetadata {
  labels: string[];
  title: string;
  state?: string;
  stateReason?: string;
  closedAt?: string;
  url?: string;
}

const ESCALATION_SENSITIVE_LABELS = ["product", "ux", "breaking-change"] as const;

export function isImplementationTaskFromIssue(meta: IssueMetadata): boolean {
  const labels = meta.labels.map((l) => l.toLowerCase());

  // Owner policy: default to "implementation-ish" unless explicitly labeled otherwise.
  const isEscalationSensitive = labels.some((l) => ESCALATION_SENSITIVE_LABELS.some((k) => k === l));
  return !isEscalationSensitive;
}

export function isContractSurfaceReason(reason?: string | null): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r) return false;

  // Owner policy: user-facing contract surfaces (see docs/escalation-policy.md).
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

export function isExplicitBlockerReason(reason?: string | null): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r) return false;

  // Avoid common negations.
  if (/\bunblocked\b/.test(r)) return false;
  if (/\bnot\s+blocked\b/.test(r)) return false;

  // Keep this conservative: only detect clear "cannot proceed" / "blocked" signals.
  const indicators: RegExp[] = [
    /\bblocked\b/, 
    /\bcannot\s+proceed\b/,
    /\bcan'?t\s+proceed\b/,
    /\bneeds?\s+human\s+decision\b/,
    /\brequires?\s+human(\s+decision)?\b/,
    /\bexternal\s+blocker\b/,
  ];

  return indicators.some((re) => re.test(r));
}

export function isAmbiguousRequirementsReason(reason?: string | null): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r) return false;

  // Conservative: only treat as ambiguity when it explicitly asks for clarification.
  if (/\bneeds?\s+clarification\b/.test(r)) return true;
  if (/\brequires?\s+clarification\b/.test(r)) return true;

  const ambiguityWord = /\b(ambiguous|unclear)\b/.test(r);
  if (!ambiguityWord) return false;

  // Reduce false positives by requiring a requirements/spec context.
  return /\b(requirements?|spec|behavior|expected|acceptance criteria)\b/.test(r);
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

  if (routing.decision === "escalate" && routing.confidence === "high") return false;

  const needsHelp = routing.decision === "escalate" || routing.confidence === "low";
  if (!needsHelp) return false;

  return !isContractSurfaceReason(routing.escalation_reason);
}

export function shouldEscalateAfterRouting(opts: { routing: RoutingDecision | null; hasGap: boolean }): boolean {
  const { routing, hasGap } = opts;

  // No routing decision parsed - don't escalate, let it proceed.
  if (!routing) return false;

  // Product gap and explicit blockers always escalate.
  if (hasGap) return true;
  if (isExplicitBlockerReason(routing.escalation_reason)) return true;
  if (isAmbiguousRequirementsReason(routing.escalation_reason)) return true;

  // Contract surfaces should escalate even if the agent isn't confident.
  if (isContractSurfaceReason(routing.escalation_reason)) return true;

  // Escalate immediately only on explicit high-confidence escalation.
  if (routing.decision === "escalate" && routing.confidence === "high") {
    return true;
  }

  // Low confidence alone must not trigger escalation.
  // Low/medium-confidence "escalate" decisions should be treated as non-blocking.
  return false;
}
