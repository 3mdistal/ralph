import { describe, expect, test } from "bun:test";

import { buildIntrospectionSummary, createIntrospectionState, reduceIntrospectionEvent } from "../introspection/reducer";

describe("introspection reducer", () => {
  test("dedupes tool-result-as-text anomalies", () => {
    const state = createIntrospectionState({ anomalyCooldownMs: 10000, anomalyWindowMs: 30000 });
    const baseTs = 1000;

    reduceIntrospectionEvent(state, {
      now: baseTs,
      toolResult: {
        fingerprint: "abc123:6",
        ts: baseTs,
        callId: "c1",
        toolName: "bash",
      },
    });

    const first = reduceIntrospectionEvent(state, {
      now: baseTs + 1000,
      text: { fingerprint: "abc123:6", ts: baseTs + 1000 },
    });

    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.type).toBe("anomaly");
    expect(state.toolResultAsTextCount).toBe(1);

    const second = reduceIntrospectionEvent(state, {
      now: baseTs + 2000,
      text: { fingerprint: "abc123:6", ts: baseTs + 2000 },
    });

    expect(second.events).toHaveLength(0);
    expect(state.toolResultAsTextCount).toBe(1);
  });

  test("tracks tool calls and recent tools", () => {
    const state = createIntrospectionState({ recentToolsLimit: 2 });

    reduceIntrospectionEvent(state, {
      now: 1,
      tool: { phase: "start", toolName: "bash", callId: "c1" },
    });
    reduceIntrospectionEvent(state, {
      now: 2,
      tool: { phase: "start", toolName: "read", callId: "c2" },
    });
    reduceIntrospectionEvent(state, {
      now: 3,
      tool: { phase: "start", toolName: "read", callId: "c3" },
    });

    const summary = buildIntrospectionSummary(state, { sessionId: "ses_test", endTime: 3 });

    expect(summary.totalToolCalls).toBe(3);
    expect(summary.recentTools).toEqual(["bash", "read"]);
  });
});
