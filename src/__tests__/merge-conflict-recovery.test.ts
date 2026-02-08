import { describe, expect, test } from "bun:test";
import type { MergeConflictAttempt } from "../github/merge-conflict-comment";
import {
  buildMergeConflictCommentLines,
  buildMergeConflictEscalationDetails,
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

  test("computeMergeConflictDecision allows one grace retry on repeated runtime failure", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed", failureClass: "runtime" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 3, nextSignature: "sig" });
    expect(decision.stop).toBe(false);
    expect(decision.repeated).toBe(true);
  });

  test("computeMergeConflictDecision stops when grace is exhausted", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed", failureClass: "runtime" },
      { attempt: 2, signature: "sig", startedAt: "later", status: "failed", failureClass: "runtime" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 5, nextSignature: "sig" });
    expect(decision.stop).toBe(true);
    expect(decision.code).toBe("repeat-grace-exhausted");
  });

  test("computeMergeConflictDecision stops immediately on repeated merge-content signature", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed", failureClass: "merge-content" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 3, nextSignature: "sig" });
    expect(decision.stop).toBe(true);
    expect(decision.code).toBe("repeat-merge-content");
  });

  test("computeMergeConflictDecision treats legacy attempts as unknown and stops on repeat", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 3, nextSignature: "sig" });
    expect(decision.stop).toBe(true);
    expect(decision.code).toBe("repeat-unknown");
  });

  test("computeMergeConflictDecision stops on max attempts", () => {
    const attempts: MergeConflictAttempt[] = [
      { attempt: 1, signature: "sig", startedAt: "now", status: "failed" },
      { attempt: 2, signature: "sig2", startedAt: "later", status: "failed" },
    ];
    const decision = computeMergeConflictDecision({ attempts, maxAttempts: 2, nextSignature: "sig3" });
    expect(decision.stop).toBe(true);
    expect(decision.attemptsExhausted).toBe(true);
    expect(decision.code).toBe("attempts-exhausted");
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

  test("buildMergeConflictEscalationDetails includes commands and bounded file sample", () => {
    const details = buildMergeConflictEscalationDetails({
      prUrl: "https://github.com/3mdistal/ralph/pull/1",
      baseRefName: "bot/integration",
      headRefName: "feature",
      attempts: [
        {
          attempt: 1,
          signature: "sig",
          startedAt: "now",
          status: "failed",
          conflictCount: 10,
          conflictPaths: ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt", "i.txt"],
        },
      ],
      reason: "Conflicts remain",
      botBranch: "bot/integration",
    });

    expect(details).toContain("git merge --no-edit origin/bot/integration");
    expect(details).toContain("git push origin HEAD:feature");
    expect(details).toContain("Do not rebase or force-push");
    expect(details).toContain("- a.txt");
    expect(details).toContain("- h.txt");
    expect(details).not.toContain("- i.txt");
  });
});
