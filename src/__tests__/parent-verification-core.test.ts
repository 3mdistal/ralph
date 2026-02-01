import { describe, expect, test } from "bun:test";

import {
  PARENT_VERIFY_MARKER,
  buildParentVerificationPrompt,
  evaluateParentVerificationEligibility,
  parseParentVerificationOutput,
} from "../parent-verification/core";
import type { IssueRelationshipSnapshot } from "../github/issue-relationships";
import type { RelationshipSignal } from "../github/issue-blocking-core";

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

describe("parent verification core", () => {
  test("parseParentVerificationOutput accepts valid marker", () => {
    const output = [
      "Some text",
      `${PARENT_VERIFY_MARKER} {"version":"v1","satisfied":true,"reason":"ok","evidence":["a"]}`,
    ].join("\n");
    const parsed = parseParentVerificationOutput(output);
    expect(parsed.satisfied).toBe(true);
    expect(parsed.reason).toBe("ok");
  });

  test("parseParentVerificationOutput requires marker as last non-empty line", () => {
    const output = [
      `${PARENT_VERIFY_MARKER} {"version":"v1","satisfied":true,"reason":"ok"}`,
      "trailing text",
    ].join("\n");
    const parsed = parseParentVerificationOutput(output);
    expect(parsed.satisfied).toBe(false);
    expect(parsed.error).toBe("missing_marker");
  });

  test("parseParentVerificationOutput rejects missing marker", () => {
    const parsed = parseParentVerificationOutput("no marker here");
    expect(parsed.satisfied).toBe(false);
    expect(parsed.error).toBe("missing_marker");
  });

  test("evaluateParentVerificationEligibility requires closed sub-issues", () => {
    const signals: RelationshipSignal[] = [
      { source: "github", kind: "sub_issue", state: "closed", ref: { repo: "3mdistal/ralph", number: 1 } },
    ];
    const snapshot = makeSnapshot(signals);
    const eligibility = evaluateParentVerificationEligibility({ snapshot, signals });
    expect(eligibility.decision).toBe("verify");
  });

  test("evaluateParentVerificationEligibility skips on unknown coverage", () => {
    const signals: RelationshipSignal[] = [
      { source: "github", kind: "sub_issue", state: "unknown", ref: { repo: "3mdistal/ralph", number: 1 } },
    ];
    const snapshot = makeSnapshot(signals, { githubSubIssuesComplete: false });
    const eligibility = evaluateParentVerificationEligibility({ snapshot, signals });
    expect(eligibility.decision).toBe("skip");
  });

  test("buildParentVerificationPrompt includes marker", () => {
    const prompt = buildParentVerificationPrompt({
      repo: "3mdistal/ralph",
      issueNumber: 10,
      issueUrl: "https://github.com/3mdistal/ralph/issues/10",
      childIssues: [{ repo: "3mdistal/ralph", number: 1 }],
      evidence: [],
    });
    expect(prompt.includes(PARENT_VERIFY_MARKER)).toBe(true);
  });
});
