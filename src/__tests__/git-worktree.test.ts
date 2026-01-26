import { describe, test, expect } from "bun:test";

import {
  detectLegacyWorktrees,
  isPathUnderDir,
  isLegacyWorktreePath,
  parseGitWorktreeListPorcelain,
  pickWorktreeForIssue,
  stripHeadsRef,
} from "../git-worktree";

describe("git-worktree helpers", () => {
  test("parseGitWorktreeListPorcelain parses basic porcelain output", () => {
    const input = [
      "worktree /repo",
      "HEAD deadbeef",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt-1",
      "HEAD cafebabe",
      "branch refs/heads/fix/audit-fix-writes-346",
      "",
    ].join("\n");

    const entries = parseGitWorktreeListPorcelain(input);
    expect(entries.length).toBe(2);
    expect(entries[0].worktreePath).toBe("/repo");
    expect(entries[0].branch).toBe("refs/heads/main");
    expect(entries[1].worktreePath).toBe("/repo-wt-1");
    expect(entries[1].branch).toBe("refs/heads/fix/audit-fix-writes-346");
  });

  test("stripHeadsRef strips refs/heads prefix", () => {
    expect(stripHeadsRef("refs/heads/main")).toBe("main");
    expect(stripHeadsRef("fix/audit-fix-writes-346")).toBe("fix/audit-fix-writes-346");
    expect(stripHeadsRef(undefined)).toBeNull();
  });

  test("pickWorktreeForIssue prefers worktree-<issue> paths", () => {
    const entries = parseGitWorktreeListPorcelain(
      [
        "worktree /repo",
        "HEAD deadbeef",
        "branch refs/heads/main",
        "",
        "worktree /Users/alice/Developer/worktree-272-audit-fix-phase5",
        "HEAD abcdef01",
        "branch refs/heads/fix/audit-fix-phase5-272",
        "",
        "worktree /Users/alice/Developer/worktree-346-audit-fix-writes",
        "HEAD abcdef02",
        "branch refs/heads/fix/audit-fix-writes-346",
        "",
      ].join("\n")
    );

    const picked = pickWorktreeForIssue(entries, "346", { deprioritizeBranches: ["main", "bot/integration"] });
    expect(picked?.worktreePath).toContain("worktree-346");
    expect(stripHeadsRef(picked?.branch ?? undefined)).toBe("fix/audit-fix-writes-346");
  });

  test("parseGitWorktreeListPorcelain handles detached entry", () => {
    const input = ["worktree /repo", "HEAD deadbeef", "detached", ""].join("\n");
    const entries = parseGitWorktreeListPorcelain(input);
    expect(entries).toEqual([{ worktreePath: "/repo", head: "deadbeef", detached: true }]);
  });

  test("parseGitWorktreeListPorcelain skips blank lines", () => {
    const input = ["", "worktree /repo", "", "HEAD deadbeef", "", ""].join("\n");
    const entries = parseGitWorktreeListPorcelain(input);
    expect(entries).toEqual([{ worktreePath: "/repo", head: "deadbeef" }]);
  });

  test("isPathUnderDir matches nested paths", () => {
    expect(isPathUnderDir("/tmp/ralph/worktrees/a", "/tmp/ralph/worktrees")).toBe(true);
    expect(isPathUnderDir("/tmp/ralph/worktrees", "/tmp/ralph/worktrees")).toBe(true);
    expect(isPathUnderDir("/tmp/ralph/worktrees-2", "/tmp/ralph/worktrees")).toBe(false);
    expect(isPathUnderDir("/tmp/ralph/worktrees/a/b", "/tmp/ralph/worktrees/a")).toBe(true);
  });

  test("isLegacyWorktreePath matches legacy devDir patterns", () => {
    const opts = { devDir: "/Users/alice/Developer", managedRoot: "/Users/alice/.ralph/worktrees" };
    expect(isLegacyWorktreePath("/Users/alice/Developer/worktree-issue-215", opts)).toBe(true);
    expect(isLegacyWorktreePath("/Users/alice/Developer/worktree-215-fix", opts)).toBe(true);
    expect(isLegacyWorktreePath("/Users/alice/.ralph/worktrees/owner-repo/slot-0/215/foo", opts)).toBe(false);
    expect(isLegacyWorktreePath("/tmp/worktree-215", opts)).toBe(false);
  });

  test("detectLegacyWorktrees returns only legacy paths", () => {
    const entries = parseGitWorktreeListPorcelain(
      [
        "worktree /repo",
        "HEAD deadbeef",
        "branch refs/heads/main",
        "",
        "worktree /Users/alice/Developer/worktree-215-fix",
        "HEAD cafe",
        "branch refs/heads/fix/215",
        "",
        "worktree /Users/alice/.ralph/worktrees/owner-repo/slot-0/215/foo",
        "HEAD beef",
        "branch refs/heads/fix/foo",
        "",
      ].join("\n")
    );

    const legacy = detectLegacyWorktrees(entries, {
      devDir: "/Users/alice/Developer",
      managedRoot: "/Users/alice/.ralph/worktrees",
    });

    expect(legacy.length).toBe(1);
    expect(legacy[0]?.worktreePath).toContain("worktree-215-fix");
  });
});
