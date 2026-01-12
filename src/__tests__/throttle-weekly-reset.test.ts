import { __computeWeeklyResetBoundariesForTests } from "../throttle";

function zonedParts(ms: number, timeZone: string): { weekday: string; hour: number; minute: number; year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  const parts = fmt.formatToParts(new Date(ms));
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }

  return {
    weekday: lookup.weekday,
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
  };
}

describe("weekly reset boundaries", () => {
  test("computes boundaries for apple-style Monday 19:05 Indianapolis", () => {
    const timeZone = "America/Indiana/Indianapolis";
    const schedule = { dayOfWeek: 1, hour: 19, minute: 5, timeZone };

    // 2026-01-12 18:00 in Indianapolis (EST) => 2026-01-12T23:00:00Z
    const nowMs = Date.parse("2026-01-12T23:00:00Z");

    const { lastResetTs, nextResetTs } = __computeWeeklyResetBoundariesForTests(nowMs, schedule);

    expect(lastResetTs).toBeLessThan(nowMs);
    expect(nextResetTs).toBeGreaterThan(nowMs);

    const next = zonedParts(nextResetTs, timeZone);
    expect(next.weekday).toBe("Mon");
    expect(next.hour).toBe(19);
    expect(next.minute).toBe(5);

    const delta = nextResetTs - lastResetTs;
    expect(delta).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
  });

  test("computes boundaries for google-style Thursday 19:09 Indianapolis", () => {
    const timeZone = "America/Indiana/Indianapolis";
    const schedule = { dayOfWeek: 4, hour: 19, minute: 9, timeZone };

    // 2026-01-14 12:00 in Indianapolis (EST) => 2026-01-14T17:00:00Z
    const nowMs = Date.parse("2026-01-14T17:00:00Z");

    const { lastResetTs, nextResetTs } = __computeWeeklyResetBoundariesForTests(nowMs, schedule);

    expect(lastResetTs).toBeLessThan(nowMs);
    expect(nextResetTs).toBeGreaterThan(nowMs);

    const next = zonedParts(nextResetTs, timeZone);
    expect(next.weekday).toBe("Thu");
    expect(next.hour).toBe(19);
    expect(next.minute).toBe(9);
  });

  test("handles DST spring-forward week for a 19:05 reset", () => {
    const timeZone = "America/Indiana/Indianapolis";
    const schedule = { dayOfWeek: 1, hour: 19, minute: 5, timeZone };

    // DST in 2026 starts Sun Mar 8. This is Mon Mar 9 18:00 local.
    const nowMs = Date.parse("2026-03-09T22:00:00Z");

    const { lastResetTs, nextResetTs } = __computeWeeklyResetBoundariesForTests(nowMs, schedule);

    const next = zonedParts(nextResetTs, timeZone);
    expect(next.weekday).toBe("Mon");
    expect(next.hour).toBe(19);
    expect(next.minute).toBe(5);

    // DST can shift the UTC delta by an hour.
    const delta = nextResetTs - lastResetTs;
    expect(delta).toBeGreaterThan(6.8 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThan(7.2 * 24 * 60 * 60 * 1000);
  });

  test("handles DST fall-back week for a 19:05 reset", () => {
    const timeZone = "America/Indiana/Indianapolis";
    const schedule = { dayOfWeek: 1, hour: 19, minute: 5, timeZone };

    // DST in 2026 ends Sun Nov 1. This is Mon Nov 2 18:00 local.
    const nowMs = Date.parse("2026-11-02T23:00:00Z");

    const { lastResetTs, nextResetTs } = __computeWeeklyResetBoundariesForTests(nowMs, schedule);

    const next = zonedParts(nextResetTs, timeZone);
    expect(next.weekday).toBe("Mon");
    expect(next.hour).toBe(19);
    expect(next.minute).toBe(5);

    const delta = nextResetTs - lastResetTs;
    expect(delta).toBeGreaterThan(6.8 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThan(7.2 * 24 * 60 * 60 * 1000);
  });
});
