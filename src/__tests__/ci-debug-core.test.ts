import { describe, expect, test } from "bun:test";

import { buildCiDebugStatusComment, computeFailureSignature, type CiDebugSummary } from "../ci-debug/core";

describe("ci-debug core", () => {
  test("computeFailureSignature uses sorted name+state", () => {
    const summary: CiDebugSummary = {
      status: "failure",
      required: [
        { name: "B", state: "FAILURE", rawState: "FAILURE" },
        { name: "A", state: "FAILURE", rawState: "TIMED_OUT" },
      ],
      available: [],
    };

    expect(computeFailureSignature(summary)).toBe("A:TIMED_OUT|B:FAILURE");
  });

  test("buildCiDebugStatusComment includes marker and action", () => {
    const summary: CiDebugSummary = {
      status: "failure",
      required: [{ name: "CI", state: "FAILURE", rawState: "FAILURE", detailsUrl: "https://ci" }],
      available: [],
    };
    const body = buildCiDebugStatusComment({
      marker: "<!-- ralph-ci-debug:id=abc123 -->",
      prUrl: "https://github.com/3mdistal/ralph/pull/1",
      baseRefName: "bot/integration",
      headSha: "deadbeef",
      summary,
      action: "spawn",
      attemptCount: 1,
      sessionId: "ses_123",
    });

    expect(body).toContain("<!-- ralph-ci-debug:id=abc123 -->");
    expect(body).toContain("Action: Ralph is spawning a dedicated CI-debug run");
    expect(body).toContain("CI: FAILURE");
    expect(body).toContain("Attempt: 1");
    expect(body).toContain("Session: ses_123");
  });
});
