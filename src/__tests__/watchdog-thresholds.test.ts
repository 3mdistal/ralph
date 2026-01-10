import { describe, test, expect } from "bun:test";

import { DEFAULT_WATCHDOG_THRESHOLDS_MS } from "../watchdog";

describe("Watchdog defaults", () => {
  test("match default soft/hard thresholds", () => {
    expect(DEFAULT_WATCHDOG_THRESHOLDS_MS.read).toEqual({ softMs: 30_000, hardMs: 120_000 });
    expect(DEFAULT_WATCHDOG_THRESHOLDS_MS.glob).toEqual({ softMs: 30_000, hardMs: 120_000 });
    expect(DEFAULT_WATCHDOG_THRESHOLDS_MS.grep).toEqual({ softMs: 30_000, hardMs: 120_000 });
    expect(DEFAULT_WATCHDOG_THRESHOLDS_MS.task).toEqual({ softMs: 180_000, hardMs: 600_000 });
    expect(DEFAULT_WATCHDOG_THRESHOLDS_MS.bash).toEqual({ softMs: 300_000, hardMs: 1_800_000 });
  });
});
