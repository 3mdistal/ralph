import { describe, expect, test } from "bun:test";

import { computeSessionMetrics, aggregateRunMetrics } from "../metrics/core";
import { parseEventsFromLines } from "../metrics/parse";

describe("metrics core", () => {
  test("computes per-step wall time, tool time, and token attribution", () => {
    const lines = [
      JSON.stringify({ type: "run-start", ts: 0, stepTitle: "plan" }),
      JSON.stringify({ type: "tool-start", ts: 10, toolName: "bash", callId: "c1" }),
      JSON.stringify({ type: "tool-end", ts: 30, toolName: "bash", callId: "c1" }),
      JSON.stringify({ type: "step-start", ts: 50, title: "build", step: 1 }),
      JSON.stringify({ type: "tool-start", ts: 60, toolName: "bash", callId: "c2" }),
      JSON.stringify({ type: "tool-end", ts: 80, toolName: "bash", callId: "c2" }),
      JSON.stringify({ type: "anomaly", ts: 85 }),
      JSON.stringify({ type: "run-end", ts: 100, success: true }),
    ];

    const { events, eventCount, parseErrorCount } = parseEventsFromLines(lines);
    const session = computeSessionMetrics({
      sessionId: "ses_alpha",
      events,
      eventCount,
      parseErrorCount,
      tokensTotal: 100,
      quality: "ok",
    });

    expect(session.wallTimeMs).toBe(100);
    expect(session.toolCallCount).toBe(2);
    expect(session.toolTimeMs).toBe(40);
    expect(session.anomalyCount).toBe(1);
    expect(session.stepCount).toBe(2);

    const plan = session.steps.find((step) => step.stepTitle === "plan");
    const build = session.steps.find((step) => step.stepTitle === "build");
    expect(plan?.wallTimeMs).toBe(50);
    expect(build?.wallTimeMs).toBe(50);
    expect(plan?.tokensTotal).toBeCloseTo(50);
    expect(build?.tokensTotal).toBeCloseTo(50);
  });

  test("detects recent anomaly burst at end", () => {
    const lines = [JSON.stringify({ type: "run-start", ts: 0, stepTitle: "plan" })];
    for (let i = 0; i < 20; i += 1) {
      lines.push(JSON.stringify({ type: "anomaly", ts: 90 + i * 0.1 }));
    }
    lines.push(JSON.stringify({ type: "run-end", ts: 100, success: true }));

    const { events, eventCount, parseErrorCount } = parseEventsFromLines(lines);
    const session = computeSessionMetrics({
      sessionId: "ses_burst",
      events,
      eventCount,
      parseErrorCount,
      tokensTotal: null,
      quality: "ok",
    });

    expect(session.recentBurstAtEnd).toBe(true);
    expect(session.steps[0]?.recentBurstAtEnd).toBe(true);
  });

  test("aggregate run quality becomes partial when tokens incomplete", () => {
    const session = computeSessionMetrics({
      sessionId: "ses_partial",
      events: [],
      eventCount: 0,
      parseErrorCount: 0,
      tokensTotal: 10,
      quality: "ok",
    });

    const { run } = aggregateRunMetrics({
      runId: "run_1",
      sessions: [session],
      tokensTotal: null,
      tokensComplete: false,
    });

    expect(run.quality).toBe("partial");
  });
});
