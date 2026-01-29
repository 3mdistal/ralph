import { describe, expect, test } from "bun:test";

import { buildRalphEvent } from "../dashboard/events";
import {
  createDashboardModel,
  reduceDashboardModel,
  selectLogs,
  selectSelectedKey,
  selectWorkerRows,
} from "../dashboard/client/core";
import type { ControlPlaneStateV1 } from "../dashboard/control-plane-state";

const snapshot: ControlPlaneStateV1 = {
  mode: "running",
  queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
  controlProfile: null,
  activeProfile: null,
  throttle: { state: "ok" },
  usage: { profiles: [] },
  escalations: { pending: 0 },
  inProgress: [
    {
      name: "Implement TUI",
      repo: "3mdistal/ralph",
      issue: "38",
      priority: "p1",
      opencodeProfile: null,
      sessionId: "ses_123",
      nowDoing: null,
      line: null,
    },
  ],
  starting: [],
  queued: [],
  throttled: [],
  blocked: [],
  drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
};

describe("dashboard client core", () => {
  test("snapshot-only rows render and select", () => {
    const model = createDashboardModel();
    const next = reduceDashboardModel(model, { type: "snapshot.received", snapshot, receivedAt: 1000 });
    const rows = selectWorkerRows(next, 2000);
    expect(rows.length).toBe(1);
    expect(rows[0].taskName).toBe("Implement TUI");
    expect(selectSelectedKey(next)).toBe(rows[0].key);
  });

  test("event-only rows create worker entries", () => {
    const model = createDashboardModel();
    const event = buildRalphEvent({
      type: "worker.became_busy",
      level: "info",
      workerId: "worker-1",
      repo: "3mdistal/ralph",
      data: { taskName: "Event Task", issue: "99" },
    });
    const next = reduceDashboardModel(model, {
      type: "event.received",
      event,
      receivedAt: 2000,
      eventTsMs: 2000,
    });
    const rows = selectWorkerRows(next, 2001);
    expect(rows.length).toBe(1);
    expect(rows[0].workerId).toBe("worker-1");
    expect(rows[0].taskName).toBe("Event Task");
  });

  test("snapshot merge preserves event-derived fields", () => {
    const model = createDashboardModel();
    const event = buildRalphEvent({
      type: "worker.activity.updated",
      level: "info",
      workerId: "worker-2",
      repo: "3mdistal/ralph",
      data: { activity: "planning" },
    });
    const afterEvent = reduceDashboardModel(model, {
      type: "event.received",
      event,
      receivedAt: 1000,
      eventTsMs: 1000,
    });
    const afterSnapshot = reduceDashboardModel(afterEvent, {
      type: "snapshot.received",
      snapshot,
      receivedAt: 1100,
    });
    const rows = selectWorkerRows(afterSnapshot, 1200);
    const hasPlanning = rows.some((row) => row.activity === "planning");
    expect(hasPlanning).toBe(true);
  });

  test("log buffers are bounded", () => {
    let model = createDashboardModel();
    const event = buildRalphEvent({
      type: "log.worker",
      level: "info",
      workerId: "worker-3",
      repo: "3mdistal/ralph",
      data: { message: "hello" },
    });

    for (let i = 0; i < 250; i += 1) {
      model = reduceDashboardModel(model, {
        type: "event.received",
        event: { ...event, ts: new Date(1000 + i).toISOString() },
        receivedAt: 1000 + i,
        eventTsMs: 1000 + i,
      });
    }

    const logs = selectLogs(model, model.order[0], "ralph");
    expect(logs.length).toBeLessThanOrEqual(200);
  });
});
