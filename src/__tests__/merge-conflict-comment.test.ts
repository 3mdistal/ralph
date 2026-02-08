import { describe, expect, test } from "bun:test";

import {
  buildMergeConflictCommentBody,
  parseMergeConflictState,
  type MergeConflictCommentState,
} from "../github/merge-conflict-comment";

describe("merge-conflict comment state", () => {
  test("round-trips state with failure metadata and HTML-like characters", () => {
    const state: MergeConflictCommentState = {
      version: 1,
      attempts: [
        {
          attempt: 1,
          signature: "sig",
          startedAt: "now",
          completedAt: "later",
          status: "failed",
          failureClass: "tooling",
          failureReason: "Tool exited unexpectedly --> needs <manual> review > now",
        },
      ],
      lastSignature: "sig",
    };

    const body = buildMergeConflictCommentBody({
      marker: "<!-- ralph-merge-conflict:id=abc123 -->",
      state,
      lines: ["Merge-conflict recovery status"],
    });

    const parsed = parseMergeConflictState(body);
    expect(parsed).toEqual(state);
  });
});
