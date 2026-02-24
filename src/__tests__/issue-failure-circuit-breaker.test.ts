import { describe, expect, test } from "bun:test";

import { createIssueFailureCircuitBreaker } from "../worker/issue-failure-circuit-breaker";

describe("issue failure circuit breaker", () => {
  test("backs off repeated identical failures and then opens circuit", () => {
    const breaker = createIssueFailureCircuitBreaker({
      windowMs: 60_000,
      openAfterCount: 4,
      backoffBaseMs: 1_000,
      backoffCapMs: 60_000,
      jitterMs: 0,
    });

    const repo = "3mdistal/ralph";
    const issueNumber = 792;
    const reason = "Failed to mark task starting (queue update failed)";

    const first = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 1_000 });
    expect(first.action).toBe("none");

    const second = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 2_000 });
    expect(second.action).toBe("backoff");
    if (second.action === "backoff") {
      expect(second.recentCount).toBe(2);
      expect(second.backoffMs).toBe(1_000);
    }

    const third = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 3_000 });
    expect(third.action).toBe("backoff");
    if (third.action === "backoff") {
      expect(third.recentCount).toBe(3);
      expect(third.backoffMs).toBe(2_000);
    }

    const fourth = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 4_000 });
    expect(fourth.action).toBe("open");
    if (fourth.action === "open") {
      expect(fourth.recentCount).toBe(4);
      expect(fourth.fingerprint.length).toBeGreaterThan(0);
    }

    const fifth = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 5_000 });
    expect(fifth.action).toBe("backoff");
    if (fifth.action === "backoff") {
      expect(fifth.opened).toBe(true);
      expect(fifth.recentCount).toBe(5);
    }
  });

  test("window expiry resets failure streak", () => {
    const breaker = createIssueFailureCircuitBreaker({
      windowMs: 5_000,
      openAfterCount: 3,
      backoffBaseMs: 500,
      backoffCapMs: 5_000,
      jitterMs: 0,
    });

    const repo = "3mdistal/ralph";
    const issueNumber = 792;
    const reason = "planner failed: timeout";

    const first = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 1_000 });
    expect(first.action).toBe("none");

    const second = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 2_000 });
    expect(second.action).toBe("backoff");

    const afterWindow = breaker.recordFailure({ repo, issueNumber, reason, nowMs: 20_000 });
    expect(afterWindow.action).toBe("none");
  });
});
