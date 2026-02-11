import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

describe("state orphan op-state helpers", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();

    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();
  });

  afterEach(async () => {
    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();

    process.env.HOME = priorHome;
    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;

    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("lists orphaned task op-state and clears with CAS guard", async () => {
    const stateMod = await import("../state");
    const now = "2026-02-11T10:00:00.000Z";

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#210",
      title: "orphan",
      state: "OPEN",
      at: now,
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#210",
      labels: [],
      at: now,
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#210",
      taskPath: "github:3mdistal/ralph#210",
      status: "blocked",
      sessionId: "sess-1",
      worktreePath: "/tmp/worktrees/slot-1/210/task",
      workerId: "worker-1",
      repoSlot: "1",
      daemonId: "daemon-1",
      heartbeatAt: "2026-02-11T09:50:00.000Z",
      at: now,
    });

    const orphans = stateMod.listOrphanedTasksWithOpState("3mdistal/ralph");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.orphanReason).toBe("no-ralph-labels");

    const race = stateMod.clearTaskOpState({
      repo: "3mdistal/ralph",
      taskPath: "github:3mdistal/ralph#210",
      expectedDaemonId: "daemon-other",
      expectedHeartbeatAt: "2026-02-11T09:50:00.000Z",
      releasedReason: "orphan:no-ralph-labels",
    });
    expect(race).toEqual({ cleared: false, raceSkipped: true });

    const cleared = stateMod.clearTaskOpState({
      repo: "3mdistal/ralph",
      taskPath: "github:3mdistal/ralph#210",
      expectedDaemonId: "daemon-1",
      expectedHeartbeatAt: "2026-02-11T09:50:00.000Z",
      releasedReason: "orphan:no-ralph-labels",
    });
    expect(cleared).toEqual({ cleared: true, raceSkipped: false });

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#210");
    expect(opState?.sessionId ?? null).toBeNull();
    expect(opState?.worktreePath ?? null).toBeNull();
    expect(opState?.daemonId ?? null).toBeNull();
    expect(opState?.heartbeatAt ?? null).toBeNull();
  });
});
