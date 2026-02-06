import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { __processOneCommandForTests } from "../github/cmd-processor";
import { GitHubClient } from "../github/client";
import { RALPH_LABEL_CMD_QUEUE, RALPH_LABEL_STATUS_ESCALATED } from "../github-labels";
import { closeStateDbForTests, initStateDb } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("github cmd-processor", () => {
  let homeDir: string;
  let priorStateDb: string | undefined;
  let releaseLock: (() => void) | null = null;
  let originalRequest: GitHubClient["request"] | null = null;

  beforeEach(async () => {
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-cmd-processor-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
    } finally {
      if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorStateDb;
      releaseLock?.();
      releaseLock = null;
      if (originalRequest) GitHubClient.prototype.request = originalRequest;
      originalRequest = null;
    }
  });

  test("processes ralph:cmd:queue once and avoids duplicate comments", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    originalRequest = GitHubClient.prototype.request;
    const requestStub: GitHubClient["request"] = async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path.includes("/issues/42/events")) {
        return {
          data: [
            {
              id: 555,
              event: "labeled",
              label: { name: RALPH_LABEL_CMD_QUEUE },
            },
          ],
          status: 200,
          etag: null,
        } as any;
      }

      if (path.includes("/issues/42/comments") && method === "GET") {
        return { data: [], status: 200, etag: null } as any;
      }

      if (path.includes("/issues/42/comments") && method === "POST") {
        return { data: { id: 1001 }, status: 201, etag: null } as any;
      }

      if (path.includes("/issues/42/comments") && method === "PATCH") {
        return { data: {}, status: 200, etag: null } as any;
      }

      if (path.includes("/labels?")) {
        return { data: [], status: 200, etag: null } as any;
      }

      return { data: {}, status: 200, etag: null } as any;
    };
    GitHubClient.prototype.request = requestStub;

    const params: Parameters<typeof __processOneCommandForTests>[0] = {
      repo: "3mdistal/ralph",
      issueNumber: 42,
      cmdLabel: RALPH_LABEL_CMD_QUEUE as any,
      currentLabels: [RALPH_LABEL_CMD_QUEUE, RALPH_LABEL_STATUS_ESCALATED],
      issueState: "OPEN",
    };

    const first = await __processOneCommandForTests(params);
    expect(first.processed).toBe(true);
    expect(first.removedCmdLabel).toBe(true);

    const commentPostsAfterFirst = requests.filter(
      (req) => req.method === "POST" && req.path.endsWith("/issues/42/comments")
    );
    expect(commentPostsAfterFirst).toHaveLength(1);

    await __processOneCommandForTests(params);

    const commentPostsAfterSecond = requests.filter(
      (req) => req.method === "POST" && req.path.endsWith("/issues/42/comments")
    );
    expect(commentPostsAfterSecond).toHaveLength(1);
  });
});
