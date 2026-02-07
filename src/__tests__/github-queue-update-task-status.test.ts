import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import type { QueueTask } from "../queue/types";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

const buildTask = (repo: string, number: number): QueueTask => {
  const issue = `${repo}#${number}`;
  return {
    _path: `github:${issue}`,
    _name: `Issue ${number}`,
    type: "agent-task",
    "creation-date": new Date().toISOString(),
    scope: "builder",
    issue,
    repo,
    status: "queued",
    name: `Issue ${number}`,
  };
};

describe("GitHub queue updateTaskStatus", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    stateMod.initStateDb();
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

  test("rehydrates issue snapshot when missing", async () => {
    const now = new Date("2026-02-03T00:00:00.000Z");
    const calls: Array<{ repo: string; issueNumber: number; add: string[]; remove: string[] }> = [];
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => [],
        fetchIssue: async () => ({
          title: "Recovered",
          state: "OPEN",
          url: "https://github.com/3mdistal/ralph/issues/101",
          githubNodeId: "node-101",
          githubUpdatedAt: now.toISOString(),
          labels: [],
        }),
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

    const task = buildTask("3mdistal/ralph", 101);
    const updated = await driver.updateTaskStatus(task, "queued");
    expect(updated).toBe(true);

    const snapshot = stateMod.getIssueSnapshotByNumber("3mdistal/ralph", 101);
    expect(snapshot?.title).toBe("Recovered");
    expect(stateMod.getIssueLabels("3mdistal/ralph", 101)).toEqual(["ralph:status:queued"]);
    expect(calls).toEqual([
      { repo: "3mdistal/ralph", issueNumber: 101, add: ["ralph:status:queued"], remove: [] },
    ]);
  });

  test("clears task fields when explicit empty strings are provided", async () => {
    const now = new Date("2026-02-03T01:00:00.000Z");
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");
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

    const task = buildTask("3mdistal/ralph", 202);
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#202",
      taskPath: task._path,
      status: "in-progress",
      sessionId: "sess-1",
      worktreePath: "/tmp/worktree",
      workerId: "worker-1",
      repoSlot: "1",
      daemonId: "daemon-1",
      heartbeatAt: now.toISOString(),
      at: now.toISOString(),
    });

    const updated = await driver.updateTaskStatus(task, "queued", {
      "session-id": "",
      "worktree-path": "",
      "worker-id": "",
      "repo-slot": "",
      "daemon-id": "",
      "heartbeat-at": "",
    });
    expect(updated).toBe(true);

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", task._path);
    expect(opState?.sessionId).toBe("");
    expect(opState?.worktreePath).toBe("");
    expect(opState?.workerId).toBe("");
    expect(opState?.repoSlot).toBe("");
    expect(opState?.daemonId).toBe("");
    expect(opState?.heartbeatAt).toBe("");
  });

  test("returns true and records task snapshot when fetchIssue fails", async () => {
    const now = new Date("2026-02-03T02:00:00.000Z");
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");
    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => [],
        fetchIssue: async () => {
          throw new Error("network down");
        },
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
        mutateIssueLabels: async () => true,
      },
    });

    const task = buildTask("3mdistal/ralph", 303);
    const updated = await driver.updateTaskStatus(task, "queued");
    expect(updated).toBe(true);

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", task._path);
    expect(opState?.status).toBe("queued");
  });

  test("operator queue override transitions waiting-on-pr back to queued", async () => {
    const now = new Date("2026-02-03T03:00:00.000Z");
    const calls: Array<{ repo: string; issueNumber: number; add: string[]; remove: string[] }> = [];
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");
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
        mutateIssueLabels: async ({ repo, issueNumber, add, remove }) => {
          calls.push({ repo, issueNumber, add, remove });
          return true;
        },
      },
    });

    const task = buildTask("3mdistal/ralph", 404);
    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#404",
      title: "Waiting",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/404",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#404",
      labels: ["ralph:status:in-progress"],
      at: now.toISOString(),
    });
    stateMod.recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#404",
      taskPath: task._path,
      status: "waiting-on-pr",
      at: now.toISOString(),
    });

    const updated = await driver.updateTaskStatus(task, "queued");
    expect(updated).toBe(true);

    const opState = stateMod.getTaskOpStateByPath("3mdistal/ralph", task._path);
    expect(opState?.status).toBe("queued");
    expect(calls).toEqual([
      { repo: "3mdistal/ralph", issueNumber: 404, add: ["ralph:status:queued"], remove: ["ralph:status:in-progress"] },
    ]);
  });

  test("does not write duplicate labels when desired status is unchanged", async () => {
    const now = new Date("2026-02-03T04:00:00.000Z");
    const calls: Array<{ repo: string; issueNumber: number; add: string[]; remove: string[] }> = [];
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");
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
        mutateIssueLabels: async ({ repo, issueNumber, add, remove }) => {
          calls.push({ repo, issueNumber, add, remove });
          return true;
        },
      },
    });

    const task = buildTask("3mdistal/ralph", 505);
    stateMod.recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#505",
      title: "Already queued",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/505",
      githubUpdatedAt: now.toISOString(),
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#505",
      labels: ["ralph:status:queued"],
      at: now.toISOString(),
    });

    const updated = await driver.updateTaskStatus(task, "queued");
    expect(updated).toBe(true);
    expect(calls).toEqual([]);
  });
});
