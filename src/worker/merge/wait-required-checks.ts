import {
  REQUIRED_CHECKS_MAX_POLL_MS,
  applyRequiredChecksJitter,
  buildRequiredChecksSignature,
  computeRequiredChecksDelay,
  extractPullRequestNumber,
  summarizeRequiredChecks,
  type PrCheck,
  type RequiredChecksSummary,
} from "../lanes/required-checks";

import type { PullRequestMergeStateStatus } from "./pull-request-io";

export async function waitForRequiredChecks(params: {
  repo: string;
  prUrl: string;
  requiredChecks: string[];
  opts: { timeoutMs: number; pollIntervalMs: number };
  getPullRequestChecks: (prUrl: string) => Promise<{
    headSha: string;
    mergeStateStatus: PullRequestMergeStateStatus | null;
    baseRefName: string;
    checks: PrCheck[];
  }>;
  recordCiGateSummary: (prUrl: string, summary: RequiredChecksSummary) => void;
  shouldLogBackoff?: (logKey: string) => boolean;
  log?: (message: string) => void;
}): Promise<{
  headSha: string;
  mergeStateStatus: PullRequestMergeStateStatus | null;
  baseRefName: string;
  summary: RequiredChecksSummary;
  checks: PrCheck[];
  timedOut: boolean;
  stopReason?: "merge-conflict";
}> {
  const startedAt = Date.now();
  let pollDelayMs = params.opts.pollIntervalMs;
  let lastSignature: string | null = null;
  let attempt = 0;
  const prNumber = extractPullRequestNumber(params.prUrl);
  const logKey = `ralph:checks:${params.repo}:${prNumber ?? params.prUrl}`;
  let last: {
    headSha: string;
    mergeStateStatus: PullRequestMergeStateStatus | null;
    baseRefName: string;
    summary: RequiredChecksSummary;
    checks: PrCheck[];
  } | null = null;

  while (Date.now() - startedAt < params.opts.timeoutMs) {
    const { headSha, mergeStateStatus, baseRefName, checks } = await params.getPullRequestChecks(params.prUrl);
    const summary = summarizeRequiredChecks(checks, params.requiredChecks);
    last = { headSha, mergeStateStatus, baseRefName, summary, checks };

    if (mergeStateStatus === "DIRTY") {
      params.recordCiGateSummary(params.prUrl, summary);
      return {
        headSha,
        mergeStateStatus,
        baseRefName,
        summary,
        checks,
        timedOut: false,
        stopReason: "merge-conflict",
      };
    }

    if (summary.status === "success" || summary.status === "failure") {
      params.recordCiGateSummary(params.prUrl, summary);
      return { headSha, mergeStateStatus, baseRefName, summary, checks, timedOut: false };
    }

    const signature = buildRequiredChecksSignature(summary);
    const decision = computeRequiredChecksDelay({
      baseIntervalMs: params.opts.pollIntervalMs,
      maxIntervalMs: REQUIRED_CHECKS_MAX_POLL_MS,
      attempt,
      lastSignature,
      nextSignature: signature,
      pending: summary.status === "pending",
    });
    attempt = decision.nextAttempt;
    pollDelayMs = decision.delayMs;
    lastSignature = signature;

    if (decision.reason === "backoff" && pollDelayMs > params.opts.pollIntervalMs) {
      if (params.shouldLogBackoff?.(logKey)) {
        params.log?.(
          `[ralph:worker:${params.repo}] Required checks pending; backing off polling to ${Math.round(pollDelayMs / 1000)}s`
        );
      }
    }

    await new Promise((r) => setTimeout(r, applyRequiredChecksJitter(pollDelayMs)));
  }

  if (last) {
    params.recordCiGateSummary(params.prUrl, last.summary);
    return { ...last, timedOut: true };
  }

  // Should be unreachable, but keep types happy.
  const fallback = await params.getPullRequestChecks(params.prUrl);
  const fallbackSummary = summarizeRequiredChecks(fallback.checks, params.requiredChecks);
  params.recordCiGateSummary(params.prUrl, fallbackSummary);
  return {
    headSha: fallback.headSha,
    mergeStateStatus: fallback.mergeStateStatus,
    baseRefName: fallback.baseRefName,
    summary: fallbackSummary,
    checks: fallback.checks,
    timedOut: true,
  };
}
