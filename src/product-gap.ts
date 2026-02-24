/**
 * Check if the output indicates a product gap (should escalate).
 * Keep this conservative: only explicit line-start markers.
 */
const PRODUCT_GAP_MARKER = /^(?!\s*(?:[-*]\s+)?NO\s+PRODUCT\s+GAP\s*:)\s*(?:[-*]\s+)?PRODUCT\s+GAP\s*:/im;
const PRODUCT_GAP_REASON_LINE = /^(?!\s*(?:[-*]\s+)?NO\s+PRODUCT\s+GAP\s*:)\s*(?:[-*]\s+)?PRODUCT\s+GAP\s*:\s*(.+)$/gim;

const DETERMINISTIC_ARTIFACT_KEYWORDS = [
  "claims/canonical.jsonl",
  "canonical claim",
  "canonical claims",
  "docs/product/deterministic-gates.md",
  "deterministic gate",
  "gate artifact",
  "gate artifacts",
];

const MISSING_SIGNAL_KEYWORDS = ["missing", "not found", "absent", "unavailable", "does not exist", "can't find", "cannot find"];

export function hasProductGap(output: string): boolean {
  // This must never match "NO PRODUCT GAP:".
  return PRODUCT_GAP_MARKER.test(output);
}

function extractProductGapReasons(output: string): string[] {
  const reasons: string[] = [];
  const normalized = String(output ?? "");
  for (const match of normalized.matchAll(PRODUCT_GAP_REASON_LINE)) {
    const reason = String(match[1] ?? "").trim();
    if (reason) reasons.push(reason);
  }
  return reasons;
}

export function hasMissingDeterministicArtifactGap(output: string): boolean {
  const reasons = extractProductGapReasons(output);
  for (const reason of reasons) {
    const normalized = reason.toLowerCase();
    const hasArtifactKeyword = DETERMINISTIC_ARTIFACT_KEYWORDS.some((keyword) => normalized.includes(keyword));
    const hasMissingSignal = MISSING_SIGNAL_KEYWORDS.some((keyword) => normalized.includes(keyword));
    if (hasArtifactKeyword && hasMissingSignal) return true;
  }
  return false;
}

export function shouldEscalateProductGap(output: string, opts: { deterministicArtifactContractRequired: boolean }): boolean {
  if (!hasProductGap(output)) return false;
  if (opts.deterministicArtifactContractRequired) return true;
  if (hasMissingDeterministicArtifactGap(output)) return false;
  return true;
}
