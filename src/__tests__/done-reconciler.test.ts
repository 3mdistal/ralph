import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import { initStateDb, closeStateDbForTests, recordRepoGithubDoneReconcileCursor, getRepoGithubDoneReconcileCursor } from "../state";
import { RALPH_WORKFLOW_LABELS } from "../github-labels";
import { reconcileRepoDoneState } from "../github/done-reconciler";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

describe("done reconciler", () => {
  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-done-"));
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

  test("marks ralph-owned closing issues done", async () => {
    recordRepoGithubDoneReconcileCursor({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastMergedAt: "2026-01-11T00:00:00.000Z",
      lastPrNumber: 1,
      updatedAt: "2026-01-11T00:00:00.000Z",
    });

    const requests: Array<{ path: string; method: string; body?: any }> = [];

    const request = async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path === "/graphql") {
        return {
          data: {
            data: {
              search: {
                nodes: [
                  {
                    __typename: "PullRequest",
                    number: 100,
                    url: "https://github.com/3mdistal/ralph/pull/100",
                    mergedAt: "2026-01-12T00:00:00.000Z",
                    closingIssuesReferences: {
                      nodes: [
                        {
                          number: 317,
                          url: "https://github.com/3mdistal/ralph/issues/317",
                          state: "OPEN",
                          labels: { nodes: [{ name: "ralph:status:in-bot" }, { name: "dx" }] },
                        },
                        {
                          number: 999,
                          url: "https://github.com/3mdistal/ralph/issues/999",
                          state: "OPEN",
                          labels: { nodes: [{ name: "bug" }] },
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

      if (path === "/repos/3mdistal/ralph") {
        return { data: { default_branch: "main" }, etag: null, status: 200 };
      }

      if (path.includes("/issues/999/labels")) {
        throw new Error("Unexpected label mutation for non-Ralph issue");
      }

      return { data: null, etag: null, status: 200 };
    };

    const github = {
      request,
      listLabelSpecs: mock(async () => RALPH_WORKFLOW_LABELS),
      createLabel: mock(async () => {}),
      updateLabel: mock(async () => {}),
    } as any;

    const result = await reconcileRepoDoneState({
      repo: { name: "3mdistal/ralph", path: "/tmp/ralph", botBranch: "bot/integration" },
      github,
      now: () => new Date("2026-01-12T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.updatedIssues).toBe(1);

    const cursor = getRepoGithubDoneReconcileCursor("3mdistal/ralph");
    expect(cursor).toEqual({ lastMergedAt: "2026-01-12T00:00:00.000Z", lastPrNumber: 100 });

    const postCalls = requests.filter((call) => call.method === "POST" && /\/issues\/317\/labels$/.test(call.path));
    expect(postCalls.length).toBe(1);
    expect(postCalls[0]?.body).toEqual({ labels: ["ralph:status:done"] });
  });
});
