import { describe, expect, test } from "bun:test";

import { buildSandboxRetentionPlan } from "../sandbox/retention";
import { SANDBOX_FAILED_TOPIC } from "../sandbox/selector";

describe("sandbox retention", () => {
  const nowMs = Date.parse("2026-01-28T00:00:00.000Z");

  const repo = (overrides: Partial<{
    fullName: string;
    createdAt: string;
    topics: string[];
  }> = {}) => ({
    id: 1,
    name: "repo",
    owner: "3mdistal",
    fullName: overrides.fullName ?? "3mdistal/ralph-sandbox-repo",
    createdAt: overrides.createdAt ?? "2026-01-20T00:00:00.000Z",
    archived: false,
    topics: overrides.topics ?? [],
  });

  test("keeps last N and failed within days", () => {
    const repos = [
      repo({ fullName: "3mdistal/ralph-sandbox-new", createdAt: "2026-01-27T00:00:00.000Z" }),
      repo({
        fullName: "3mdistal/ralph-sandbox-failed",
        createdAt: "2026-01-20T00:00:00.000Z",
        topics: [SANDBOX_FAILED_TOPIC],
      }),
      repo({ fullName: "3mdistal/ralph-sandbox-old", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];

    const decisions = buildSandboxRetentionPlan({
      repos,
      policy: { keepLast: 1, keepFailedDays: 14 },
      nowMs,
    });

    expect(decisions[0]?.repo.fullName).toBe("3mdistal/ralph-sandbox-new");
    expect(decisions[0]?.keep).toBe(true);
    expect(decisions[0]?.reason).toBe("lastN");

    const failed = decisions.find((d) => d.repo.fullName.endsWith("sandbox-failed"));
    expect(failed?.keep).toBe(true);
    expect(failed?.reason).toBe("failedWithinDays");

    const old = decisions.find((d) => d.repo.fullName.endsWith("sandbox-old"));
    expect(old?.keep).toBe(false);
    expect(old?.reason).toBe("expired");
  });

  test("treats invalid createdAt as keep", () => {
    const decisions = buildSandboxRetentionPlan({
      repos: [repo({ createdAt: "not-a-date" })],
      policy: { keepLast: 0, keepFailedDays: 14 },
      nowMs,
    });

    expect(decisions[0]?.keep).toBe(true);
    expect(decisions[0]?.reason).toBe("invalidCreatedAt");
  });

  test("failed retention disabled with keepFailedDays=0", () => {
    const decisions = buildSandboxRetentionPlan({
      repos: [repo({ topics: [SANDBOX_FAILED_TOPIC] })],
      policy: { keepLast: 0, keepFailedDays: 0 },
      nowMs,
    });

    expect(decisions[0]?.keep).toBe(false);
  });
});
