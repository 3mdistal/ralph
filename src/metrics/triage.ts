import type { RunMetrics, RunStepMetrics } from "./types";
import type { RalphRunOutcome } from "../state";

export type RunTriageReason =
  | "high_tokens"
  | "high_tool_churn"
  | "high_anomalies"
  | "anomaly_recent_burst"
  | "long_wall_time"
  | "long_step"
  | "high_tokens_non_success"
  | "metrics_incomplete";

export type RunTriageResult = {
  score: number;
  reasons: RunTriageReason[];
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function log10(value: number): number {
  return Math.log(value) / Math.log(10);
}

function getMaxStepWallTimeMs(steps: RunStepMetrics[]): number | null {
  let max = 0;
  for (const step of steps) {
    const ms = step.wallTimeMs;
    if (typeof ms === "number" && Number.isFinite(ms) && ms > max) {
      max = ms;
    }
  }
  return max > 0 ? max : null;
}

export function computeRunTriage(params: {
  run: RunMetrics;
  steps: RunStepMetrics[];
  outcome: RalphRunOutcome | null;
}): RunTriageResult {
  const tokensTotal = typeof params.run.tokensTotal === "number" ? params.run.tokensTotal : null;
  const toolCalls = Number.isFinite(params.run.toolCallCount) ? Math.max(0, Math.floor(params.run.toolCallCount)) : 0;
  const anomalyCount = Number.isFinite(params.run.anomalyCount) ? Math.max(0, Math.floor(params.run.anomalyCount)) : 0;
  const wallTimeMs = typeof params.run.wallTimeMs === "number" ? Math.max(0, Math.floor(params.run.wallTimeMs)) : null;
  const maxStepWallTimeMs = getMaxStepWallTimeMs(params.steps);

  const tokenLog = tokensTotal != null && tokensTotal > 0 ? log10(tokensTotal + 1) : null;
  // 10k -> 0, 100k -> 0.5, 1M -> 1
  const tokenNorm = tokenLog != null ? clamp01((tokenLog - 4) / 2) : 0;
  // ~100 -> ~0.67, 1000 -> 1
  const toolNorm = clamp01(log10(toolCalls + 1) / 3);
  const anomalyNorm = clamp01(anomalyCount / 20);
  const wallHours = wallTimeMs != null ? wallTimeMs / (60 * 60 * 1000) : null;
  const wallNorm = wallHours != null ? clamp01(wallHours / 2) : 0;
  const maxStepHours = maxStepWallTimeMs != null ? maxStepWallTimeMs / (60 * 60 * 1000) : null;
  const maxStepNorm = maxStepHours != null ? clamp01(maxStepHours / 1) : 0;

  let score = 0;
  score += tokenNorm * 35;
  score += toolNorm * 20;
  score += anomalyNorm * 20;
  if (params.run.recentBurstAtEnd) score += 8;
  score += wallNorm * 15;
  score += maxStepNorm * 10;

  const nonSuccess = params.outcome != null && params.outcome !== "success";
  if (nonSuccess) {
    score += tokenNorm * 12;
  }

  if (!Number.isFinite(score) || score < 0) score = 0;
  if (score > 100) score = 100;

  const reasons: RunTriageReason[] = [];

  if (tokensTotal != null && tokensTotal >= 100_000) reasons.push("high_tokens");
  if (toolCalls >= 120) reasons.push("high_tool_churn");
  if (anomalyCount >= 10) reasons.push("high_anomalies");
  if (params.run.recentBurstAtEnd) reasons.push("anomaly_recent_burst");
  if (wallTimeMs != null && wallTimeMs >= 60 * 60 * 1000) reasons.push("long_wall_time");
  if (maxStepWallTimeMs != null && maxStepWallTimeMs >= 30 * 60 * 1000) reasons.push("long_step");
  if (nonSuccess && tokensTotal != null && tokensTotal >= 50_000) reasons.push("high_tokens_non_success");
  if (params.run.quality !== "ok") reasons.push("metrics_incomplete");

  return {
    score: Math.round(score),
    reasons,
  };
}
