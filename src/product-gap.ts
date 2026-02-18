export type ProductGapMarkerState = "product-gap" | "no-product-gap" | "none";

const PRODUCT_GAP_MARKER = /^\s*(?:[-*]\s+)?PRODUCT\s+GAP\s*:/i;
const NO_PRODUCT_GAP_MARKER = /^\s*(?:[-*]\s+)?NO\s+PRODUCT\s+GAP\s*:/i;

function splitLines(output: string): string[] {
  return String(output ?? "").split(/\r?\n/);
}

/**
 * Parse marker state from a single output block.
 * Precedence is deterministic: any NO PRODUCT GAP marker wins.
 */
export function detectProductGapMarker(output: string): ProductGapMarkerState {
  let sawProductGap = false;

  for (const line of splitLines(output)) {
    if (NO_PRODUCT_GAP_MARKER.test(line)) return "no-product-gap";
    if (PRODUCT_GAP_MARKER.test(line)) sawProductGap = true;
  }

  return sawProductGap ? "product-gap" : "none";
}

/**
 * Resolve marker state across multiple outputs.
 * Global precedence is deterministic: any NO PRODUCT GAP marker overrides PRODUCT GAP.
 */
export function resolveProductGapAcrossOutputs(outputs: string[]): ProductGapMarkerState {
  let sawProductGap = false;

  for (const output of outputs) {
    const state = detectProductGapMarker(output);
    if (state === "no-product-gap") return "no-product-gap";
    if (state === "product-gap") sawProductGap = true;
  }

  return sawProductGap ? "product-gap" : "none";
}

/**
 * Check if output indicates an effective product gap (should escalate).
 */
export function hasProductGap(output: string): boolean {
  return detectProductGapMarker(output) === "product-gap";
}
