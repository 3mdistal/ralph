import { classifyOpencodeFailure, type OpencodeFailureClassification } from "../opencode-error-classifier";
import { classifyPrCreateFailure } from "./pr-create-failure-policy";
import { formatPrEvidenceCauseCodeLine, type PrEvidenceCauseCode } from "../gates/pr-evidence-gate";

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
  causeCode: PrEvidenceCauseCode;
};

function inferCauseCodeFromClassification(classification: OpencodeFailureClassification | null): PrEvidenceCauseCode {
  if (!classification) return "UNKNOWN";
  if (classification.code === "permission-denied") return "POLICY_DENIED";
  return "UNKNOWN";
}

export function derivePrCreateEscalationReason(params: {
  continueAttempts: number;
  evidence: Array<string | null | undefined>;
  fallbackCauseCode?: PrEvidenceCauseCode | null;
}): PrCreateEscalationReason {
  const normalizedEvidence = params.evidence
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);

  const classification = classifyOpencodeFailure(normalizedEvidence.join("\n\n"));
  const causeCode = params.fallbackCauseCode ?? inferCauseCodeFromClassification(classification);
  if (classification) {
    const details = toBoundedText(
      [
        `No PR URL observed after ${params.continueAttempts} orchestrator PR-recovery attempts. Root-cause classification detected from run output.`,
        formatPrEvidenceCauseCodeLine(causeCode),
      ].join("\n")
    );
    return {
      reason: classification.reason,
      details,
      classification,
      causeCode,
    };
  }

  const prCreateDecision = classifyPrCreateFailure(normalizedEvidence.join("\n\n"));
  if (prCreateDecision.classification === "non-retriable") {
    const details = toBoundedText(
      [
        `No PR URL observed after ${params.continueAttempts} continue attempts. Non-retriable PR-create failure detected from run output.`,
        formatPrEvidenceCauseCodeLine(causeCode),
      ].join("\n")
    );
    return {
      reason: prCreateDecision.reason,
      details,
      classification: null,
      causeCode,
    };
  }

  return {
    reason: `No PR URL recovered after ${params.continueAttempts} orchestrator PR-recovery attempts`,
    classification: null,
    details: formatPrEvidenceCauseCodeLine(causeCode),
    causeCode,
  };
}
