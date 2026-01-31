import { describe, expect, test } from "bun:test";

import {
  getParentVerificationEligibility,
  hasRequiredParentEvidence,
  parseParentVerificationOutput,
  type ParentVerificationChild,
} from "../parent-verification/core";

import type { IssueRelationshipSnapshot } from "../github/issue-relationships";

describe("parent verification core", () => {
  test("eligibility requires closed sub-issues and complete coverage", () => {
    const snapshot: IssueRelationshipSnapshot = {
      issue: { repo: "acme/widgets", number: 10 },
      signals: [
        { source: "github", kind: "sub_issue", state: "closed", ref: { repo: "acme/widgets", number: 11 } },
      ],
      coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: false },
    };

    const eligibility = getParentVerificationEligibility(snapshot, snapshot.signals);
    expect(eligibility.eligible).toBe(true);
  });

  test("eligibility fails when sub-issue is open", () => {
    const snapshot: IssueRelationshipSnapshot = {
      issue: { repo: "acme/widgets", number: 10 },
      signals: [
        { source: "github", kind: "sub_issue", state: "open", ref: { repo: "acme/widgets", number: 11 } },
      ],
      coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: false },
    };

    const eligibility = getParentVerificationEligibility(snapshot, snapshot.signals);
    expect(eligibility.eligible).toBe(false);
  });

  test("eligibility fails when coverage is incomplete", () => {
    const snapshot: IssueRelationshipSnapshot = {
      issue: { repo: "acme/widgets", number: 10 },
      signals: [],
      coverage: { githubDepsComplete: true, githubSubIssuesComplete: false, bodyDeps: false },
    };

    const eligibility = getParentVerificationEligibility(snapshot, snapshot.signals);
    expect(eligibility.eligible).toBe(false);
  });

  test("parses parent verification marker", () => {
    const output =
      "RALPH_PARENT_VERIFY: {\"version\":\"v1\",\"satisfied\":true,\"evidence\":[{\"label\":\"PR\",\"url\":\"https://example.com\",\"kind\":\"pull_request\"}],\"remainingWork\":\"\"}";
    const result = parseParentVerificationOutput(output);
    expect(result.valid).toBe(true);
    expect(result.satisfied).toBe(true);
    expect(result.evidence.length).toBe(1);
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
        evidence: [{ label: "PR", url: "https://example.com/pr", kind: "pull_request" }],
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
  });
});
