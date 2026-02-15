import { describe, expect, test } from "bun:test";

import { computeTaskWorktreeCandidates, evaluateWorktreePruneSafety, pruneManagedWorktreeBestEffort } from "../worktree-prune";

describe("worktree prune safety", () => {
  const managedRoot = "/home/test/.ralph/worktrees";
  const repoPath = "/home/test/Developer/ralph";
  const devDir = "/home/test/Developer";

  test("allows managed slot layout path", () => {
    const safety = evaluateWorktreePruneSafety({
      worktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/slot-2/210/task-a",
      managedRoot,
      repoPath,
      devDir,
    });
    expect(safety.safe).toBe(true);
    expect(safety.reason).toBe("ok");
  });

  test("allows managed legacy layout path", () => {
    const safety = evaluateWorktreePruneSafety({
      worktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/210/task-a",
      managedRoot,
      repoPath,
      devDir,
    });
    expect(safety.safe).toBe(true);
    expect(safety.reason).toBe("ok");
  });

  test("denies outside managed root and repo root", () => {
    const outside = evaluateWorktreePruneSafety({
      worktreePath: "/tmp/random",
      managedRoot,
      repoPath,
      devDir,
    });
    expect(outside.safe).toBe(false);
    expect(outside.reason).toBe("outside-managed-root");

    const repoRoot = evaluateWorktreePruneSafety({
      worktreePath: repoPath,
      managedRoot,
      repoPath,
      devDir,
    });
    expect(repoRoot.safe).toBe(false);
    expect(repoRoot.reason).toBe("outside-managed-root");
  });

  test("denies invalid layout under managed root", () => {
    const safety = evaluateWorktreePruneSafety({
      worktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/not-a-slot",
      managedRoot,
      repoPath,
      devDir,
    });
    expect(safety.safe).toBe(false);
    expect(safety.reason).toBe("invalid-layout");
  });

  test("denies slot issue parent directory", () => {
    const safety = evaluateWorktreePruneSafety({
      worktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/slot-2/210",
      managedRoot,
      repoPath,
      devDir,
    });
    expect(safety.safe).toBe(false);
    expect(safety.reason).toBe("invalid-layout");
  });

  test("unsafe prune exits without attempting deletion", async () => {
    const result = await pruneManagedWorktreeBestEffort({
      repoPath,
      worktreePath: "/tmp/unsafe",
      managedRoot,
      devDir,
    });
    expect(result.attempted).toBe(false);
    expect(result.pruned).toBe(false);
  });

  test("computes candidate worktree paths from recorded and slot", () => {
    const candidates = computeTaskWorktreeCandidates({
      repo: "3mdistal/ralph",
      issueNumber: 210,
      taskPath: "github:3mdistal/ralph#210",
      repoSlot: "2",
      recordedWorktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/slot-2/210/task-a",
    });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]).toContain(".ralph/worktrees");
  });
});
