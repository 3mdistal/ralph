import type { MetricsQuality, NormalizedEvent, RunMetrics, RunStepMetrics, SessionMetrics, SessionStepMetrics } from "./types";

const RECENT_BURST_WINDOW_MS = 10_000;
const RECENT_BURST_THRESHOLD = 20;

function normalizeStepTitle(value?: string | null): string {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : "unknown";
}

function addNullableDuration(target: { value: number | null }, delta: number): void {
  if (!Number.isFinite(delta) || delta < 0) return;
  target.value = (target.value ?? 0) + delta;
}

function computeRecentBurstAtEnd(anomalyTs: number[], endTs: number | null): boolean {
  if (!Number.isFinite(endTs ?? NaN)) return false;
  let count = 0;
  const end = endTs as number;
  for (const ts of anomalyTs) {
    if (end - ts < RECENT_BURST_WINDOW_MS) count += 1;
  }
  return count >= RECENT_BURST_THRESHOLD;
}

type MutableStep = {
  stepTitle: string;
  wallTimeMs: { value: number | null };
  toolCallCount: number;
  toolTimeMs: { value: number | null };
  anomalyCount: number;
  anomalyTs: number[];
  recentBurstAtEnd: boolean;
  endTs: number | null;
  eventCount: number;
  parseErrorCount: number;
  quality: MetricsQuality;
  tokensTotal: number | null;
};

function createStep(stepTitle: string, quality: MetricsQuality): MutableStep {
  return {
    stepTitle,
    wallTimeMs: { value: null },
    toolCallCount: 0,
    toolTimeMs: { value: null },
    anomalyCount: 0,
    anomalyTs: [],
    recentBurstAtEnd: false,
    endTs: null,
    eventCount: 0,
    parseErrorCount: 0,
    quality,
    tokensTotal: null,
  };
}

export function computeSessionMetrics(params: {
  sessionId: string;
  events: NormalizedEvent[];
  eventCount: number;
  parseErrorCount: number;
  tokensTotal: number | null;
  quality: MetricsQuality;
}): SessionMetrics {
  const stepMap = new Map<string, MutableStep>();
  const toolStarts = new Map<string, { ts: number; stepTitle: string }>();
  const anomalyTs: number[] = [];

  let runStartTs: number | null = null;
  let runEndTs: number | null = null;
  let lastEventTs: number | null = null;
  let stepCount = 0;

  let currentStepTitle: string | null = null;
  let currentStepStartTs: number | null = null;

  const runTotals = {
    wallTimeMs: { value: null as number | null },
    toolCallCount: 0,
    toolTimeMs: { value: null as number | null },
    anomalyCount: 0,
  };

  const getStep = (title: string): MutableStep => {
    const key = normalizeStepTitle(title);
    const existing = stepMap.get(key);
    if (existing) return existing;
    const created = createStep(key, params.quality);
    stepMap.set(key, created);
    return created;
  };

  const closeStep = (endTs: number | null): void => {
    if (!currentStepTitle || currentStepStartTs == null || endTs == null) return;
    const delta = endTs - currentStepStartTs;
    const step = getStep(currentStepTitle);
    addNullableDuration(step.wallTimeMs, delta);
    step.endTs = endTs;
  };

  for (const event of params.events) {
    const ts = event.ts;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      lastEventTs = ts;
    }

    let eventStepTitle = normalizeStepTitle(currentStepTitle);
    if ((event.type === "run-start" || event.type === "step-start") && event.stepTitle) {
      eventStepTitle = normalizeStepTitle(event.stepTitle);
    }
    const activeStep = getStep(eventStepTitle);
    activeStep.eventCount += 1;

    switch (event.type) {
      case "run-start": {
        if (runStartTs == null && ts != null) runStartTs = ts;
        if (!currentStepTitle && ts != null && event.stepTitle) {
          currentStepTitle = eventStepTitle;
          currentStepStartTs = ts;
          getStep(currentStepTitle);
        }
        break;
      }
      case "step-start": {
        if (ts != null) {
          closeStep(ts);
          currentStepTitle = eventStepTitle;
          currentStepStartTs = ts;
          stepCount += 1;
          getStep(currentStepTitle);
        }
        break;
      }
      case "run-end": {
        if (ts != null) runEndTs = ts;
        break;
      }
      case "tool-start": {
        runTotals.toolCallCount += 1;
        activeStep.toolCallCount += 1;
        if (ts != null && event.callId) {
          toolStarts.set(event.callId, { ts, stepTitle: activeStep.stepTitle });
        }
        break;
      }
      case "tool-end": {
        if (ts != null && event.callId) {
          const start = toolStarts.get(event.callId);
          if (start) {
            const duration = ts - start.ts;
            addNullableDuration(runTotals.toolTimeMs, duration);
            const step = getStep(start.stepTitle);
            addNullableDuration(step.toolTimeMs, duration);
            toolStarts.delete(event.callId);
          }
        }
        break;
      }
      case "anomaly": {
        runTotals.anomalyCount += 1;
        activeStep.anomalyCount += 1;
        if (ts != null) {
          anomalyTs.push(ts);
          activeStep.anomalyTs.push(ts);
        }
        break;
      }
    }
  }

  const endTs = runEndTs ?? lastEventTs ?? null;
  if (runStartTs != null && endTs != null && endTs >= runStartTs) {
    addNullableDuration(runTotals.wallTimeMs, endTs - runStartTs);
  }

  closeStep(endTs);

  const effectiveStepCount = Math.max(stepCount, stepMap.size, 1);
  if (typeof params.tokensTotal === "number" && Number.isFinite(params.tokensTotal)) {
    const perStep = params.tokensTotal / effectiveStepCount;
    if (stepMap.size === 0) {
      const step = getStep("unknown");
      step.tokensTotal = perStep;
    } else {
      for (const step of stepMap.values()) {
        step.tokensTotal = (step.tokensTotal ?? 0) + perStep;
      }
    }
  }

  const recentBurstAtEnd = computeRecentBurstAtEnd(anomalyTs, endTs);

  const steps: SessionStepMetrics[] = [];
  for (const step of stepMap.values()) {
    step.parseErrorCount = params.parseErrorCount;
    step.quality = params.quality;
    step.recentBurstAtEnd = computeRecentBurstAtEnd(step.anomalyTs, step.endTs ?? endTs);
    steps.push({
      stepTitle: step.stepTitle,
      wallTimeMs: step.wallTimeMs.value,
      toolCallCount: step.toolCallCount,
      toolTimeMs: step.toolTimeMs.value,
      anomalyCount: step.anomalyCount,
      recentBurstAtEnd: step.recentBurstAtEnd,
      tokensTotal: step.tokensTotal,
      eventCount: step.eventCount,
      parseErrorCount: step.parseErrorCount,
      quality: step.quality,
    });
  }

  return {
    sessionId: params.sessionId,
    wallTimeMs: runTotals.wallTimeMs.value,
    toolCallCount: runTotals.toolCallCount,
    toolTimeMs: runTotals.toolTimeMs.value,
    anomalyCount: runTotals.anomalyCount,
    recentBurstAtEnd,
    tokensTotal: typeof params.tokensTotal === "number" ? params.tokensTotal : null,
    stepCount: effectiveStepCount,
    eventCount: params.eventCount,
    parseErrorCount: params.parseErrorCount,
    quality: params.quality,
    steps,
  };
}

