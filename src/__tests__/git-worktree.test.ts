import { describe, test, expect } from "bun:test";

import {
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
});
