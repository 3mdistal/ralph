import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
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

describe("GitHub queue blocked label reconciliation", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
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
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("adds ralph:blocked for queued issues with open dependencies when autoQueue enabled", async () => {
    const now = new Date("2026-01-11T00:00:00.000Z");
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      repos: [
        {
          name: "3mdistal/ralph",
          path: "/tmp/ralph",
          autoQueue: { enabled: true, scope: "labeled-only", maxPerTick: 50, dryRun: false },
        },
      ],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
      title: "Leaf",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/1",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
      labels: ["ralph:queued"],
      at: now.toISOString(),
    });

    const calls: Array<{ repo: string; issueNumber: number; add: string[]; remove: string[] }> = [];
    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      relationshipsProviderFactory: () => ({
        getSnapshot: async (issue) => ({
          issue,
          signals: [
            {
              source: "github",
              kind: "blocked_by",
              state: "open",
              ref: { repo: "3mdistal/ralph", number: 999 },
            },
          ],
          coverage: { githubDepsComplete: true, githubSubIssuesComplete: true, bodyDeps: false },
        }),
      }),
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:queued"],
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

    const queued = await driver.getQueuedTasks();
    expect(queued.map((t) => t.issue)).toEqual(["3mdistal/ralph#1"]);
    expect(calls).toEqual([{ repo: "3mdistal/ralph", issueNumber: 1, add: ["ralph:blocked"], remove: [] }]);
  });

  test("removes ralph:blocked for queued issues once dependencies are clear when autoQueue enabled", async () => {
    const now = new Date("2026-01-11T00:00:00.000Z");
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      repos: [
        {
          name: "3mdistal/ralph",
          path: "/tmp/ralph",
          autoQueue: { enabled: true, scope: "labeled-only", maxPerTick: 50, dryRun: false },
        },
      ],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#2",
      title: "Unblocked",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/2",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#2",
      labels: ["ralph:queued", "ralph:blocked"],
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
        listIssueLabels: async () => ["ralph:queued", "ralph:blocked"],
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

    const queued = await driver.getQueuedTasks();
    expect(queued.map((t) => t.issue)).toEqual(["3mdistal/ralph#2"]);
    expect(calls).toEqual([{ repo: "3mdistal/ralph", issueNumber: 2, add: [], remove: ["ralph:blocked"] }]);
  });

  test("does not add ralph:blocked when dependency coverage is unknown", async () => {
    const now = new Date("2026-01-11T00:00:00.000Z");
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      repos: [
        {
          name: "3mdistal/ralph",
          path: "/tmp/ralph",
          autoQueue: { enabled: true, scope: "labeled-only", maxPerTick: 50, dryRun: false },
        },
      ],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();

    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#3",
      title: "Unknown deps",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/3",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#3",
      labels: ["ralph:queued"],
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
          coverage: { githubDepsComplete: false, githubSubIssuesComplete: false, bodyDeps: false },
        }),
      }),
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:queued"],
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

    const queued = await driver.getQueuedTasks();
    expect(queued.map((t) => t.issue)).toEqual(["3mdistal/ralph#3"]);
    expect(calls).toEqual([]);
  });
});
