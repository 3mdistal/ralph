import type { BlockedSource } from "../blocked-sources";
import { classifyOpencodeFailure } from "../opencode-error-classifier";

export type PrCreateFailureClassification = "non-retriable" | "transient" | "unknown";

export type PrCreateFailureDecision = {
  classification: PrCreateFailureClassification;
  reason: string;
  blockedSource?: BlockedSource;
};

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "").trim();
}

export function classifyPrCreateFailure(text: string | null | undefined): PrCreateFailureDecision {
  const output = normalizeText(text);
  if (!output) {
    return {
      classification: "unknown",
      reason: "No PR-create failure signal detected.",
    };
  }

  const opencode = classifyOpencodeFailure(output);
  if (opencode?.code === "permission-denied") {
    return {
      classification: "non-retriable",
      reason: opencode.reason,
      blockedSource: opencode.blockedSource,
    };
  }

  if (
    /HTTP\s+401|HTTP\s+403|unauthorized|forbidden|bad credentials|resource not accessible by integration|write access to repository not granted|insufficient\s+permission|not\s+permitted|operation\s+not\s+permitted|permission denied/i.test(
      output
    )
  ) {
    return {
      classification: "non-retriable",
      reason: "Blocked: PR-create capability denied by GitHub policy/permissions.",
      blockedSource: "auth",
    };
  }

  if (
    /HTTP\s+429|HTTP\s+502|HTTP\s+503|HTTP\s+504|secondary rate limit|abuse detection|rate limit|Retry-After|timed out|timeout|ECONNRESET|EAI_AGAIN|ENOTFOUND|connection reset|temporarily unavailable|gateway timeout|service unavailable/i.test(
      output
    )
  ) {
    return {
      classification: "transient",
      reason: "Transient PR-create failure detected.",
    };
  }

  return {
    classification: "unknown",
    reason: "Unclassified PR-create failure.",
  };
}

export function extractRetryAfterMs(text: string | null | undefined): number | null {
  const output = normalizeText(text);
  if (!output) return null;

  const secondsHeader = /Retry-After\s*[:=]\s*(\d{1,6})/i.exec(output);
  if (secondsHeader) {
    const seconds = Number(secondsHeader[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  const secondsPhrase = /retry\s+after\s+(\d{1,6})\s*(s|sec|secs|second|seconds)\b/i.exec(output);
  if (secondsPhrase) {
    const seconds = Number(secondsPhrase[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  const minutesPhrase = /retry\s+after\s+(\d{1,6})\s*(m|min|mins|minute|minutes)\b/i.exec(output);
  if (minutesPhrase) {
    const minutes = Number(minutesPhrase[1]);
    if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60_000;
  }

  return null;
}

export function computePrCreateRetryDelayMs(params: { attempt: number; retryAfterMs?: number | null; jitterSeed?: number }): number {
  const boundedAttempt = Math.max(1, Math.floor(params.attempt || 1));
  const retryAfterMs = Number.isFinite(params.retryAfterMs as number) ? Math.max(0, Math.floor(params.retryAfterMs as number)) : null;
  if (retryAfterMs !== null) {
    return Math.min(60_000, retryAfterMs);
  }

  const baseMs = Math.min(20_000, 1000 * Math.pow(2, Math.max(0, boundedAttempt - 1)));
  const seed = Number.isFinite(params.jitterSeed as number) ? Math.max(0, Math.min(1, Number(params.jitterSeed))) : Math.random();
  const jitterMs = Math.floor(seed * 400);
  return baseMs + jitterMs;
}
