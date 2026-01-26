import { describe, expect, test } from "bun:test";

import { computeAggregateTokens } from "../status-run-tokens";

describe("status run token aggregation", () => {
  test("returns unknown when no sessions exist", () => {
    const result = computeAggregateTokens([]);
    expect(result).toEqual({ tokensTotal: null, tokensComplete: false });
  });

  test("sums totals when all sessions are present", () => {
    const result = computeAggregateTokens([{ total: 10 }, { total: 12 }]);
    expect(result).toEqual({ tokensTotal: 22, tokensComplete: true });
  });

  test("returns unknown when any session is missing", () => {
    const result = computeAggregateTokens([{ total: 10 }, { total: null }]);
    expect(result).toEqual({ tokensTotal: null, tokensComplete: false });
  });
});
