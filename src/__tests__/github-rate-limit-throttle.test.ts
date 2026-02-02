import { describe, expect, test } from "bun:test";

import { GitHubApiError } from "../github/client";
import { computeGitHubRateLimitPause } from "../github/rate-limit-throttle";

function buildRateLimitError(params: { resumeAtTs: number | null; requestId?: string }): GitHubApiError {
  return new GitHubApiError({
    message: "API rate limit exceeded",
    code: "rate_limit",
    status: 403,
    requestId: params.requestId ?? "req-1",
    responseText: "API rate limit exceeded for installation ID 123",
    resumeAtTs: params.resumeAtTs,
  });
}

describe("computeGitHubRateLimitPause", () => {
  test("uses resumeAtTs when provided and builds snapshot", () => {
    const nowMs = 1_000_000;
    const resumeAtTs = nowMs + 120_000;
    const result = computeGitHubRateLimitPause({
      nowMs,
      stage: "sync",
      error: buildRateLimitError({ resumeAtTs, requestId: "req-abc" }),
    });

    expect(result).not.toBeNull();
    if (!result) return;
    const parsedResumeAt = Date.parse(result.resumeAtIso);
    expect(parsedResumeAt).toBeGreaterThanOrEqual(resumeAtTs + 2000);
    expect(parsedResumeAt).toBeLessThan(resumeAtTs + 7000);

    const snapshot = JSON.parse(result.usageSnapshotJson);
    expect(snapshot.kind).toBe("github-rate-limit");
    expect(snapshot.stage).toBe("sync");
    expect(snapshot.requestId).toBe("req-abc");
    expect(snapshot.status).toBe(403);
    expect(snapshot.resumeAt).toBe(result.resumeAtIso);
    expect(typeof snapshot.message).toBe("string");
  });

  test("falls back to minimum backoff when resumeAtTs is missing", () => {
    const nowMs = 2_000_000;
    const result = computeGitHubRateLimitPause({
      nowMs,
      stage: "resume",
      error: buildRateLimitError({ resumeAtTs: null }),
    });

    expect(result).not.toBeNull();
    if (!result) return;
    const parsedResumeAt = Date.parse(result.resumeAtIso);
    expect(parsedResumeAt - nowMs).toBeGreaterThanOrEqual(62_000);
    expect(parsedResumeAt - nowMs).toBeLessThan(67_000);
  });

  test("keeps resumeAt monotonic when prior resume is later", () => {
    const nowMs = 3_000_000;
    const priorResumeAtIso = new Date(nowMs + 300_000).toISOString();
    const result = computeGitHubRateLimitPause({
      nowMs,
      stage: "process",
      priorResumeAtIso,
      error: buildRateLimitError({ resumeAtTs: nowMs + 120_000 }),
    });

    expect(result).not.toBeNull();
    if (!result) return;
    const parsedResumeAt = Date.parse(result.resumeAtIso);
    expect(parsedResumeAt).toBeGreaterThanOrEqual(Date.parse(priorResumeAtIso) + 2000);
  });

  test("returns null for non-rate-limit errors", () => {
    const error = new GitHubApiError({
      message: "Forbidden",
      code: "auth",
      status: 403,
      requestId: "req-auth",
      responseText: "Forbidden",
    });

    const result = computeGitHubRateLimitPause({ nowMs: 4_000_000, stage: "process", error });
    expect(result).toBeNull();
  });
});
