import { describe, expect, test } from "bun:test";

import { RalphEventBus } from "../dashboard/event-bus";
import { buildRalphEvent, isRalphEvent } from "../dashboard/events";

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

    const bad: any = {
      ...ok,
      data: { checkpoint: "not_a_checkpoint" },
    };

    expect(isRalphEvent(bad)).toBe(false);
  });
});
