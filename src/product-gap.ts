/**
 * Check if the output indicates a product gap (should escalate).
 * Keep this conservative: only explicit line-start markers.
 */
export function hasProductGap(output: string): boolean {
  // This must never match "NO PRODUCT GAP:".
  const productGapMarker = /^(?!\s*(?:[-*]\s+)?NO\s+PRODUCT\s+GAP\s*:)\s*(?:[-*]\s+)?PRODUCT\s+GAP\s*:/im;
  return productGapMarker.test(output);
}
