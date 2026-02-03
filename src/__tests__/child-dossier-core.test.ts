import { describe, expect, test } from "bun:test";

import type { IssueRelationshipSnapshot } from "../github/issue-relationships";
import type { RelationshipSignal } from "../github/issue-blocking-core";
import {
  CHILD_DOSSIER_HEADER,
  appendChildDossierToIssueContext,
  compileChildCompletionDossier,
  evaluateChildCompletionEligibility,
  selectBoundedChildren,
} from "../child-dossier/core";

function makeSnapshot(signals: RelationshipSignal[], coverage?: Partial<IssueRelationshipSnapshot["coverage"]>): IssueRelationshipSnapshot {
  return {
    issue: { repo: "3mdistal/ralph", number: 10 },
    signals,
    coverage: {
      githubDepsComplete: true,
      githubSubIssuesComplete: true,
      bodyDeps: false,
      ...(coverage ?? {}),
    },
  };
}

describe("child completion dossier core", () => {
  test("evaluateChildCompletionEligibility requires closed sub-issues", () => {
    const signals: RelationshipSignal[] = [
      { source: "github", kind: "sub_issue", state: "closed", ref: { repo: "3mdistal/ralph", number: 1 } },
    ];
    const snapshot = makeSnapshot(signals);
    const eligibility = evaluateChildCompletionEligibility({ snapshot, signals });
    expect(eligibility.decision).toBe("eligible");
  });

  test("evaluateChildCompletionEligibility skips on incomplete coverage", () => {
    const signals: RelationshipSignal[] = [
      { source: "github", kind: "sub_issue", state: "unknown", ref: { repo: "3mdistal/ralph", number: 1 } },
    ];
    const snapshot = makeSnapshot(signals, { githubSubIssuesComplete: false });
    const eligibility = evaluateChildCompletionEligibility({ snapshot, signals });
    expect(eligibility.decision).toBe("skip");
  });

  test("selectBoundedChildren enforces caps deterministically", () => {
    const childIssues = [
      { repo: "3mdistal/ralph", number: 4 },
      { repo: "3mdistal/ralph", number: 1 },
      { repo: "3mdistal/ralph", number: 2 },
    ];
    const selected = selectBoundedChildren({ childIssues, maxChildren: 2 });
    expect(selected.selected.length).toBe(2);
    expect(selected.omitted).toBe(1);
    expect(selected.selected[0]?.number).toBe(1);
    expect(selected.selected[1]?.number).toBe(2);
  });

  test("compileChildCompletionDossier orders children and truncates excerpts", () => {
    const compiled = compileChildCompletionDossier({
      children: [
        {
          issue: { repo: "b/repo", number: 2 },
          url: "https://github.com/b/repo/issues/2",
          title: "Second",
          state: "closed",
          prs: [
            {
              url: "https://github.com/b/repo/pull/9",
              title: "Zed",
              merged: true,
              bodyExcerpt: "123456789012345",
            },
            {
              url: "https://github.com/b/repo/pull/1",
              title: "Alpha",
              merged: true,
              bodyExcerpt: "123456789012345",
            },
          ],
        },
        {
          issue: { repo: "a/repo", number: 1 },
          url: "https://github.com/a/repo/issues/1",
          title: "First",
          state: "closed",
          prs: [],
        },
      ],
      totalChildren: 2,
      omittedChildren: 0,
      limits: { maxExcerptChars: 8, maxChars: 10_000 },
    });

    const text = compiled.text;
    expect(text).toContain(CHILD_DOSSIER_HEADER);
    expect(text.indexOf("https://github.com/a/repo/issues/1")).toBeLessThan(
      text.indexOf("https://github.com/b/repo/issues/2")
    );
    expect(text.indexOf("https://github.com/b/repo/pull/1")).toBeLessThan(
      text.indexOf("https://github.com/b/repo/pull/9")
    );
    expect(text).toContain("Excerpt: 12345...");
  });

  test("appendChildDossierToIssueContext adds dossier when present", () => {
    const base = "Issue context";
    const appended = appendChildDossierToIssueContext(base, "Child completion dossier");
    expect(appended).toContain("Issue context");
    expect(appended).toContain("Child completion dossier");
  });
});
