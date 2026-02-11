import { describe, expect, test } from "bun:test";

import {
  classifyPrCreateFailurePolicy,
  computePrCreateRetryBackoffMs,
  shouldAttemptPrCreateLeaseSelfHeal,
} from "../worker/pr-create-policy";

describe("pr-create policy", () => {
  test("classifies permission/policy denial as non-retriable", () => {
    const result = classifyPrCreateFailurePolicy({
      evidence: ["Resource not accessible by integration (HTTP 403)", "gh pr create failed"],
    });

    expect(result.classification).toBe("non-retriable");
    expect(result.blockedSource).toBe("permission");
  });

  test("classifies transient failures for bounded retries", () => {
    const result = classifyPrCreateFailurePolicy({
      evidence: ["HTTP 429 secondary rate limit; Retry-After: 60"],
    });

    expect(result.classification).toBe("transient");
  });

  test("self-heal decision allows reclaim after bounded wait", () => {
    const nowMs = Date.parse("2026-02-11T18:10:00.000Z");
    const createdAtIso = "2026-02-11T18:07:30.000Z";

    const allowed = shouldAttemptPrCreateLeaseSelfHeal({
      existingCreatedAtIso: createdAtIso,
      nowMs,
      minAgeMs: 120_000,
      alreadyAttempted: false,
    });

    expect(allowed).toBe(true);
  });

  test("self-heal decision blocks second reclaim attempt", () => {
    const nowMs = Date.parse("2026-02-11T18:10:00.000Z");
    const createdAtIso = "2026-02-11T18:07:30.000Z";

    const allowed = shouldAttemptPrCreateLeaseSelfHeal({
      existingCreatedAtIso: createdAtIso,
      nowMs,
      minAgeMs: 120_000,
      alreadyAttempted: true,
    });

    expect(allowed).toBe(false);
  });

  test("backoff is bounded and increasing", () => {
    const a1 = computePrCreateRetryBackoffMs({ attempt: 1, capMs: 30_000 });
    const a2 = computePrCreateRetryBackoffMs({ attempt: 2, capMs: 30_000 });
    const a8 = computePrCreateRetryBackoffMs({ attempt: 8, capMs: 30_000 });

    expect(a1).toBe(5_000);
    expect(a2).toBe(10_000);
    expect(a8).toBe(30_000);
  });
});
