import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import { getRalphConfigJsonPath } from "../paths";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("GitHub queue orphan op-state GC", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
  });

  afterEach(async () => {
    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    process.env.HOME = priorHome;
    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("clears stale no-label orphan op-state and prunes candidates", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      ownershipTtlMs: 60_000,
      repos: [{ name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    const now = new Date("2026-02-11T12:00:00.000Z");
    const heartbeat = new Date(now.getTime() - 120_000).toISOString();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#210",
      state: "OPEN",
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#210",
      labels: [],
      at: now.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#210",
      taskPath: "github:3mdistal/ralph#210",
      status: "blocked",
      sessionId: "sess-210",
      worktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/slot-1/210/task-a",
      workerId: "worker-1",
      repoSlot: "1",
      daemonId: "daemon-1",
      heartbeatAt: heartbeat,
      at: now.toISOString(),
    });

    const prunes: string[] = [];
    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      pruneWorktree: async ({ worktreePath }: { worktreePath: string }) => {
        prunes.push(worktreePath);
        return {
          attempted: true,
          pruned: true,
          gitRemoved: true,
          safety: { safe: true, reason: "ok", normalizedPath: worktreePath },
        };
      },
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => [],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async () => true,
      },
    });

    await driver.getTasksByStatus("queued");

    expect(prunes.length).toBeGreaterThan(0);
    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#210");
    expect(opState?.sessionId ?? null).toBeNull();
    expect(opState?.worktreePath ?? null).toBeNull();
    expect(opState?.daemonId ?? null).toBeNull();
    expect(opState?.heartbeatAt ?? null).toBeNull();
    expect(opState?.releasedReason ?? null).toBe("orphan:no-ralph-labels");
  });

  test("keeps fresh no-label orphan op-state", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      ownershipTtlMs: 60_000,
      repos: [{ name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    const now = new Date("2026-02-11T12:00:00.000Z");

    stateMod.recordIssueSnapshot({ repo: "3mdistal/ralph", issue: "3mdistal/ralph#211", state: "OPEN", at: now.toISOString() });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#211",
      labels: [],
      at: now.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#211",
      taskPath: "github:3mdistal/ralph#211",
      status: "in-progress",
      sessionId: "sess-211",
      worktreePath: "/home/test/.ralph/worktrees/3mdistal-ralph/slot-0/211/task-a",
      daemonId: "daemon-1",
      heartbeatAt: now.toISOString(),
      at: now.toISOString(),
    });

    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => [],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async () => true,
      },
    });

    await driver.getTasksByStatus("queued");

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#211");
    expect(opState?.sessionId ?? null).toBe("sess-211");
    expect(opState?.worktreePath ?? null).toContain("/211/");
  });
});
