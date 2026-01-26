import { describe, expect, test } from "bun:test";
import type { MergeConflictAttempt } from "../github/merge-conflict-comment";
import {
  buildMergeConflictCommentLines,
  buildMergeConflictSignature,
  computeMergeConflictDecision,
} from "../merge-conflict-recovery";

describe("merge-conflict recovery helpers", () => {
  test("buildMergeConflictSignature is order-insensitive", () => {
    const a = buildMergeConflictSignature({
      baseSha: "base",
      headSha: "head",
      conflictPaths: ["b.txt", "a.txt"],
    });
    const b = buildMergeConflictSignature({
      baseSha: "base",
      headSha: "head",
      conflictPaths: ["a.txt", "b.txt"],
    });
    expect(a).toBe(b);
  });

  test("computeMergeConflictDecision stops on repeated signature", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 3, nextSignature: "sig" });
    expect(decision.stop).toBe(true);
    expect(decision.repeated).toBe(true);
  });

  test("computeMergeConflictDecision stops on max attempts", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed" },
      { attempt: 2, signature: "sig2", startedAt: "later", status: "failed" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 2, nextSignature: "sig3" });
    expect(decision.stop).toBe(true);
    expect(decision.attemptsExhausted).toBe(true);
  });

  test("buildMergeConflictCommentLines includes action and attempts", () => {
    const lines = buildMergeConflictCommentLines({
      prUrl: "https://github.com/3mdistal/ralph/pull/1",
      baseRefName: "bot/integration",
      headRefName: "feature",
      conflictPaths: ["a.txt"],
      attemptCount: 1,
      maxAttempts: 2,
      action: "Ralph is resolving conflicts.",
    });
    expect(lines.join("\n")).toContain("Action:");
    expect(lines.join("\n")).toContain("Attempts:");
  });
});
