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

describe("GitHub queue listTasksByStatus", () => {
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

  test("includes GitHub-backed starting + throttled tasks", async () => {
    const now = new Date("2026-02-03T03:00:00.000Z");
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      repos: [{ name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
      title: "Starting",
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
      status: "starting",
      sessionId: "",
      heartbeatAt: now.toISOString(),
      at: now.toISOString(),
    });

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#2",
      title: "Throttled",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/2",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#2",
      labels: ["ralph:status:throttled"],
      at: now.toISOString(),
    });

    const calls: Array<{ repo: string; issueNumber: number; add: string[]; remove: string[] }> = [];
    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      relationshipsProviderFactory: () => ({
        getSnapshot: async (issue) => ({
          issue,
          signals: [],
          coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: false },
        }),
      }),
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => [],
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

    const starting = await driver.getTasksByStatus("starting");
    expect(starting.map((t) => [t.issue, t.status])).toEqual([["3mdistal/ralph#1", "starting"]]);

    const throttled = await driver.getTasksByStatus("throttled");
    expect(throttled.map((t) => [t.issue, t.status])).toEqual([["3mdistal/ralph#2", "throttled"]]);

    expect(calls).toEqual([]);
  });
});
