import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { discoverManagedWorktreeRoots, planOrphanedWorktreeCleanup } from "../worker/orphaned-worktree-cleanup";

describe("orphaned worktree cleanup planning", () => {
  let managedRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    managedRoot = await mkdtemp(join(tmpdir(), "ralph-managed-root-"));
    repoDir = join(managedRoot, "owner-repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(managedRoot, { recursive: true, force: true });
  });

  test("discovers slot and legacy roots without selecting parent dirs", async () => {
    await mkdir(join(repoDir, "slot-4", "745", "task-a"), { recursive: true });
    await mkdir(join(repoDir, "slot-4", "745", "task-b"), { recursive: true });
    await mkdir(join(repoDir, "745", "legacy-task"), { recursive: true });

    const discovered = await discoverManagedWorktreeRoots(repoDir, managedRoot);

    expect(discovered).toContain(join(repoDir, "slot-4", "745", "task-a"));
    expect(discovered).toContain(join(repoDir, "slot-4", "745", "task-b"));
    expect(discovered).toContain(join(repoDir, "745", "legacy-task"));
    expect(discovered).not.toContain(join(repoDir, "slot-4", "745"));
    expect(discovered).not.toContain(join(repoDir, "745"));
  });

  test("plans no destructive actions when git inventory fails", () => {
    const actions = planOrphanedWorktreeCleanup({
      gitInventoryOk: false,
      registeredWorktreePaths: [join(repoDir, "slot-4", "745", "task-a")],
      discoveredWorktreeRoots: [join(repoDir, "slot-4", "745", "task-b")],
      managedRoot,
      repoRoot: "/home/test/Developer/repo",
      isRepoWorktreePath: () => true,
      isHealthyWorktreePath: () => false,
    });

    expect(actions).toEqual([]);
  });

  test("plans registered and unregistered cleanup actions for mixed layouts", () => {
    const registeredUnhealthy = join(repoDir, "slot-4", "745", "task-a");
    const unregisteredSlot = join(repoDir, "slot-4", "745", "task-b");
    const unregisteredLegacy = join(repoDir, "745", "legacy-task");
    const parentDir = join(repoDir, "slot-4", "745");

    const isHealthyWorktreePath = mock((path: string) => path.endsWith("task-healthy"));
    const isRepoWorktreePath = mock((path: string) => path.startsWith(repoDir));

    const actions = planOrphanedWorktreeCleanup({
      gitInventoryOk: true,
      registeredWorktreePaths: [registeredUnhealthy],
      discoveredWorktreeRoots: [registeredUnhealthy, unregisteredSlot, unregisteredLegacy, parentDir],
      managedRoot,
      repoRoot: "/home/test/Developer/repo",
      isRepoWorktreePath,
      isHealthyWorktreePath,
    });

    expect(actions).toEqual([
      { kind: "remove-registered-via-git", worktreePath: registeredUnhealthy },
      { kind: "remove-unregistered-via-fs", worktreePath: unregisteredSlot },
      { kind: "remove-unregistered-via-fs", worktreePath: unregisteredLegacy },
    ]);
  });
});
