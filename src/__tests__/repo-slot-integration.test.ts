import { describe, expect, test } from "bun:test";

import { RepoSlotManager } from "../repo-slot-manager";
import { buildWorktreePath } from "../worktree-paths";

describe("repo slot integration", () => {
  test("distinct slots produce distinct worker/worktree identity", () => {
    const repo = "demo/repo";
    const taskA = { _path: "orchestration/tasks/task-a" };
    const taskB = { _path: "orchestration/tasks/task-b" };

    const manager = new RepoSlotManager(() => 2);
    const slotA = manager.reserveSlotForTask(repo, taskA._path)?.slot;
    const slotB = manager.reserveSlotForTask(repo, taskB._path)?.slot;

    expect(slotA).toBe(0);
    expect(slotB).toBe(1);

    const workerIdA = `${repo}#${taskA._path}`;
    const workerIdB = `${repo}#${taskB._path}`;

    const worktreeA = buildWorktreePath({
      repo,
      issueNumber: "123",
      taskKey: taskA._path,
      repoSlot: slotA ?? 0,
    });
    const worktreeB = buildWorktreePath({
      repo,
      issueNumber: "123",
      taskKey: taskB._path,
      repoSlot: slotB ?? 0,
    });

    expect(workerIdA).not.toBe(workerIdB);
    expect(worktreeA).not.toBe(worktreeB);
  });
});
