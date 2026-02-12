import type { BlockedSource } from "../blocked-sources";
import type { OpencodeFailureClassification } from "../opencode-error-classifier";

export type PrCreateFailureClass = "non-retriable" | "transient" | "unknown";

export type PrCreateFailurePolicy = {
  classification: PrCreateFailureClass;
  reason: string;
  blockedSource?: BlockedSource;
};

const NON_RETRIABLE_PATTERNS: RegExp[] = [
  /\bHTTP\s*401\b/i,
  /\bHTTP\s*403\b/i,
  /missing\s+gh_token/i,
  /bad\s+credentials/i,
  /authentication\s+required/i,
  /resource\s+not\s+accessible\s+by\s+integration/i,
  /insufficient\s+permissions?/i,
  /permission\s+denied/i,
  /not\s+authorized/i,
  /forbidden/i,
  /pull\s+request\s+creation\s+(?:is\s+)?disabled/i,
  /invalid_function_parameters/i,
  /blocked:permission:/i,
  /blocked:profile-unresolvable:/i,
  /opencode\s+config\s+invalid/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /\bHTTP\s*429\b/i,
  /secondary\s+rate\s+limit/i,
  /abuse\s+detection/i,
  /temporarily\s+blocked/i,
  /rate\s+limit\s+exceeded/i,
  /retry-after/i,
  /timed\s*out/i,
  /timeout/i,
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bHTTP\s*5\d\d\b/i,
  /network\s+error/i,
  /service\s+unavailable/i,
];

function normalizeEvidence(input: Array<string | null | undefined>): string {
  return input
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

export function classifyPrCreateFailurePolicy(params: {
  evidence: Array<string | null | undefined>;
  opencodeClassification?: OpencodeFailureClassification | null;
}): PrCreateFailurePolicy {
  const text = normalizeEvidence(params.evidence);
  const opencode = params.opencodeClassification ?? null;

  if (opencode?.code === "permission-denied") {
    return {
      classification: "non-retriable",
      reason: opencode.reason,
      blockedSource: "permission",
    };
  }

  if (opencode?.code === "config-invalid") {
    return {
      classification: "non-retriable",
      reason: opencode.reason,
      blockedSource: "opencode-config-invalid",
    };
  }

  if (opencode?.code === "profile-unresolvable") {
    return {
      classification: "non-retriable",
      reason: opencode.reason,
      blockedSource: "profile-unresolvable",
    };
  }

  if (text) {
    if (NON_RETRIABLE_PATTERNS.some((pattern) => pattern.test(text))) {
      return {
        classification: "non-retriable",
        reason: "PR creation blocked by policy/permission denial",
        blockedSource: "permission",
      };
    }

    if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
      return {
        classification: "transient",
        reason: "PR creation failed due to transient GitHub/API conditions",
      };
    }
  }

  return {
    classification: "unknown",
    reason: "PR creation failed without a recognized policy/transient signature",
  };
}

export function computePrCreateRetryBackoffMs(params: { attempt: number; capMs?: number }): number {
  const attempt = Number.isFinite(params.attempt) ? Math.max(1, Math.floor(params.attempt)) : 1;
  const capMs = Number.isFinite(params.capMs) ? Math.max(1_000, Math.floor(params.capMs ?? 60_000)) : 60_000;
  const backoffMs = Math.min(capMs, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.floor(backoffMs));
}

export function shouldAttemptPrCreateLeaseSelfHeal(params: {
  existingCreatedAtIso: string | null | undefined;
  nowMs: number;
  minAgeMs: number;
  alreadyAttempted: boolean;
}): boolean {
  if (params.alreadyAttempted) return false;
  const createdAtIso = String(params.existingCreatedAtIso ?? "").trim();
  if (!createdAtIso) return false;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return false;
  const minAgeMs = Number.isFinite(params.minAgeMs) ? Math.max(0, Math.floor(params.minAgeMs)) : 0;
  return params.nowMs - createdMs >= minAgeMs;
}
