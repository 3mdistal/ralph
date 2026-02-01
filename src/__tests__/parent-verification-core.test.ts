import { describe, expect, test } from "bun:test";

import {
  PARENT_VERIFY_MARKER,
  getParentVerificationEligibility,
  hasRequiredParentEvidence,
  parseParentVerificationOutput,
  type ParentVerificationChild,
} from "../parent-verification/core";

import type { IssueRelationshipSnapshot } from "../github/issue-relationships";

function buildSnapshot(overrides: Partial<IssueRelationshipSnapshot>): IssueRelationshipSnapshot {
  return {
    issue: { repo: "acme/widgets", number: 10 },
    signals: [],
    coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: false },
    ...overrides,
  };
}

describe("parent verification core", () => {
  test("eligibility requires closed sub-issues and complete coverage", () => {
    const snapshot = buildSnapshot({
      signals: [{ source: "github", kind: "sub_issue", state: "closed", ref: { repo: "acme/widgets", number: 11 } }],
    });

    const eligibility = getParentVerificationEligibility(snapshot, snapshot.signals);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.childRefs).toEqual([{ repo: "acme/widgets", number: 11 }]);
  });

  test("eligibility fails when sub-issue is open", () => {
    const snapshot = buildSnapshot({
      signals: [{ source: "github", kind: "sub_issue", state: "open", ref: { repo: "acme/widgets", number: 11 } }],
    });

    const eligibility = getParentVerificationEligibility(snapshot, snapshot.signals);
    expect(eligibility.eligible).toBe(false);
  });

  test("eligibility fails when coverage is incomplete", () => {
    const snapshot = buildSnapshot({
      coverage: { githubDepsComplete: true, githubSubIssuesComplete: false, bodyDeps: false },
    });

    const eligibility = getParentVerificationEligibility(snapshot, snapshot.signals);
    expect(eligibility.eligible).toBe(false);
  });

  test("parses parent verification marker", () => {
    const output = [
      "intro",
      `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true,"reason":"ok","evidence":["https://example.com/pr"]}`,
    ].join("\n");
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(true);
    expect(result.satisfied).toBe(true);
    expect(result.evidence?.length).toBe(1);
  });

  test("marker must be final non-empty line", () => {
    const output = [
      `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true}`,
      "extra",
    ].join("\n");
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker inside body text is ignored", () => {
    const output = [
      `note ${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true}`,
      "still not a marker",
    ].join("\n");
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker with leading whitespace is invalid", () => {
    const output = `  ${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker rejects unknown keys", () => {
    const output = `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true,"extra":"nope"}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker rejects oversized lines", () => {
    const longReason = "x".repeat(9000);
    const output = `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true,"reason":"${longReason}"}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker rejects non-array evidence", () => {
    const output = `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true,"evidence":"nope"}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker rejects non-string evidence entries", () => {
    const output = `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true,"evidence":[1]}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker rejects oversized evidence arrays", () => {
    const evidence = Array.from({ length: 21 }, (_, i) => `item-${i}`);
    const output = `${PARENT_VERIFY_MARKER}${JSON.stringify({
      version: "v1",
      satisfied: true,
      evidence,
    })}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("marker rejects oversized payloads", () => {
    const longReason = "a".repeat(5000);
    const output = `${PARENT_VERIFY_MARKER}${JSON.stringify({
      version: "v1",
      satisfied: true,
      reason: longReason,
    })}`;
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(false);
  });

  test("last marker wins when multiple markers exist", () => {
    const output = [
      `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true}`,
      `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":false}`,
    ].join("\n");
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(true);
    expect(result.satisfied).toBe(false);
  });

  test("missing marker yields invalid result", () => {
    const result = parseParentVerificationOutput("no marker here");
    expect(result.valid).toBe(false);
    expect(result.satisfied).toBe(false);
  });

  test("requires merge evidence for each child", () => {
    const children: ParentVerificationChild[] = [
      {
        ref: { repo: "acme/widgets", number: 11 },
        title: "Child",
        url: "https://example.com",
        state: "closed",
        evidence: [{ label: "PR", url: "https://example.com/pr", kind: "pr" }],
      },
      {
        ref: { repo: "acme/widgets", number: 12 },
        title: "Child 2",
        url: "https://example.com/2",
        state: "closed",
        evidence: [],
      },
    ];

    expect(hasRequiredParentEvidence(children)).toBe(false);
    expect(hasRequiredParentEvidence([children[0]])).toBe(true);
  });
});
