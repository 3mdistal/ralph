/**
 * Routing decision parser for /next-task output
 */

export interface RoutingDecision {
  decision: "proceed" | "escalate";
  confidence: "high" | "medium" | "low";
  escalation_reason: string | null;
  plan_summary?: string | null;
}

/**
 * Parse the routing decision JSON from /next-task output.
 * Handles loose JSON (unquoted keys) that the model sometimes outputs.
 */
export function parseRoutingDecision(output: string): RoutingDecision | null {
  // Look for a JSON-like block with "decision" in it
  // Could be in a code block or inline
  
  // Try to find JSON in code block first
  const codeBlockMatch = output.match(/```(?:json)?\s*(\{[\s\S]*?decision[\s\S]*?\})\s*```/i);
  if (codeBlockMatch) {
    const parsed = tryParseLooseJson(codeBlockMatch[1]);
    if (parsed) return normalizeDecision(parsed);
  }
  
  // Try to find inline JSON
  const inlineMatch = output.match(/\{[^{}]*decision[^{}]*\}/i);
  if (inlineMatch) {
    const parsed = tryParseLooseJson(inlineMatch[0]);
    if (parsed) return normalizeDecision(parsed);
  }
  
  // Try to find it in a "Routing Decision" section
  const sectionMatch = output.match(/routing\s*decision[:\s]*\{([\s\S]*?)\}/i);
  if (sectionMatch) {
    const parsed = tryParseLooseJson(`{${sectionMatch[1]}}`);
    if (parsed) return normalizeDecision(parsed);
  }
  
  return null;
}

/**
 * Try to parse loose JSON (handles unquoted keys)
 */
function tryParseLooseJson(str: string): Record<string, any> | null {
  // First try standard JSON
  try {
    return JSON.parse(str);
  } catch {}
  
  // Try to fix common issues:
  // 1. Unquoted keys: decision: -> "decision":
  // 2. Unquoted string values: proceed -> "proceed"
  // 3. null without quotes (this is valid JSON but let's be safe)
  
  let fixed = str
    // Add quotes around unquoted keys
    .replace(/(\s*)(\w+)(\s*):/g, '$1"$2"$3:')
    // Add quotes around unquoted string values (not null, true, false, numbers)
    .replace(/:\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*([,}])/g, (match, value, end) => {
      if (["null", "true", "false"].includes(value.toLowerCase())) {
        return `: ${value.toLowerCase()}${end}`;
      }
      return `: "${value}"${end}`;
    });
  
  try {
    return JSON.parse(fixed);
  } catch {}
  
  return null;
}

/**
 * Normalize parsed object to RoutingDecision interface
 */
function normalizeDecision(obj: Record<string, any>): RoutingDecision | null {
  const decision = obj.decision?.toLowerCase();
  if (decision !== "proceed" && decision !== "escalate") {
    return null;
  }
  
  const confidence = obj.confidence?.toLowerCase() ?? "medium";
  const validConfidence = ["high", "medium", "low"].includes(confidence) 
    ? confidence as "high" | "medium" | "low"
    : "medium";
  
  return {
    decision,
    confidence: validConfidence,
    escalation_reason: obj.escalation_reason ?? obj.escalationReason ?? null,
    plan_summary: obj.plan_summary ?? obj.planSummary ?? null,
  };
}

/**
 * Check if the output indicates a product gap (should escalate)
 */
export function hasProductGap(output: string): boolean {
  // IMPORTANT: Keep this conservative.
  // Only treat an explicit marker as a product gap (no fuzzy heuristics).
  // This must never match "NO PRODUCT GAP:".
  const productGapMarker = /^(?!\s*(?:[-*]\s+)?NO\s+PRODUCT\s+GAP\s*:)\s*(?:[-*]\s+)?PRODUCT\s+GAP\s*:/im;

  return productGapMarker.test(output);
}

/**
 * Extract PR URL from session output
 */
export function extractPrUrls(output: string): string[] {
  const matches = output.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/g);
  return matches ?? [];
}

export function extractFirstPrUrl(output: string): string | null {
  const urls = extractPrUrls(output);
  return urls[0] ?? null;
}

export function extractLatestPrUrl(output: string): string | null {
  const urls = extractPrUrls(output);
  return urls.length > 0 ? urls[urls.length - 1] : null;
}

export function pickPrUrlForRepo(urls: string[], repo: string): string | null {
  if (urls.length === 0) return null;
  const normalizedRepo = repo.trim().toLowerCase();
  if (!normalizedRepo) return urls[urls.length - 1] ?? null;
  const repoSuffix = `/${normalizedRepo}/pull/`;
  const matching = urls.filter((url) => url.toLowerCase().includes(repoSuffix));
  if (matching.length === 0) return null;
  return matching[matching.length - 1] ?? null;
}

export function extractPrUrl(output: string): string | null {
  return extractFirstPrUrl(output);
}

/**
 * Prefer best-effort structured PR URL if available; otherwise return the latest PR URL in output.
 */
export function extractPrUrlFromSession(result: { output: string; prUrl?: string }): string | null {
  if (result.prUrl) return result.prUrl;
  return extractLatestPrUrl(result.output);
}
