import { describe, expect, test } from "bun:test";

import { buildSandboxPrunePlan } from "../sandbox/prune-plan";
import { SANDBOX_MARKER_TOPIC } from "../sandbox/selector";
import type { SandboxRetentionDecision } from "../sandbox/retention";

const decision = (overrides: Partial<SandboxRetentionDecision> = {}): SandboxRetentionDecision => ({
  repo: {
    id: 1,
    name: "repo",
    owner: "3mdistal",
    fullName: "3mdistal/ralph-sandbox-repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    topics: [SANDBOX_MARKER_TOPIC],
  },
  keep: false,
  reason: "expired",
  ...overrides,
});

describe("sandbox prune plan", () => {
  test("skips missing marker and already archived repos", () => {
    const decisions = [
      decision({ repo: { ...decision().repo, fullName: "3mdistal/ralph-sandbox-missing", topics: [] } }),
      decision({ repo: { ...decision().repo, fullName: "3mdistal/ralph-sandbox-archived", archived: true } }),
    ];

    const plan = buildSandboxPrunePlan({ decisions, action: "archive", max: 10 });

    expect(plan.actions.length).toBe(0);
    expect(plan.skippedMissingMarker.length).toBe(1);
    expect(plan.skippedAlreadyArchived.length).toBe(1);
  });

  test("orders oldest first and truncates with max", () => {
    const decisions = [
      decision({ repo: { ...decision().repo, fullName: "3mdistal/ralph-sandbox-b", createdAt: "2026-01-02T00:00:00.000Z" } }),
      decision({ repo: { ...decision().repo, fullName: "3mdistal/ralph-sandbox-a", createdAt: "2026-01-02T00:00:00.000Z" } }),
      decision({ repo: { ...decision().repo, fullName: "3mdistal/ralph-sandbox-old", createdAt: "2025-12-30T00:00:00.000Z" } }),
    ];

    const plan = buildSandboxPrunePlan({ decisions, action: "archive", max: 1 });

    expect(plan.actions.length).toBe(1);
    expect(plan.truncated).toBe(true);
    expect(plan.actions[0]?.repoFullName).toBe("3mdistal/ralph-sandbox-old");
  });
});
