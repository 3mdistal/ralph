import { describe, expect, test } from "bun:test";

import { ralphEventBus } from "../dashboard/bus";
import { type RalphEvent } from "../dashboard/events";
import { publishDashboardEvent } from "../dashboard/publisher";

describe("dashboard event publisher", () => {
  test("attaches runId and redacts log payloads", () => {
    const events: RalphEvent[] = [];
    const unsubscribe = ralphEventBus.subscribe((event) => events.push(event));

    publishDashboardEvent(
      {
        type: "log.worker",
        level: "info",
        data: { message: "token=ghp_abcdefghijklmnopqrstuvwxyz1234" },
      },
      {
        runId: "run-1",
        workerId: "w_1",
        repo: "3mdistal/ralph",
        taskId: "orchestration/tasks/1",
        sessionId: "ses_123",
      }
    );

    unsubscribe();

    expect(events.length).toBe(1);
    expect(events[0].runId).toBe("run-1");
    if (events[0].type === "log.worker") {
      expect(events[0].data.message).toContain("REDACTED");
    }
  });

  test("rate limits opencode text logs", () => {
    const events: RalphEvent[] = [];
    const unsubscribe = ralphEventBus.subscribe((event) => events.push(event));

    for (let i = 0; i < 510; i++) {
      publishDashboardEvent(
        {
          type: "log.opencode.text",
          level: "info",
          sessionId: "ses_limit",
          data: { text: `line-${i}` },
        },
        { runId: "run-2", workerId: "w_2", repo: "3mdistal/ralph", taskId: "orchestration/tasks/2" }
      );
    }

    unsubscribe();

    const textEvents = events.filter((event) => event.type === "log.opencode.text");
    expect(textEvents.length).toBeLessThanOrEqual(500);
  });
});
