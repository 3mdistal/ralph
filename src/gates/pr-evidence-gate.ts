import type { RalphRunOutcome } from "../state";

export type PrEvidenceCompletionInput = {
  attemptedOutcome: RalphRunOutcome;
  completionKind?: "pr" | "verified" | null;
  issueLinked: boolean;
  prUrl?: string | null;
};

export type PrEvidenceCompletionDecision = {
  finalOutcome: RalphRunOutcome;
  reasonCode: string | null;
  missingPrEvidence: boolean;
};

export function evaluatePrEvidenceCompletion(input: PrEvidenceCompletionInput): PrEvidenceCompletionDecision {
  if (input.attemptedOutcome !== "success") {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false };
  }

  if (!input.issueLinked) {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false };
  }

  if (input.completionKind === "verified") {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false };
  }

  const hasPrUrl = Boolean(input.prUrl?.trim());
  if (hasPrUrl) {
    return { finalOutcome: input.attemptedOutcome, reasonCode: null, missingPrEvidence: false };
  }

  return {
    finalOutcome: "escalated",
    reasonCode: "missing_pr_url",
    missingPrEvidence: true,
  };
}
