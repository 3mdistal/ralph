import { describe, expect, test } from "bun:test";

import { buildBlockedCommentBody, extractDependencyRefs, parseBlockedCommentState } from "../github/blocked-comment";

describe("blocked comment", () => {
  test("builds and parses v1 state payload", () => {
    const body = buildBlockedCommentBody({
      marker: "<!-- ralph-blocked:v1 id=abc123 -->",
      issueNumber: 745,
      state: {
        version: 1,
        kind: "deps",
        blocked: true,
        reason: "blocked by 3mdistal/ralph#11",
        deps: [{ repo: "3mdistal/ralph", issueNumber: 11 }],
        blockedAt: "2026-02-14T21:08:07.311Z",
        updatedAt: "2026-02-14T21:08:08.000Z",
      },
    });

    const parsed = parseBlockedCommentState(body);
    expect(parsed).toBeTruthy();
    expect(parsed?.blocked).toBe(true);
    expect(parsed?.deps).toEqual([{ repo: "3mdistal/ralph", issueNumber: 11 }]);
  });

  test("returns null for malformed state payload", () => {
    const parsed = parseBlockedCommentState("<!-- ralph-blocked:state={not-json} -->");
    expect(parsed).toBeNull();
  });

  test("extracts dependency refs from reason text", () => {
    const refs = extractDependencyRefs("blocked by #11 and 3mdistal/ralph#42", "3mdistal/ralph");
    expect(refs).toEqual([
      { repo: "3mdistal/ralph", issueNumber: 11 },
      { repo: "3mdistal/ralph", issueNumber: 42 },
    ]);
  });
});
