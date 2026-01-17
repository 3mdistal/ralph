import { canActOnTask, computeHeartbeatIntervalMs, isHeartbeatStale } from "../ownership";

describe("ownership helpers", () => {
  test("canActOnTask allows owner", () => {
    const task = { "daemon-id": "d_1", "heartbeat-at": "2026-01-16T12:00:00.000Z" };
    expect(canActOnTask(task, "d_1", Date.parse("2026-01-16T12:00:30.000Z"), 60_000)).toBe(true);
  });

  test("canActOnTask allows stale heartbeat", () => {
    const task = { "daemon-id": "d_1", "heartbeat-at": "2026-01-16T12:00:00.000Z" };
    expect(canActOnTask(task, "d_2", Date.parse("2026-01-16T12:01:01.000Z"), 60_000)).toBe(true);
  });

  test("canActOnTask rejects fresh heartbeat", () => {
    const task = { "daemon-id": "d_1", "heartbeat-at": "2026-01-16T12:00:30.000Z" };
    expect(canActOnTask(task, "d_2", Date.parse("2026-01-16T12:00:40.000Z"), 60_000)).toBe(false);
  });

  test("isHeartbeatStale treats missing timestamp as stale", () => {
    expect(isHeartbeatStale(undefined, Date.now(), 60_000)).toBe(true);
  });

  test("computeHeartbeatIntervalMs clamps to safe bounds", () => {
    expect(computeHeartbeatIntervalMs(60_000)).toBe(10_000);
    expect(computeHeartbeatIntervalMs(6_000)).toBe(2_000);
    expect(computeHeartbeatIntervalMs(30_000)).toBe(10_000);
    expect(computeHeartbeatIntervalMs(300_000)).toBe(60_000);
  });
});
