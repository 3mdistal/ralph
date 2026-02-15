import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type { IssueSnapshot, TaskOpState } from "../state";
import { planLocalStatusDriftRepair, reconcileLocalStatusDriftForRepo } from "../github/local-status-drift";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("local status drift planner", () => {
  test("plans repair for stale local escalated when GitHub is queued", () => {
    const issue: IssueSnapshot = {
      repo: "3mdistal/ralph",
      number: 761,
      state: "OPEN",
      labels: ["ralph:status:queued"],
    };
    const opState: TaskOpState = {
      repo: "3mdistal/ralph",
      issueNumber: 761,
      taskPath: "github:3mdistal/ralph#761",
      status: "escalated",
      heartbeatAt: "2026-02-15T18:00:00.000Z",
    };

    const plan = planLocalStatusDriftRepair({
      issue,
      opState,
      nowMs: Date.parse("2026-02-15T18:10:00.000Z"),
      ttlMs: 60_000,
    });

    expect(plan.decision).toBe("repair");
    expect(plan.targetStatus).toBe("queued");
    expect(plan.reason).toBe("repaired");
  });

  test("skips repair when ownership heartbeat is fresh even without daemon id", () => {
    const issue: IssueSnapshot = {
      repo: "3mdistal/ralph",
      number: 761,
      state: "OPEN",
      labels: ["ralph:status:queued"],
    };
    const opState: TaskOpState = {
      repo: "3mdistal/ralph",
      issueNumber: 761,
      taskPath: "github:3mdistal/ralph#761",
      status: "escalated",
      heartbeatAt: "2026-02-15T18:09:50.000Z",
      daemonId: null,
    };

    const plan = planLocalStatusDriftRepair({
      issue,
      opState,
      nowMs: Date.parse("2026-02-15T18:10:00.000Z"),
      ttlMs: 60_000,
    });

    expect(plan.decision).toBe("skip");
    expect(plan.reason).toBe("unsafe-active-ownership");
  });
});

describe("local status drift reconciliation", () => {
  let homeDir = "";
  let priorHome: string | undefined;
  let priorStateDb: string | undefined;
  let releaseLock: (() => void) | null = null;

  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();

    homeDir = await mkdtemp(join(tmpdir(), "ralph-local-drift-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();
  });

  afterEach(async () => {
    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();

    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;

    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;

    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("repairs stale local escalated to queued from single GitHub queued status", async () => {
    const stateMod = await import("../state");
    const now = "2026-02-15T18:10:00.000Z";

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      state: "OPEN",
      at: now,
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      labels: ["ralph:status:queued"],
      at: now,
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      taskPath: "github:3mdistal/ralph#761",
      status: "escalated",
      daemonId: "daemon-a",
      heartbeatAt: "2026-02-15T18:00:00.000Z",
      at: now,
    });

    const result = reconcileLocalStatusDriftForRepo({
      repo: "3mdistal/ralph",
      nowMs: Date.parse(now),
      ttlMs: 60_000,
    });

    expect(result).toEqual({ repaired: 1, unsafeSkipped: 0, raceSkipped: 0, observedDrift: 1 });

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#761");
    expect(opState?.status).toBe("queued");
    expect(opState?.daemonId).toBeNull();
    expect(opState?.heartbeatAt).toBeNull();
  });

  test("does not repair when local ownership heartbeat is fresh", async () => {
    const stateMod = await import("../state");
    const now = "2026-02-15T18:10:00.000Z";

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      state: "OPEN",
      at: now,
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      labels: ["ralph:status:queued"],
      at: now,
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      taskPath: "github:3mdistal/ralph#761",
      status: "escalated",
      heartbeatAt: "2026-02-15T18:09:30.000Z",
      at: now,
    });

    const result = reconcileLocalStatusDriftForRepo({
      repo: "3mdistal/ralph",
      nowMs: Date.parse(now),
      ttlMs: 60_000,
    });

    expect(result).toEqual({ repaired: 0, unsafeSkipped: 1, raceSkipped: 0, observedDrift: 1 });
    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#761");
    expect(opState?.status).toBe("escalated");
  });

  test("repairs local drift even when GitHub label writes are backoff-blocked", async () => {
    const stateMod = await import("../state");
    const now = "2026-02-15T18:10:00.000Z";
    const nowMs = Date.parse(now);

    stateMod.setRepoLabelWriteState({
      repo: "3mdistal/ralph",
      blockedUntilMs: nowMs + 300_000,
      lastError: "secondary rate limit",
      at: now,
    });

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      state: "OPEN",
      at: now,
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      labels: ["ralph:status:queued"],
      at: now,
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      taskPath: "github:3mdistal/ralph#761",
      status: "escalated",
      daemonId: "daemon-a",
      heartbeatAt: "2026-02-15T18:00:00.000Z",
      at: now,
    });

    const result = reconcileLocalStatusDriftForRepo({
      repo: "3mdistal/ralph",
      nowMs,
      ttlMs: 60_000,
    });

    expect(result.repaired).toBe(1);
    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#761");
    expect(opState?.status).toBe("queued");
  });

  test("guarded status update reports race-skip and does not mutate state", async () => {
    const stateMod = await import("../state");
    const now = "2026-02-15T18:10:00.000Z";

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      state: "OPEN",
      at: now,
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      labels: ["ralph:status:queued"],
      at: now,
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#761",
      taskPath: "github:3mdistal/ralph#761",
      status: "escalated",
      daemonId: "daemon-a",
      heartbeatAt: "2026-02-15T18:00:00.000Z",
      at: now,
    });

    const race = stateMod.updateTaskStatusIfOwnershipUnchanged({
      repo: "3mdistal/ralph",
      taskPath: "github:3mdistal/ralph#761",
      status: "queued",
      expectedDaemonId: "daemon-b",
      expectedHeartbeatAt: "2026-02-15T18:00:00.000Z",
      releasedReason: "test-race",
    });

    expect(race).toEqual({ updated: false, raceSkipped: true });
    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#761");
    expect(opState?.status).toBe("escalated");
    expect(opState?.daemonId).toBe("daemon-a");
  });
});
