 import { redactSensitiveText } from "../redaction";
 import { GitHubApiError } from "./client";

const MIN_BACKOFF_MS = 60_000;
const SAFETY_BUFFER_MS = 2000;
const JITTER_RANGE_MS = 5000;
const MAX_MESSAGE_LENGTH = 400;

export type GitHubRateLimitPauseResult = {
  throttledAtIso: string;
  resumeAtIso: string;
  usageSnapshotJson: string;
};

export function computeGitHubRateLimitPause(params: {
  nowMs: number;
  stage: string;
  error: unknown;
  priorResumeAtIso?: string | null;
}): GitHubRateLimitPauseResult | null {
  const error = params.error;
  if (!(error instanceof GitHubApiError)) return null;
  if (error.code !== "rate_limit") return null;

  const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const priorResumeAtTs = parseIsoMs(params.priorResumeAtIso);
  const resumeAtTs = computeResumeAtMs({
    nowMs,
    priorResumeAtTs,
    errorResumeAtTs: error.resumeAtTs,
    jitterSeed: error.requestId || params.stage || "github-rate-limit",
  });

  const throttledAtIso = new Date(nowMs).toISOString();
  const resumeAtIso = new Date(resumeAtTs).toISOString();

  const message = buildBoundedMessage({ message: error.message, responseText: error.responseText });

  const snapshot = {
    kind: "github-rate-limit",
    stage: params.stage,
    status: error.status,
    requestId: error.requestId,
    resumeAt: resumeAtIso,
    message,
  };

  return {
    throttledAtIso,
    resumeAtIso,
    usageSnapshotJson: JSON.stringify(snapshot),
  };
}

function computeResumeAtMs(params: {
  nowMs: number;
  priorResumeAtTs: number | null;
  errorResumeAtTs: number | null;
  jitterSeed: string;
}): number {
  const base = Math.max(
    params.priorResumeAtTs ?? 0,
    params.errorResumeAtTs ?? 0,
    params.nowMs + MIN_BACKOFF_MS
  );
  const jitter = computeDeterministicJitterMs(params.jitterSeed, JITTER_RANGE_MS);
  return base + SAFETY_BUFFER_MS + jitter;
}

function computeDeterministicJitterMs(seed: string, rangeMs: number): number {
  if (rangeMs <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  return unsigned % rangeMs;
}

function parseIsoMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

 function buildBoundedMessage(params: { message?: string | null; responseText?: string | null }): string {
   const parts = [params.message, params.responseText].filter((value) => typeof value === "string" && value.trim());
   if (parts.length === 0) return "";
   const combined = parts.join("; ").replace(/\s+/g, " ").trim();
   const redacted = redactSensitiveText(combined);
   return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : redacted;
 }
