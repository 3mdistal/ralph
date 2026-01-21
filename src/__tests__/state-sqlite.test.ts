import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import {
  closeStateDbForTests,
  createNewRollupBatch,
  getOrCreateRollupBatch,
  initStateDb,
  listOpenRollupBatches,
  listRollupBatchEntries,
  markRollupBatchRolledUp,
  recordIdempotencyKey,
  hasIdempotencyKey,
  recordRepoSync,
  recordIssueSnapshot,
  recordTaskSnapshot,
  recordPrSnapshot,
  recordRollupMerge,
} from "../state";
import { getRalphStateDbPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

describe("State SQLite (~/.ralph/state.sqlite)", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    closeStateDbForTests();
  });

  afterEach(async () => {
    closeStateDbForTests();
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("initializes schema and supports metadata writes", () => {
    initStateDb();

    recordRepoSync({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastSyncAt: "2026-01-11T00:00:00.000Z",
    });

    recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      title: "Local state + config",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/59",
      at: "2026-01-11T00:00:00.500Z",
    });

    recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      taskPath: "orchestration/tasks/test.md",
      taskName: "Test Task",
      status: "queued",
      sessionId: "ses_123",
      worktreePath: "/tmp/worktree",
      workerId: "3mdistal/ralph#orchestration/tasks/test.md",
      repoSlot: "1",
      at: "2026-01-11T00:00:01.000Z",
    });

    recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#60",
      taskPath: "orchestration/tasks/test-no-slot.md",
      taskName: "Test Task No Slot",
      status: "queued",
      sessionId: "ses_124",
      worktreePath: "/tmp/worktree-2",
      workerId: "w_123",
      at: "2026-01-11T00:00:01.500Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      state: "merged",
      at: "2026-01-11T00:00:02.000Z",
    });

    expect(hasIdempotencyKey("k1")).toBe(false);
    expect(recordIdempotencyKey({ key: "k1", scope: "test" })).toBe(true);
    expect(recordIdempotencyKey({ key: "k1", scope: "test" })).toBe(false);
    expect(hasIdempotencyKey("k1")).toBe(true);

    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      const meta = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("3");

      const repoCount = db.query("SELECT COUNT(*) as n FROM repos").get() as { n: number };
      expect(repoCount.n).toBe(1);

      const issueRow = db.query("SELECT title, state, url FROM issues").get() as {
        title?: string;
        state?: string;
        url?: string;
      };
      expect(issueRow.title).toBe("Local state + config");
      expect(issueRow.state).toBe("OPEN");
      expect(issueRow.url).toBe("https://github.com/3mdistal/ralph/issues/59");

      const taskRows = db.query("SELECT worker_id, repo_slot FROM tasks ORDER BY task_path").all() as Array<{
        worker_id?: string;
        repo_slot?: string | null;
      }>;
      expect(taskRows).toEqual([
        { worker_id: "w_123", repo_slot: null },
        { worker_id: "3mdistal/ralph#orchestration/tasks/test.md", repo_slot: "1" },
      ]);

      const taskCount = db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number };
      expect(taskCount.n).toBe(2);

      const prCount = db.query("SELECT COUNT(*) as n FROM prs").get() as { n: number };
      expect(prCount.n).toBe(1);

      const sync = db.query("SELECT last_sync_at FROM repo_sync").get() as { last_sync_at?: string };
      expect(sync.last_sync_at).toBe("2026-01-11T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  test("records rollup batches and merges", () => {
    initStateDb();

    const batch = getOrCreateRollupBatch({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
    });

    expect(batch.status).toBe("open");
    expect(batch.batchSize).toBe(2);

    const first = recordRollupMerge({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      prUrl: "https://github.com/3mdistal/ralph/pull/101",
      issueRefs: ["3mdistal/ralph#101"],
      mergedAt: "2026-01-11T00:00:03.000Z",
    });

    expect(first.entries).toHaveLength(1);
    expect(first.entryInserted).toBe(true);

    const duplicate = recordRollupMerge({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      prUrl: "https://github.com/3mdistal/ralph/pull/101",
      mergedAt: "2026-01-11T00:00:03.500Z",
    });

    expect(duplicate.entries).toHaveLength(1);
    expect(duplicate.entryInserted).toBe(false);

    const second = recordRollupMerge({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      prUrl: "https://github.com/3mdistal/ralph/pull/102",
      mergedAt: "2026-01-11T00:00:04.000Z",
    });

    expect(second.entries).toHaveLength(2);

    const entries = listRollupBatchEntries(batch.id);
    expect(entries).toHaveLength(2);
    expect(entries[0].prUrl).toBe("https://github.com/3mdistal/ralph/pull/101");

    markRollupBatchRolledUp({
      batchId: batch.id,
      rollupPrUrl: "https://github.com/3mdistal/ralph/pull/999",
      rollupPrNumber: 999,
      at: "2026-01-11T00:00:05.000Z",
    });

    const newBatch = createNewRollupBatch({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      at: "2026-01-11T00:00:06.000Z",
    });

    expect(newBatch.id).not.toBe(batch.id);

    const openBatches = listOpenRollupBatches();
    expect(openBatches).toHaveLength(1);
    expect(openBatches[0].id).toBe(newBatch.id);
  });
});
