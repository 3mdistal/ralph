import { describe, expect, test } from "bun:test";

import {
  classifyPrCreateFailure,
  computePrCreateRetryDelayMs,
  extractRetryAfterMs,
} from "../worker/pr-create-failure-policy";

describe("pr-create failure policy", () => {
  test("classifies sandbox permission denial as non-retriable", () => {
    const out = classifyPrCreateFailure(
      "permission requested: external_directory (/tmp); auto-rejecting by policy in sandbox profile"
    );
    expect(out.classification).toBe("non-retriable");
    expect(out.blockedSource).toBe("permission");
  });

  test("classifies github policy/permission denial as non-retriable", () => {
    const out = classifyPrCreateFailure("Resource not accessible by integration (HTTP 403)");
    expect(out.classification).toBe("non-retriable");
    expect(out.blockedSource).toBe("auth");
  });

  test("classifies rate limit as transient", () => {
    const out = classifyPrCreateFailure("HTTP 429 secondary rate limit triggered. Retry-After: 12");
    expect(out.classification).toBe("transient");
  });

  test("extracts Retry-After seconds", () => {
    expect(extractRetryAfterMs("HTTP 429\nRetry-After: 17")).toBe(17_000);
  });

  test("retry delay honors Retry-After when present", () => {
    expect(computePrCreateRetryDelayMs({ attempt: 2, retryAfterMs: 30_000, jitterSeed: 0.9 })).toBe(30_000);
  });

  test("retry delay uses bounded exponential + deterministic jitter", () => {
    const delay = computePrCreateRetryDelayMs({ attempt: 3, jitterSeed: 0.5 });
    expect(delay).toBeGreaterThanOrEqual(4_000);
    expect(delay).toBeLessThanOrEqual(4_400);
  });
});
