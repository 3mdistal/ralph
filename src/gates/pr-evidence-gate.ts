import type { RalphRunOutcome } from "../state";

export const PR_EVIDENCE_CAUSE_CODES = ["POLICY_DENIED", "LEASE_STALE", "NO_WORKTREE_BRANCH", "UNKNOWN"] as const;
export type PrEvidenceCauseCode = (typeof PR_EVIDENCE_CAUSE_CODES)[number];

export const NO_PR_TERMINAL_REASONS = ["PARENT_VERIFICATION_NO_PR", "ISSUE_CLOSED_UPSTREAM"] as const;
export type NoPrTerminalReason = (typeof NO_PR_TERMINAL_REASONS)[number];

export function isNoPrTerminalReason(value: string | null | undefined): value is NoPrTerminalReason {
  return Boolean(value && NO_PR_TERMINAL_REASONS.includes(value as NoPrTerminalReason));
}

export function normalizePrEvidenceCauseCode(value: string | null | undefined): PrEvidenceCauseCode {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (PR_EVIDENCE_CAUSE_CODES.includes(normalized as PrEvidenceCauseCode)) {
    return normalized as PrEvidenceCauseCode;
  }
  return "UNKNOWN";
}

export function formatPrEvidenceCauseCodeLine(causeCode: string | null | undefined): string {
  return `PR_EVIDENCE_CAUSE_CODE=${normalizePrEvidenceCauseCode(causeCode)}`;
}

export type PrEvidenceCompletionInput = {
  attemptedOutcome: RalphRunOutcome;
  completionKind?: "pr" | "verified" | null;
  issueLinked: boolean;
  prUrl?: string | null;
  noPrTerminalReason?: string | null;
  causeCode?: string | null;
};

export type PrEvidenceCompletionDecision = {
  finalOutcome: RalphRunOutcome;
  reasonCode: string | null;
  missingPrEvidence: boolean;
  causeCode: PrEvidenceCauseCode | null;
};

export function evaluatePrEvidenceCompletion(input: PrEvidenceCompletionInput): PrEvidenceCompletionDecision {
  if (input.attemptedOutcome !== "success") {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false, causeCode: null };
  }

  if (!input.issueLinked) {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false, causeCode: null };
  }

  const hasPrUrl = Boolean(input.prUrl?.trim());
  if (hasPrUrl) {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false, causeCode: null };
  }

  if (isNoPrTerminalReason(input.noPrTerminalReason)) {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false, causeCode: null };
  }

  return {
    finalOutcome: "escalated",
    reasonCode: "missing_pr_url",
    missingPrEvidence: true,
    causeCode: normalizePrEvidenceCauseCode(input.causeCode),
  };
}
