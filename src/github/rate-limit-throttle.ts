import { GitHubApiError } from "./client";

export const MIN_GITHUB_RATE_LIMIT_BACKOFF_MS = 60_000;

export type GitHubRateLimitSnapshot = {
  kind: "github-rate-limit";
  v: 1;
  status: number;
  requestId: string | null;
  resumeAt: string;
};

export type GitHubRateLimitThrottlePlan = {
  resumeAtTs: number;
  throttledAt: string;
  resumeAt: string;
  snapshot: GitHubRateLimitSnapshot;
};

export function planGitHubRateLimitThrottle(nowMs: number, error: unknown): GitHubRateLimitThrottlePlan | null {
  if (!(error instanceof GitHubApiError)) return null;
  if (error.code !== "rate_limit") return null;

  const baseResumeAt = typeof error.resumeAtTs === "number" && Number.isFinite(error.resumeAtTs) ? error.resumeAtTs : 0;
  const effectiveResumeAtTs = Math.max(baseResumeAt, nowMs + MIN_GITHUB_RATE_LIMIT_BACKOFF_MS);
  const resumeAt = new Date(effectiveResumeAtTs).toISOString();
  const throttledAt = new Date(nowMs).toISOString();
  const snapshot: GitHubRateLimitSnapshot = {
    kind: "github-rate-limit",
    v: 1,
    status: error.status,
    requestId: error.requestId,
    resumeAt,
  };

  return {
    resumeAtTs: effectiveResumeAtTs,
    throttledAt,
    resumeAt,
    snapshot,
  };
}
