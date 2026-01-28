import { INTROSPECTION_SUMMARY_VERSION, type IntrospectionSummary } from "./summary";

export type ToolEventInfo = {
  phase: "start" | "end" | "progress";
  toolName: string;
  callId: string;
  argsPreview?: string;
};

type ToolResultEntry = {
  fingerprint: string;
  ts: number;
  toolName: string;
  callId: string;
};

type ReducerOptions = {
  recentToolsLimit: number;
  anomalyCooldownMs: number;
  anomalyWindowMs: number;
};

export type IntrospectionReducerInput = {
  now: number;
  tool?: ToolEventInfo;
  toolResult?: ToolResultEntry;
  text?: { fingerprint: string; ts: number };
  opencodeAnomaly?: { ts: number };
};

export type IntrospectionReducerResult = {
  events: Array<Record<string, unknown>>;
};

export type IntrospectionState = {
  totalToolCalls: number;
  stepCount: number;
  toolResultAsTextCount: number;
  anomalyCount: number;
  recentTools: string[];
  toolResultsByCallId: Map<string, ToolResultEntry>;
  lastAnomalyByKey: Map<string, number>;
  options: ReducerOptions;
};

const DEFAULT_REDUCER_OPTIONS: ReducerOptions = {
  recentToolsLimit: 6,
  anomalyCooldownMs: 10000,
  anomalyWindowMs: 30000,
};

export function createIntrospectionState(opts?: Partial<ReducerOptions>): IntrospectionState {
  return {
    totalToolCalls: 0,
    stepCount: 0,
    toolResultAsTextCount: 0,
    anomalyCount: 0,
    recentTools: [],
    toolResultsByCallId: new Map(),
    lastAnomalyByKey: new Map(),
    options: { ...DEFAULT_REDUCER_OPTIONS, ...(opts ?? {}) },
  };
}

export function recordStepStart(state: IntrospectionState): void {
  state.stepCount += 1;
}

function updateRecentTools(state: IntrospectionState, toolName: string): void {
  if (!toolName) return;
  const recent = state.recentTools;
  if (recent[recent.length - 1] === toolName) return;
  recent.push(toolName);
  if (recent.length > state.options.recentToolsLimit) {
    state.recentTools = recent.slice(-state.options.recentToolsLimit);
  }
}

function pruneToolResults(state: IntrospectionState, now: number): void {
  const windowMs = state.options.anomalyWindowMs;
  for (const [callId, entry] of state.toolResultsByCallId.entries()) {
    if (now - entry.ts > windowMs) {
      state.toolResultsByCallId.delete(callId);
    }
  }
}

export function reduceIntrospectionEvent(state: IntrospectionState, input: IntrospectionReducerInput): IntrospectionReducerResult {
  const events: Array<Record<string, unknown>> = [];
  const now = input.now;

  if (input.opencodeAnomaly) {
    const ts = Number.isFinite(input.opencodeAnomaly.ts) ? input.opencodeAnomaly.ts : now;
    events.push({ type: "anomaly", ts });
    state.anomalyCount += 1;
  }

  if (input.tool) {
    if (input.tool.phase === "start") {
      state.totalToolCalls += 1;
      updateRecentTools(state, input.tool.toolName);
      events.push({
        type: "tool-start",
        ts: now,
        toolName: input.tool.toolName,
        callId: input.tool.callId,
        argsPreview: input.tool.argsPreview,
      });
    } else if (input.tool.phase === "end") {
      events.push({
        type: "tool-end",
        ts: now,
        toolName: input.tool.toolName,
        callId: input.tool.callId,
      });
    }
  }

  if (input.toolResult?.callId && input.toolResult.fingerprint) {
    state.toolResultsByCallId.set(input.toolResult.callId, input.toolResult);
    pruneToolResults(state, now);
  }

  if (input.text?.fingerprint) {
    pruneToolResults(state, now);
    const cooldownMs = state.options.anomalyCooldownMs;

    for (const [callId, entry] of state.toolResultsByCallId.entries()) {
      if (entry.fingerprint !== input.text.fingerprint) continue;
      const key = `tool-result-as-text:${callId}`;
      const last = state.lastAnomalyByKey.get(key);
      if (typeof last === "number" && now - last < cooldownMs) continue;

      state.lastAnomalyByKey.set(key, now);
      state.toolResultAsTextCount += 1;
      state.anomalyCount += 1;
      events.push({
        type: "anomaly",
        ts: now,
        kind: "tool-result-as-text",
        toolName: entry.toolName,
        callId: entry.callId,
      });
      state.toolResultsByCallId.delete(callId);
      break;
    }
  }

  return { events };
}

export function buildIntrospectionSummary(state: IntrospectionState, params: { sessionId: string; endTime: number }): IntrospectionSummary {
  return {
    schemaVersion: INTROSPECTION_SUMMARY_VERSION,
    sessionId: params.sessionId,
    endTime: params.endTime,
    toolResultAsTextCount: state.toolResultAsTextCount,
    totalToolCalls: state.totalToolCalls,
    stepCount: state.stepCount,
    hasAnomalies: state.anomalyCount > 0,
    recentTools: [...state.recentTools],
  };
}
