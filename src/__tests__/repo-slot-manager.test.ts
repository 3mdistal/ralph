import { describe, expect, test } from "bun:test";

import {
  assignRepoSlot,
  parseRepoSlot,
  parseRepoSlotFromWorktreePath,
  RepoSlotManager,
} from "../repo-slot-manager";

describe("repo-slot-manager", () => {
  test("assignRepoSlot prefers requested slot when available", () => {
    const inUse = new Set<number>([1]);
    expect(assignRepoSlot({ limit: 3, inUse, preferred: 2 })).toBe(2);
  });

  test("assignRepoSlot picks lowest free slot", () => {
    const inUse = new Set<number>([0, 2]);
    expect(assignRepoSlot({ limit: 4, inUse })).toBe(1);
  });

  test("parseRepoSlot reads numeric values", () => {
    expect(parseRepoSlot("2")).toBe(2);
    expect(parseRepoSlot(3)).toBe(3);
    expect(parseRepoSlot(" ")).toBeNull();
  });

  test("parseRepoSlotFromWorktreePath extracts slot", () => {
    expect(parseRepoSlotFromWorktreePath("/tmp/slot-4/issue/task")).toBe(4);
    expect(parseRepoSlotFromWorktreePath("C:\\tmp\\slot-7\\issue"))
      .toBe(7);
  });

  test("reserveSlotForTask reuses slot for same task", () => {
    const manager = new RepoSlotManager(() => 2);
    const first = manager.reserveSlotForTask("demo/repo", "task-1");
    const second = manager.reserveSlotForTask("demo/repo", "task-1");
    expect(first?.slot).toBe(0);
    expect(second?.slot).toBe(0);
    first?.release();
    second?.release();
    expect(manager.listInUse("demo/repo")).toEqual([]);
  });

  test("startup seed honors preferred slot", () => {
    const manager = new RepoSlotManager(() => 2);
    const seeded = manager.reserveSlotForTask("demo/repo", "task-1", { preferred: 1 });
    const resumed = manager.reserveSlotForTask("demo/repo", "task-1", { preferred: 1 });
    expect(seeded?.slot).toBe(1);
    expect(resumed?.slot).toBe(1);
  });
});
