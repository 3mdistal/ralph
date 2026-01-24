import { describe, expect, test } from "bun:test";

import { LogLimiter } from "../logging";

describe("LogLimiter", () => {
  test("respects interval between logs", () => {
    const limiter = new LogLimiter({ maxKeys: 10 });

    expect(limiter.shouldLog("issue-1", 1000, 0)).toBe(true);
    expect(limiter.shouldLog("issue-1", 1000, 500)).toBe(false);
    expect(limiter.shouldLog("issue-1", 1000, 1000)).toBe(true);
  });

  test("evicts oldest entries when maxKeys is exceeded", () => {
    const limiter = new LogLimiter({ maxKeys: 2 });

    expect(limiter.shouldLog("a", 0, 0)).toBe(true);
    expect(limiter.shouldLog("b", 0, 1)).toBe(true);
    expect(limiter.shouldLog("a", 0, 2)).toBe(true);
    expect(limiter.shouldLog("c", 0, 3)).toBe(true);

    expect(limiter.shouldLog("a", 1000, 3)).toBe(false);
    expect(limiter.shouldLog("b", 1000, 3)).toBe(true);
  });
});
