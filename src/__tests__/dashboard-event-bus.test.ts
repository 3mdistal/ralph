import { describe, expect, test } from "bun:test";

import { RalphEventBus } from "../dashboard/event-bus";
import { assertRalphEvent, buildRalphEvent, isRalphEvent, safeJsonStringifyRalphEvent } from "../dashboard/events";

describe("dashboard event bus", () => {
  test("replays the last N events to new subscribers", () => {
    const bus = new RalphEventBus({ bufferSize: 10 });

    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        data: { message: "one" },
      })
    );
    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        data: { message: "two" },
      })
    );
    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        data: { message: "three" },
      })
    );

    const received: string[] = [];

    const unsubscribe = bus.subscribe(
      (event) => {
        if (event.type === "log.ralph") received.push(event.data.message);
      },
      { replayLast: 2 }
    );

    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        data: { message: "four" },
      })
    );

    unsubscribe();

    expect(received).toEqual(["two", "three", "four"]);
  });
});

describe("dashboard event schema", () => {
  test("validates MVP envelope + a checkpoint event", () => {
    const ok = buildRalphEvent({
      type: "worker.checkpoint.reached",
      level: "info",
      workerId: "3mdistal/ralph#orchestration/tasks/30",
      repo: "3mdistal/ralph",
      taskId: "orchestration/tasks/30",
      sessionId: "ses_123",
      data: { checkpoint: "pr_ready" },
    });

    expect(isRalphEvent(ok)).toBe(true);
    expect(() => assertRalphEvent(ok, "ok")).not.toThrow();

    const roundTrip = JSON.parse(safeJsonStringifyRalphEvent(ok));
    expect(isRalphEvent(roundTrip)).toBe(true);

    const bad: any = {
      ...ok,
      data: { checkpoint: "not_a_checkpoint" },
    };

    expect(isRalphEvent(bad)).toBe(false);
    expect(() => assertRalphEvent(bad, "bad")).toThrow();
  });

  test("validates worker.summary.updated payload", () => {
    const ok = buildRalphEvent({
      type: "worker.summary.updated",
      level: "info",
      workerId: "3mdistal/ralph#orchestration/tasks/30",
      data: { text: "Summarized", confidence: 0.7, top_activities: ["planning"] },
    });

    expect(isRalphEvent(ok)).toBe(true);

    const missingText: any = {
      ...ok,
      data: { confidence: 0.4 },
    };

    expect(isRalphEvent(missingText)).toBe(false);

    const invalidTopActivities: any = {
      ...ok,
      data: { text: "ok", top_activities: [1] },
    };

    expect(isRalphEvent(invalidTopActivities)).toBe(false);
  });

  test("accepts worker.activity.updated payload", () => {
    const ok = buildRalphEvent({
      type: "worker.activity.updated",
      level: "info",
      workerId: "3mdistal/ralph#orchestration/tasks/41",
      data: { activity: "testing" },
    });

    expect(isRalphEvent(ok)).toBe(true);

    const bad: any = {
      ...ok,
      data: { activity: 123 },
    };

    expect(isRalphEvent(bad)).toBe(false);
  });
});
