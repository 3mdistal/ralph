import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import { getRalphConfigJsonPath } from "../paths";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let priorDisableSweeps: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("status read-only (GitHub queue sweeps)", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    priorDisableSweeps = process.env.RALPH_GITHUB_QUEUE_DISABLE_SWEEPS;

    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
  });

  afterEach(async () => {
    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();

    process.env.HOME = priorHome;
    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;

    if (priorDisableSweeps === undefined) delete process.env.RALPH_GITHUB_QUEUE_DISABLE_SWEEPS;
    else process.env.RALPH_GITHUB_QUEUE_DISABLE_SWEEPS = priorDisableSweeps;

    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("driver listTasksByStatus is side-effect free when sweeps are disabled", async () => {
    const now = new Date("2026-02-04T14:00:00.000Z");
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      repos: [
        {
          name: "3mdistal/ralph",
          path: "/tmp/ralph",
          botBranch: "bot/integration",
        },
      ],
      ownershipTtlMs: 60_000,
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
      title: "Stale in-progress",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/1",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
      labels: ["ralph:status:in-progress"],
      at: now.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
      taskPath: "github:3mdistal/ralph#1",
      status: "in-progress",
      sessionId: "",
      worktreePath: "/tmp/worktree",
      workerId: "worker-1",
      repoSlot: "0",
      daemonId: "daemon-1",
      heartbeatAt: new Date(now.valueOf() - 120_000).toISOString(),
      at: now.toISOString(),
    });

    const calls: Array<{ repo: string; issueNumber: number; add: string[]; remove: string[] }> = [];
    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:status:in-progress"],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async ({ repo, issueNumber, add, remove }) => {
          calls.push({ repo, issueNumber, add, remove });
          return true;
        },
      },
    });

    process.env.RALPH_GITHUB_QUEUE_DISABLE_SWEEPS = "1";
    await driver.getTasksByStatus("blocked");

    expect(calls).toEqual([]);
    expect(stateMod.getIssueLabels("3mdistal/ralph", 1)).toEqual(["ralph:status:in-progress"]);

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#1");
    expect(opState?.releasedAtMs ?? null).toBe(null);
  });
});
