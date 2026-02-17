import { describe, expect, test } from "bun:test";

import { classifyManagedWorktreePath, isManagedWorktreeRootClassification } from "../worktree-layout";

describe("worktree layout classification", () => {
  const managedRoot = "/home/test/.ralph/worktrees";

  test("classifies slot layout roots", () => {
    const result = classifyManagedWorktreePath("/home/test/.ralph/worktrees/owner-repo/slot-4/745/task-a", managedRoot);
    expect(result.kind).toBe("slot-root");
    expect(isManagedWorktreeRootClassification(result)).toBe(true);
  });

  test("classifies slot parent issue directories", () => {
    const result = classifyManagedWorktreePath("/home/test/.ralph/worktrees/owner-repo/slot-4/745", managedRoot);
    expect(result.kind).toBe("parent");
    expect(isManagedWorktreeRootClassification(result)).toBe(false);
  });

  test("classifies legacy layout roots", () => {
    const result = classifyManagedWorktreePath("/home/test/.ralph/worktrees/owner-repo/745/task-a", managedRoot);
    expect(result.kind).toBe("legacy-root");
    expect(isManagedWorktreeRootClassification(result)).toBe(true);
  });

  test("classifies legacy parent issue directories", () => {
    const result = classifyManagedWorktreePath("/home/test/.ralph/worktrees/owner-repo/745", managedRoot);
    expect(result.kind).toBe("parent");
    expect(isManagedWorktreeRootClassification(result)).toBe(false);
  });

  test("rejects malformed slot or non-numeric issue paths", () => {
    const malformedSlot = classifyManagedWorktreePath(
      "/home/test/.ralph/worktrees/owner-repo/slot-a/745/task-a",
      managedRoot
    );
    expect(malformedSlot.kind).toBe("invalid");

    const malformedIssue = classifyManagedWorktreePath(
      "/home/test/.ralph/worktrees/owner-repo/slot-4/not-a-number/task-a",
      managedRoot
    );
    expect(malformedIssue.kind).toBe("invalid");
  });
});
