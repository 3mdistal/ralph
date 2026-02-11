import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import {
  closeStateDbForTests,
  getRepoGithubInBotReconcileCursor,
  getTaskOpStateByPath,
  initStateDb,
  listRepoGithubInBotPendingIssues,
  recordRepoGithubInBotReconcileCursor,
  recordTaskSnapshot,
  upsertRepoGithubInBotPendingIssue,
} from "../state";
import { RALPH_WORKFLOW_LABELS } from "../github-labels";
import { reconcileRepoInBotState } from "../github/in-bot-reconciler";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

describe("in-bot reconciler", () => {
  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-in-bot-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
    } finally {
      if (priorStateDbPath === undefined) {
        delete process.env.RALPH_STATE_DB_PATH;
      } else {
        process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      }
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("initializes in-bot cursor when missing", async () => {
    const github = {
      request: mock(async () => ({ data: null, etag: null, status: 200 })),
      listLabelSpecs: mock(async () => RALPH_WORKFLOW_LABELS),
      createLabel: mock(async () => {}),
      updateLabel: mock(async () => {}),
    } as any;

    const result = await reconcileRepoInBotState({
      repo: { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" },
      github,
      now: () => new Date("2026-02-11T14:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.initializedCursor).toBe(true);
    expect(getRepoGithubInBotReconcileCursor("3mdistal/ralph")).toEqual({
      botBranch: "bot/integration",
      lastMergedAt: "2026-02-11T14:00:00.000Z",
      lastPrNumber: 0,
    });
  });

  test("marks merged bot-branch issues in-bot and clears local task execution state", async () => {
    recordRepoGithubInBotReconcileCursor({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastMergedAt: "2026-02-11T13:00:00.000Z",
      lastPrNumber: 10,
      updatedAt: "2026-02-11T13:00:00.000Z",
    });

    recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#317",
      taskPath: "github:3mdistal/ralph#317",
      status: "in-progress",
      sessionId: "ses_abc",
      sessionEventsPath: "/tmp/ses_abc/events.jsonl",
      worktreePath: "/tmp/wt-317",
      workerId: "worker-317",
      repoSlot: "0",
      daemonId: "daemon-a",
      heartbeatAt: "2026-02-11T13:10:00.000Z",
      at: "2026-02-11T13:10:00.000Z",
    });

    const request = mock(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();

      if (path === "/graphql") {
        return {
          data: {
            data: {
              search: {
                nodes: [
                  {
                    __typename: "PullRequest",
                    number: 621,
                    url: "https://github.com/3mdistal/ralph/pull/621",
                    mergedAt: "2026-02-11T14:05:00.000Z",
                    closingIssuesReferences: {
                      nodes: [
                        {
                          number: 317,
                          url: "https://github.com/3mdistal/ralph/issues/317",
                          state: "OPEN",
                          labels: { nodes: [{ name: "ralph:status:in-progress" }, { name: "dx" }] },
                        },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
          etag: null,
          status: 200,
        };
      }

      if (path === "/repos/3mdistal/ralph/issues/317/labels" && method === "GET") {
        return { data: [{ name: "ralph:status:in-bot" }, { name: "dx" }], etag: null, status: 200 };
      }

      return { data: null, etag: null, status: 200 };
    });

    const github = {
      request,
      listLabelSpecs: mock(async () => RALPH_WORKFLOW_LABELS),
      createLabel: mock(async () => {}),
      updateLabel: mock(async () => {}),
    } as any;

    const result = await reconcileRepoInBotState({
      repo: { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" },
      github,
      now: () => new Date("2026-02-11T14:06:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.updatedIssues).toBe(1);
    expect(result.localClears).toBe(1);
    expect(getRepoGithubInBotReconcileCursor("3mdistal/ralph")).toEqual({
      botBranch: "bot/integration",
      lastMergedAt: "2026-02-11T14:05:00.000Z",
      lastPrNumber: 621,
    });

    const opState = getTaskOpStateByPath("3mdistal/ralph", "github:3mdistal/ralph#317");
    expect(opState?.status).toBe("done");
    expect(opState?.sessionId).toBe(null);
    expect(opState?.worktreePath).toBe(null);
    expect(opState?.workerId).toBe(null);
    expect(opState?.repoSlot).toBe(null);
    expect(opState?.daemonId).toBe(null);
    expect(opState?.heartbeatAt).toBe(null);
  });

  test("queues pending retries on label write failure and still advances cursor", async () => {
    recordRepoGithubInBotReconcileCursor({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastMergedAt: "2026-02-11T13:00:00.000Z",
      lastPrNumber: 10,
      updatedAt: "2026-02-11T13:00:00.000Z",
    });

    let phase: "fail" | "replay" = "fail";
    const request = mock(async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();

      if (path === "/graphql") {
        if (phase === "fail") {
          return {
            data: {
              data: {
                search: {
                  nodes: [
                    {
                      __typename: "PullRequest",
                      number: 622,
                      url: "https://github.com/3mdistal/ralph/pull/622",
                      mergedAt: "2026-02-11T14:08:00.000Z",
                      closingIssuesReferences: {
                        nodes: [
                          {
                            number: 673,
                            url: "https://github.com/3mdistal/ralph/issues/673",
                            state: "OPEN",
                            labels: { nodes: [{ name: "ralph:status:in-progress" }] },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
            etag: null,
            status: 200,
          };
        }

        return {
          data: {
            data: { search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          },
          etag: null,
          status: 200,
        };
      }

      if (path === "/repos/3mdistal/ralph/issues/673" && method === "GET") {
        return {
          data: { state: "open", labels: [{ name: "ralph:status:in-progress" }] },
          etag: null,
          status: 200,
        };
      }

      if (path === "/repos/3mdistal/ralph/issues/673/labels" && method === "POST" && phase === "fail") {
        throw new Error("simulated label write failure");
      }

      if (path === "/repos/3mdistal/ralph/issues/673/labels" && method === "GET") {
        return { data: [{ name: "ralph:status:in-bot" }], etag: null, status: 200 };
      }

      return { data: null, etag: null, status: 200 };
    });

    const github = {
      request,
      listLabelSpecs: mock(async () => RALPH_WORKFLOW_LABELS),
      createLabel: mock(async () => {}),
      updateLabel: mock(async () => {}),
    } as any;

    const first = await reconcileRepoInBotState({
      repo: { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" },
      github,
      now: () => new Date("2026-02-11T14:09:00.000Z"),
    });

    expect(first.ok).toBe(true);
    expect(first.pendingAdded).toBe(1);
    expect(first.updatedIssues).toBe(0);
    expect(getRepoGithubInBotReconcileCursor("3mdistal/ralph")).toEqual({
      botBranch: "bot/integration",
      lastMergedAt: "2026-02-11T14:08:00.000Z",
      lastPrNumber: 622,
    });
    expect(listRepoGithubInBotPendingIssues("3mdistal/ralph", 10).length).toBe(1);

    phase = "replay";
    const second = await reconcileRepoInBotState({
      repo: { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" },
      github,
      now: () => new Date("2026-02-11T14:10:00.000Z"),
    });

    expect(second.ok).toBe(true);
    expect(second.pendingResolved).toBe(1);
    expect(listRepoGithubInBotPendingIssues("3mdistal/ralph", 10).length).toBe(0);
  });

  test("resets cursor and clears pending rows when bot branch changes", async () => {
    recordRepoGithubInBotReconcileCursor({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastMergedAt: "2026-02-11T13:00:00.000Z",
      lastPrNumber: 15,
      updatedAt: "2026-02-11T13:00:00.000Z",
    });
    upsertRepoGithubInBotPendingIssue({
      repo: "3mdistal/ralph",
      issueNumber: 317,
      prNumber: 622,
      prUrl: "https://github.com/3mdistal/ralph/pull/622",
      mergedAt: "2026-02-11T14:08:00.000Z",
      attemptedAt: "2026-02-11T14:09:00.000Z",
      attemptError: "label-update:transient",
    });

    const github = {
      request: mock(async () => ({ data: null, etag: null, status: 200 })),
      listLabelSpecs: mock(async () => RALPH_WORKFLOW_LABELS),
      createLabel: mock(async () => {}),
      updateLabel: mock(async () => {}),
    } as any;

    const result = await reconcileRepoInBotState({
      repo: { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/next" },
      github,
      now: () => new Date("2026-02-11T15:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.resetCursor).toBe(true);
    expect(getRepoGithubInBotReconcileCursor("3mdistal/ralph")).toEqual({
      botBranch: "bot/next",
      lastMergedAt: "2026-02-11T15:00:00.000Z",
      lastPrNumber: 0,
    });
    expect(listRepoGithubInBotPendingIssues("3mdistal/ralph", 10).length).toBe(0);
  });
});
