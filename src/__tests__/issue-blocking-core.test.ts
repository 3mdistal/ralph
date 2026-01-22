import { describe, expect, test } from "bun:test";

import { computeBlockedDecision, parseIssueBodyDependencies } from "../github/issue-blocking-core";

describe("parseIssueBodyDependencies", () => {
  test("parses blocked-by and blocks sections", () => {
    const body = [
      "## Blocked by",
      "- [ ] #12 blocker",
      "- [x] owner/repo#34 resolved",
      "- [ ] not-an-issue #99",
      "",
      "## Blocks",
      "- [ ] #56",
    ].join("\n");

    const parsed = parseIssueBodyDependencies(body, "acme/alpha");

    expect(parsed.blockedBySection).toBe(true);
    expect(parsed.blocksSection).toBe(true);
    expect(parsed.blockedBy.map((signal) => signal.ref)).toEqual([
      { repo: "acme/alpha", number: 12 },
      { repo: "owner/repo", number: 34 },
    ]);
    expect(parsed.blockedBy.map((signal) => signal.state)).toEqual(["open", "closed"]);
    expect(parsed.blocks).toEqual([{ repo: "acme/alpha", number: 56 }]);
  });
});

describe("computeBlockedDecision", () => {
  test("returns blocked when any open signal exists", () => {
    const decision = computeBlockedDecision([
      { source: "github", kind: "blocked_by", state: "open", ref: { repo: "acme/alpha", number: 10 } },
      { source: "github", kind: "blocked_by", state: "closed", ref: { repo: "acme/alpha", number: 11 } },
    ]);

    expect(decision.blocked).toBe(true);
    expect(decision.confidence).toBe("certain");
    expect(decision.reasons).toContain("blocked by acme/alpha#10");
  });

  test("returns unknown when only unknown signals exist", () => {
    const decision = computeBlockedDecision([
      { source: "github", kind: "blocked_by", state: "unknown" },
    ]);

    expect(decision.blocked).toBe(false);
    expect(decision.confidence).toBe("unknown");
  });
});
