import { describe, test, expect } from "bun:test";

import { decideLegacyWorktreeSafety } from "../legacy-worktree-safety";

describe("legacy worktree safety", () => {
  test("rejects invalid worktree", () => {
    const result = decideLegacyWorktreeSafety({
      validWorktree: false,
      detached: false,
      branchRef: "refs/heads/feature",
      dirty: false,
      baseRef: "main",
      baseRefAvailable: true,
      mergedIntoBase: true,
      error: "missing",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing");
  });

  test("rejects detached or missing branch", () => {
    const result = decideLegacyWorktreeSafety({
      validWorktree: true,
      detached: true,
      branchRef: null,
      dirty: false,
      baseRef: "main",
      baseRefAvailable: true,
      mergedIntoBase: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("detached HEAD or missing branch");
  });

  test("rejects missing base ref", () => {
    const result = decideLegacyWorktreeSafety({
      validWorktree: true,
      detached: false,
      branchRef: "refs/heads/feature",
      dirty: false,
      baseRef: null,
      baseRefAvailable: false,
      mergedIntoBase: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("base ref not found; run git fetch --all --prune");
  });

  test("rejects dirty worktree", () => {
    const result = decideLegacyWorktreeSafety({
      validWorktree: true,
      detached: false,
      branchRef: "refs/heads/feature",
      dirty: true,
      baseRef: "main",
      baseRefAvailable: true,
      mergedIntoBase: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("worktree has uncommitted changes");
  });

  test("rejects unmerged branch", () => {
    const result = decideLegacyWorktreeSafety({
      validWorktree: true,
      detached: false,
      branchRef: "refs/heads/feature",
      dirty: false,
      baseRef: "main",
      baseRefAvailable: true,
      mergedIntoBase: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("branch not merged into main");
  });

  test("accepts safe worktree", () => {
    const result = decideLegacyWorktreeSafety({
      validWorktree: true,
      detached: false,
      branchRef: "refs/heads/feature",
      dirty: false,
      baseRef: "main",
      baseRefAvailable: true,
      mergedIntoBase: true,
    });
    expect(result.ok).toBe(true);
  });
});
