import { parseDurationMs, parseTimestampMs, resolveTimeRange } from "../time-range";

describe("time-range", () => {
  test("parseDurationMs supports days", () => {
    expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDurationMs("1.5h")).toBe(1.5 * 60 * 60 * 1000);
  });

  test("parseTimestampMs supports now", () => {
    const now = Date.parse("2026-02-05T00:00:00.000Z");
    expect(parseTimestampMs("now", now)).toBe(now);
  });

  test("resolveTimeRange uses default duration when since is missing", () => {
    const now = Date.parse("2026-02-05T12:00:00.000Z");
    const range = resolveTimeRange({ sinceRaw: null, untilRaw: "now", defaultSinceMs: 60_000, nowMs: now });
    expect(range.untilMs).toBe(now);
    expect(range.sinceMs).toBe(now - 60_000);
  });
});