function qualityRank(value: MetricsQuality): number {
  switch (value) {
    case "error":
      return 6;
    case "timeout":
      return 5;
    case "too_large":
      return 4;
    case "missing":
      return 3;
    case "partial":
      return 2;
    case "ok":
      return 1;
    default:
      return 0;
  }
}

function combineQuality(current: MetricsQuality, next: MetricsQuality): MetricsQuality {
  return qualityRank(next) > qualityRank(current) ? next : current;
}

export function aggregateRunMetrics(params: {
  runId: string;
  sessions: SessionMetrics[];
  tokensTotal: number | null;
  tokensComplete: boolean;
}): { run: RunMetrics; steps: RunStepMetrics[] } {
  const runTotals = {
    wallTimeMs: { value: null as number | null },
    toolCallCount: 0,
    toolTimeMs: { value: null as number | null },
    anomalyCount: 0,
    recentBurstAtEnd: false,
    eventCount: 0,
    parseErrorCount: 0,
    quality: "ok" as MetricsQuality,
  };

  const stepMap = new Map<string, RunStepMetrics>();

  for (const session of params.sessions) {
    if (typeof session.wallTimeMs === "number") {
      addNullableDuration(runTotals.wallTimeMs, session.wallTimeMs);
    }
    runTotals.toolCallCount += session.toolCallCount;
    if (typeof session.toolTimeMs === "number") {
      addNullableDuration(runTotals.toolTimeMs, session.toolTimeMs);
    }
    runTotals.anomalyCount += session.anomalyCount;
    runTotals.recentBurstAtEnd = runTotals.recentBurstAtEnd || session.recentBurstAtEnd;
    runTotals.eventCount += session.eventCount;
    runTotals.parseErrorCount += session.parseErrorCount;
    runTotals.quality = combineQuality(runTotals.quality, session.quality);

    for (const step of session.steps) {
      const key = normalizeStepTitle(step.stepTitle);
      const existing = stepMap.get(key) ?? {
        runId: params.runId,
        stepTitle: key,
        wallTimeMs: null,
        toolCallCount: 0,
        toolTimeMs: null,
        anomalyCount: 0,
        recentBurstAtEnd: false,
        tokensTotal: null,
        eventCount: 0,
        parseErrorCount: 0,
        quality: "ok" as MetricsQuality,
      };

      if (typeof step.wallTimeMs === "number") {
        existing.wallTimeMs = (existing.wallTimeMs ?? 0) + step.wallTimeMs;
      }
      existing.toolCallCount += step.toolCallCount;
      if (typeof step.toolTimeMs === "number") {
        existing.toolTimeMs = (existing.toolTimeMs ?? 0) + step.toolTimeMs;
      }
      existing.anomalyCount += step.anomalyCount;
      existing.recentBurstAtEnd = existing.recentBurstAtEnd || step.recentBurstAtEnd;
      if (typeof step.tokensTotal === "number") {
        existing.tokensTotal = (existing.tokensTotal ?? 0) + step.tokensTotal;
      }
      existing.eventCount += step.eventCount;
      existing.parseErrorCount += step.parseErrorCount;
      existing.quality = combineQuality(existing.quality, step.quality);
      stepMap.set(key, existing);
    }
  }

  if (!params.tokensComplete && runTotals.quality === "ok") {
    runTotals.quality = "partial";
  }

  const run: RunMetrics = {
    runId: params.runId,
    wallTimeMs: runTotals.wallTimeMs.value,
    toolCallCount: runTotals.toolCallCount,
    toolTimeMs: runTotals.toolTimeMs.value,
    anomalyCount: runTotals.anomalyCount,
    recentBurstAtEnd: runTotals.recentBurstAtEnd,
    tokensTotal: typeof params.tokensTotal === "number" ? params.tokensTotal : null,
    tokensComplete: params.tokensComplete,
    eventCount: runTotals.eventCount,
    parseErrorCount: runTotals.parseErrorCount,
    quality: runTotals.quality,
  };

  return { run, steps: Array.from(stepMap.values()) };
}
