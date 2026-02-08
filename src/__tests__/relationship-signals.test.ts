import { describe, expect, test } from "bun:test";

import { resolveRelationshipSignals } from "../github/relationship-signals";
import type { IssueRelationshipSnapshot } from "../github/issue-relationships";

function buildSnapshot(overrides: Partial<IssueRelationshipSnapshot>): IssueRelationshipSnapshot {
  return {
    issue: { repo: "acme/alpha", number: 1 },
    signals: [],
    coverage: { githubDeps: "partial", githubSubIssues: "complete", bodyDeps: false },
    ...overrides,
  };
}

describe("resolveRelationshipSignals", () => {
  test("ignores body blockers when GitHub deps coverage is complete", () => {
    const snapshot = buildSnapshot({
      signals: [{ source: "body", kind: "blocked_by", state: "open", ref: { repo: "acme/alpha", number: 2 } }],
      coverage: { githubDeps: "complete", githubSubIssues: "complete", bodyDeps: true },
    });

    const resolved = resolveRelationshipSignals(snapshot);

    expect(resolved.signals).toEqual([]);
    expect(resolved.diagnostics?.ignoredBodyBlockers).toEqual({ count: 1, reason: "complete" });
  });

  test("ignores body blockers when GitHub deps are partial but present", () => {
    const snapshot = buildSnapshot({
      signals: [
        { source: "github", kind: "blocked_by", state: "closed", ref: { repo: "acme/alpha", number: 3 } },
        { source: "body", kind: "blocked_by", state: "open", ref: { repo: "acme/alpha", number: 4 } },
      ],
      coverage: { githubDeps: "partial", githubSubIssues: "complete", bodyDeps: true },
    });

    const resolved = resolveRelationshipSignals(snapshot);

    expect(resolved.signals).toEqual([
      { source: "github", kind: "blocked_by", state: "closed", ref: { repo: "acme/alpha", number: 3 } },
      { source: "github", kind: "blocked_by", state: "unknown" },
    ]);
    expect(resolved.diagnostics?.ignoredBodyBlockers).toEqual({ count: 1, reason: "partial" });
    expect(resolved.diagnostics?.injectedUnknown).toContain("githubDeps");
  });

  test("falls back to body blockers when GitHub deps are unavailable", () => {
    const snapshot = buildSnapshot({
      signals: [{ source: "body", kind: "blocked_by", state: "open", ref: { repo: "acme/alpha", number: 5 } }],
      coverage: { githubDeps: "unavailable", githubSubIssues: "complete", bodyDeps: true },
    });

    const resolved = resolveRelationshipSignals(snapshot);

    expect(resolved.signals).toEqual([
      { source: "body", kind: "blocked_by", state: "open", ref: { repo: "acme/alpha", number: 5 } },
    ]);
    expect(resolved.diagnostics).toBeUndefined();
  });

  test("injects unknown when coverage is incomplete and no body deps coverage", () => {
    const snapshot = buildSnapshot({
      signals: [],
      coverage: { githubDeps: "partial", githubSubIssues: "complete", bodyDeps: false },
    });

    const resolved = resolveRelationshipSignals(snapshot);

    expect(resolved.signals).toEqual([{ source: "github", kind: "blocked_by", state: "unknown" }]);
    expect(resolved.diagnostics?.injectedUnknown).toContain("githubDeps");
  });

  test("injects unknown when sub-issue coverage is incomplete", () => {
    const snapshot = buildSnapshot({
      signals: [],
      coverage: { githubDeps: "complete", githubSubIssues: "partial", bodyDeps: false },
    });

    const resolved = resolveRelationshipSignals(snapshot);

    expect(resolved.signals).toEqual([{ source: "github", kind: "sub_issue", state: "unknown" }]);
    expect(resolved.diagnostics?.injectedUnknown).toContain("githubSubIssues");
  });

  test("injects unknown when sub-issue coverage is unavailable", () => {
    const snapshot = buildSnapshot({
      signals: [],
      coverage: { githubDeps: "complete", githubSubIssues: "unavailable", bodyDeps: false },
    });

    const resolved = resolveRelationshipSignals(snapshot);

    expect(resolved.signals).toEqual([{ source: "github", kind: "sub_issue", state: "unknown" }]);
    expect(resolved.diagnostics?.injectedUnknown).toContain("githubSubIssues");
  });
});
