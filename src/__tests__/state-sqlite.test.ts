import { describe, test, expect } from "bun:test";
import crypto from "crypto";
import { existsSync } from "fs";
import { mkdir, rename, rm } from "fs/promises";
import { dirname } from "path";
import { Database } from "bun:sqlite";

import {
  closeStateDbForTests,
  initStateDb,
  recordIdempotencyKey,
  hasIdempotencyKey,
  recordRepoSync,
  recordTaskSnapshot,
  recordPrSnapshot,
} from "../state";
import { getRalphStateDbPath } from "../paths";

async function backupFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const backupPath = `${path}.bak.${crypto.randomUUID()}`;
  await rename(path, backupPath);
  return backupPath;
}

async function restoreFile(path: string, backupPath: string | null): Promise<void> {
  if (backupPath) {
    if (existsSync(path)) {
      await rm(path, { force: true });
    }
    await rename(backupPath, path);
    return;
  }

  await rm(path, { force: true });
}

describe("State SQLite (~/.ralph/state.sqlite)", () => {
  test("initializes schema and supports metadata writes", async () => {
    const dbPath = getRalphStateDbPath();
    await mkdir(dirname(dbPath), { recursive: true });

    const dbBak = await backupFile(dbPath);

    try {
      closeStateDbForTests();
      await rm(dbPath, { force: true });

      initStateDb();

      recordRepoSync({
        repo: "3mdistal/ralph",
        repoPath: "/tmp/ralph",
        botBranch: "bot/integration",
        lastSyncAt: "2026-01-11T00:00:00.000Z",
      });

      recordTaskSnapshot({
        repo: "3mdistal/ralph",
        issue: "3mdistal/ralph#59",
        taskPath: "orchestration/tasks/test.md",
        taskName: "Test Task",
        status: "queued",
        sessionId: "ses_123",
        worktreePath: "/tmp/worktree",
        at: "2026-01-11T00:00:01.000Z",
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

      const db = new Database(dbPath);
      try {
        const meta = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
          value?: string;
        };
        expect(meta.value).toBe("1");

        const repoCount = db.query("SELECT COUNT(*) as n FROM repos").get() as { n: number };
        expect(repoCount.n).toBe(1);

        const taskCount = db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number };
        expect(taskCount.n).toBe(1);

        const prCount = db.query("SELECT COUNT(*) as n FROM prs").get() as { n: number };
        expect(prCount.n).toBe(1);

        const sync = db.query("SELECT last_sync_at FROM repo_sync").get() as { last_sync_at?: string };
        expect(sync.last_sync_at).toBe("2026-01-11T00:00:00.000Z");
      } finally {
        db.close();
      }
    } finally {
      closeStateDbForTests();
      await restoreFile(dbPath, dbBak);
    }
  });
});
