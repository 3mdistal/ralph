/**
 * Check if the output indicates a product gap (should escalate).
 * Keep this conservative: only explicit line-start markers.
 */
export function hasProductGap(output: string): boolean {
  const text = String(output ?? "");
  const noProductGapMarker = /^\s*(?:[-*]\s+)?NO\s+PRODUCT\s+GAP\s*:/im;
  if (noProductGapMarker.test(text)) return false;
  const productGapMarker = /^\s*(?:[-*]\s+)?PRODUCT\s+GAP\s*:/im;
  return productGapMarker.test(text);
}
