export type MetricsQuality = "ok" | "missing" | "partial" | "too_large" | "timeout" | "error";

export type NormalizedEvent = {
  type: "run-start" | "run-end" | "step-start" | "tool-start" | "tool-end" | "anomaly";
  ts: number | null;
  stepTitle?: string | null;
  step?: number | null;
  toolName?: string | null;
  callId?: string | null;
};

export type SessionStepMetrics = {
  stepTitle: string;
  wallTimeMs: number | null;
  toolCallCount: number;
  toolTimeMs: number | null;
  anomalyCount: number;
  recentBurstAtEnd: boolean;
  tokensTotal: number | null;
  eventCount: number;
  parseErrorCount: number;
  quality: MetricsQuality;
};

export type SessionMetrics = {
  sessionId: string;
  wallTimeMs: number | null;
  toolCallCount: number;
  toolTimeMs: number | null;
  anomalyCount: number;
  recentBurstAtEnd: boolean;
  tokensTotal: number | null;
  stepCount: number;
  eventCount: number;
  parseErrorCount: number;
  quality: MetricsQuality;
  steps: SessionStepMetrics[];
};

export type RunMetrics = {
  runId: string;
  wallTimeMs: number | null;
  toolCallCount: number;
  toolTimeMs: number | null;
  anomalyCount: number;
  recentBurstAtEnd: boolean;
  tokensTotal: number | null;
  tokensComplete: boolean;
  eventCount: number;
  parseErrorCount: number;
  quality: MetricsQuality;
};

export type RunStepMetrics = {
  runId: string;
  stepTitle: string;
  wallTimeMs: number | null;
  toolCallCount: number;
  toolTimeMs: number | null;
  anomalyCount: number;
  recentBurstAtEnd: boolean;
  tokensTotal: number | null;
  eventCount: number;
  parseErrorCount: number;
  quality: MetricsQuality;
};
