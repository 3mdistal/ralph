import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __testOnlyStartRepoPoller, type SyncResult } from "../github-issues-sync";

type SyncOnce = typeof import("../github/issues-sync-service").syncRepoIssuesOnce;
import { closeStateDbForTests, initStateDb } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

type RecordedTimer = {
  id: number;
  delay: number;
  fn: () => void | Promise<void>;
  cleared: boolean;
};

function createRecordingTimers() {
  let nextId = 1;
  const records: RecordedTimer[] = [];

  const timers = {
    setTimeout: <TArgs extends any[]>(fn: (...args: TArgs) => void, delay?: number, ...args: TArgs) => {
      const id = nextId++;
      records.push({
        id,
        delay: delay ?? 0,
        fn: () => fn(...args),
        cleared: false,
      });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => {
      const id = timeoutId as unknown as number;
      const record = records.find((item) => item.id === id);
      if (record) record.cleared = true;
    },
  };

  const run = async (index = 0) => {
    const record = records[index];
    if (!record || record.cleared) return;
    await record.fn();
  };

  return { timers, records, run };
}

describe("github issue poller", () => {
  let homeDir: string;
  let priorStateDbPath: string | undefined;
  let releaseLock: (() => void) | null = null;

  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
    } finally {
      if (priorStateDbPath === undefined) {
        delete process.env.RALPH_STATE_DB_PATH;
      } else {
        process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      }
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("schedules jittered delay and backs off deterministically", async () => {
    const { timers, records, run } = createRecordingTimers();
    const randomCalls: number[] = [];
    const random = () => {
      randomCalls.push(1);
      return 0.75;
    };

    const syncOnce: SyncOnce = async () => ({
      status: "ok",
      ok: true,
      fetched: 0,
      stored: 0,
      ralphCount: 0,
      newLastSyncAt: null,
      hadChanges: false,
      progressed: false,
    });

    const repo = { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" };

    const poller = __testOnlyStartRepoPoller({
      repo,
      baseIntervalMs: 10_000,
      log: () => {},
      deps: {
        timers,
        random,
        syncOnce,
        nowMs: () => 0,
        getLastSyncAt: () => null,
      },
    });

    expect(records.length).toBe(1);
    expect(records[0].delay).toBe(11_000);
    expect(randomCalls.length).toBe(1);

    await run(0);

    expect(records.length).toBe(2);
    expect(records[0].cleared).toBe(true);
    expect(records[1].delay).toBe(15_000);
    expect(randomCalls.length).toBe(1);

    poller.stop();
    expect(records[1].cleared).toBe(true);

    await run(1);
    expect(records.length).toBe(2);
  });

  test("stop aborts inflight sync and prevents reschedule", async () => {
    const { timers, records, run } = createRecordingTimers();
    let receivedSignal: AbortSignal | null = null;
    let resolveSync: ((value: SyncResult) => void) | null = null;

    const syncOnce: SyncOnce = async (params) => {
      receivedSignal = params.signal ?? null;
      return await new Promise<SyncResult>((resolve) => {
        resolveSync = resolve;
      });
    };

    const repo = { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" };

    const poller = __testOnlyStartRepoPoller({
      repo,
      baseIntervalMs: 10_000,
      log: () => {},
      deps: {
        timers,
        random: () => 0.5,
        syncOnce,
        nowMs: () => 0,
        getLastSyncAt: () => null,
      },
    });

    await run(0);
    expect(receivedSignal).not.toBeNull();

    poller.stop();
    expect(receivedSignal?.aborted).toBe(true);

    resolveSync?.({
      status: "aborted",
      ok: false,
      fetched: 0,
      stored: 0,
      ralphCount: 0,
      newLastSyncAt: null,
      hadChanges: false,
    });

    await Promise.resolve();
    expect(records.length).toBe(1);
  });
});
