import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

describe("GitHub queue tryClaimTask pause switch", () => {
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

  test("refuses to claim non-queued tasks when paused label is present", async () => {
    const now = new Date("2026-02-04T00:00:00.000Z");
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");

    const repo = "3mdistal/ralph";
    const issueNumber = 311;
    stateMod.recordIssueSnapshot({
      repo,
      issue: `${repo}#${issueNumber}`,
      title: "Pause switch",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/311",
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo,
      issue: `${repo}#${issueNumber}`,
      labels: ["ralph:status:in-progress", "ralph:status:paused"],
      at: now.toISOString(),
    });

    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:status:paused"],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: false }),
        mutateIssueLabels: async () => true,
      },
    });

    const res = await driver.tryClaimTask({
      task: {
        _path: `github:${repo}#${issueNumber}`,
        _name: `Issue ${issueNumber}`,
        type: "agent-task",
        "creation-date": now.toISOString(),
        scope: "builder",
        issue: `${repo}#${issueNumber}`,
        repo,
        status: "in-progress",
        name: "Pause switch",
      },
      daemonId: "daemon-1",
      nowMs: now.valueOf(),
    });

    expect(res.claimed).toBe(false);
    expect(res.reason).toBe("Issue is paused");
  });

  test("refuses to claim when paused appears in live labels", async () => {
    const now = new Date("2026-02-04T00:00:00.000Z");
    const queueMod = await import("../github-queue/io");
    const stateMod = await import("../state");

    const repo = "3mdistal/ralph";
    const issueNumber = 312;
    stateMod.recordIssueSnapshot({
      repo,
      issue: `${repo}#${issueNumber}`,
      title: "Pause switch live",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/312",
      at: now.toISOString(),
    });
    stateMod.recordIssueLabelsSnapshot({
      repo,
      issue: `${repo}#${issueNumber}`,
      labels: ["ralph:status:in-progress"],
      at: now.toISOString(),
    });

    const driver = queueMod.createGitHubQueueDriver({
      now: () => now,
      io: {
        ensureWorkflowLabels: async () => ({ ok: true, created: [], updated: [] }),
        listIssueLabels: async () => ["ralph:status:paused"],
        fetchIssue: async () => null,
        reopenIssue: async () => {},
        addIssueLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabel: async () => ({ removed: false }),
        mutateIssueLabels: async () => true,
      },
    });

    const res = await driver.tryClaimTask({
      task: {
        _path: `github:${repo}#${issueNumber}`,
        _name: `Issue ${issueNumber}`,
        type: "agent-task",
        "creation-date": now.toISOString(),
        scope: "builder",
        issue: `${repo}#${issueNumber}`,
        repo,
        status: "in-progress",
        name: "Pause switch live",
      },
      daemonId: "daemon-1",
      nowMs: now.valueOf(),
    });

    expect(res.claimed).toBe(false);
    expect(res.reason).toBe("Issue is paused");
  });
});
