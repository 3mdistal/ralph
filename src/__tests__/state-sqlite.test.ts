import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import {
  closeStateDbForTests,
  initStateDb,
  recordIdempotencyKey,
  hasIdempotencyKey,
  recordRepoSync,
  recordIssueSnapshot,
  recordTaskSnapshot,
  recordPrSnapshot,
} from "../state";
import { getRalphStateDbPath } from "../paths";

let homeDir: string;
let priorHome: string | undefined;

describe("State SQLite (~/.ralph/state.sqlite)", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    closeStateDbForTests();
  });

  afterEach(async () => {
    closeStateDbForTests();
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
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

    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      const meta = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("1");

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

      const taskCount = db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number };
      expect(taskCount.n).toBe(1);

      const prCount = db.query("SELECT COUNT(*) as n FROM prs").get() as { n: number };
      expect(prCount.n).toBe(1);

      const sync = db.query("SELECT last_sync_at FROM repo_sync").get() as { last_sync_at?: string };
      expect(sync.last_sync_at).toBe("2026-01-11T00:00:00.000Z");
    } finally {
      db.close();
    }
  });
});
