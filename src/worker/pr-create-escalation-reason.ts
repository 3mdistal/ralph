import { classifyOpencodeFailure, type OpencodeFailureClassification } from "../opencode-error-classifier";

const MAX_DETAILS_CHARS = 400;

function toBoundedText(input: string): string {
  const text = input.trim();
  if (text.length <= MAX_DETAILS_CHARS) return text;
  return `${text.slice(0, Math.max(0, MAX_DETAILS_CHARS - 3)).trimEnd()}...`;
}

export type PrCreateEscalationReason = {
  reason: string;
  details?: string;
  classification: OpencodeFailureClassification | null;
};

export function derivePrCreateEscalationReason(params: {
  continueAttempts: number;
  evidence: Array<string | null | undefined>;
}): PrCreateEscalationReason {
  const normalizedEvidence = params.evidence
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);

  const classification = classifyOpencodeFailure(normalizedEvidence.join("\n\n"));
  if (classification) {
    const details = toBoundedText(
      `No PR URL observed after ${params.continueAttempts} continue attempts. Root-cause classification detected from run output.`
    );
    return {
      reason: classification.reason,
      details,
      classification,
    };
  }

  return {
    reason: `Agent completed but did not create a PR after ${params.continueAttempts} continue attempts`,
    classification: null,
  };
}
