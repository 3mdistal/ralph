import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import { getRalphConfigJsonPath } from "../paths";
import { PR_STATE_MERGED, PR_STATE_OPEN } from "../state";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("GitHub queue no-flap stale sweep", () => {
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

  test("keeps in-progress stable for waiting-on-pr with fresh open PR snapshot", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      ownershipTtlMs: 30_000,
      repos: [{ name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    const baseNow = new Date("2026-02-03T05:00:00.000Z");
    const staleHeartbeat = new Date(baseNow.getTime() - 10 * 60_000).toISOString();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#599",
      title: "Flap",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/599",
      githubUpdatedAt: baseNow.toISOString(),
      at: baseNow.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#599",
      labels: ["ralph:status:in-progress"],
      at: baseNow.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#599",
      taskPath: "github:3mdistal/ralph#599",
      status: "waiting-on-pr",
      sessionId: "",
      heartbeatAt: staleHeartbeat,
      at: baseNow.toISOString(),
    });
    stateMod.recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#599",
      prUrl: "https://github.com/3mdistal/ralph/pull/588",
      state: PR_STATE_OPEN,
      at: baseNow.toISOString(),
    });

    let now = new Date(baseNow);
    const mutations: Array<{ add: string[]; remove: string[] }> = [];

    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => new Date(now),
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:status:in-progress"],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async ({ add, remove }) => {
          mutations.push({ add, remove });
          return true;
        },
      },
    });

    const queuedFirst = await driver.getTasksByStatus("queued");
    expect(queuedFirst).toEqual([]);
    expect(mutations).toEqual([]);

    stateMod.recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#599",
      prUrl: "https://github.com/3mdistal/ralph/pull/588",
      state: PR_STATE_MERGED,
      at: new Date(baseNow.getTime() + 1000).toISOString(),
    });

    now = new Date(baseNow.getTime() + 10 * 60_000);
    const queuedSecond = await driver.getTasksByStatus("queued");
    expect(queuedSecond.map((task) => [task.issue, task.status])).toEqual([["3mdistal/ralph#599", "queued"]]);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual({ add: ["ralph:status:queued"], remove: ["ralph:status:in-progress"] });
  });

  test("keeps in-progress stable for blocked op-state without session id", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      ownershipTtlMs: 30_000,
      repos: [{ name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    const baseNow = new Date("2026-02-03T05:00:00.000Z");
    const staleHeartbeat = new Date(baseNow.getTime() - 30 * 60_000).toISOString();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#711",
      title: "Blocked Epic",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/711",
      githubUpdatedAt: baseNow.toISOString(),
      at: baseNow.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#711",
      labels: ["ralph:status:in-progress"],
      at: baseNow.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#711",
      taskPath: "github:3mdistal/ralph#711",
      status: "blocked",
      sessionId: "",
      heartbeatAt: staleHeartbeat,
      at: baseNow.toISOString(),
    });

    const mutations: Array<{ add: string[]; remove: string[] }> = [];

    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => new Date(baseNow),
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:status:in-progress"],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async ({ add, remove }) => {
          mutations.push({ add, remove });
          return true;
        },
      },
    });

    const queued = await driver.getTasksByStatus("queued");
    const blocked = await driver.getTasksByStatus("blocked");

    expect(queued).toEqual([]);
    expect(blocked.map((task) => [task.issue, task.status])).toEqual([["3mdistal/ralph#711", "blocked"]]);
    expect(mutations).toEqual([]);
  });

  test("does not downgrade in-progress when heartbeat is fresh", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      ownershipTtlMs: 30_000,
      repos: [{ name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    const baseNow = new Date("2026-02-03T05:00:00.000Z");
    const freshHeartbeat = new Date(baseNow.getTime() - 5_000).toISOString();
    const sessionId = "opencode-session-queue-no-flap-760";

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#760",
      title: "Flapping labels",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/760",
      githubUpdatedAt: baseNow.toISOString(),
      at: baseNow.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#760",
      labels: ["ralph:status:in-progress"],
      at: baseNow.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#760",
      taskPath: "github:3mdistal/ralph#760",
      status: "in-progress",
      sessionId,
      heartbeatAt: freshHeartbeat,
      at: baseNow.toISOString(),
    });

    const mutations: Array<{ add: string[]; remove: string[] }> = [];

    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => new Date(baseNow),
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:status:in-progress"],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async ({ add, remove }) => {
          mutations.push({ add, remove });
          return true;
        },
      },
    });

    const queued = await driver.getTasksByStatus("queued");

    expect(queued).toEqual([]);
    expect(mutations).toEqual([]);
  });
});
