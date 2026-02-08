import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { __processOneCommandForTests } from "../github/cmd-processor";
import { GitHubClient } from "../github/client";
import {
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_STATUS_ESCALATED,
  RALPH_LABEL_STATUS_PAUSED,
} from "../github-labels";
import { closeStateDbForTests, getIdempotencyPayload, initStateDb, upsertIdempotencyKey } from "../state";
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

  test("queue command removes paused even when snapshot labels are stale", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    originalRequest = GitHubClient.prototype.request;
    const requestStub: GitHubClient["request"] = async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path.includes("/issues/43/events")) {
        return {
          data: [
            {
              id: 777,
              event: "labeled",
              label: { name: RALPH_LABEL_CMD_QUEUE },
            },
          ],
          status: 200,
          etag: null,
        } as any;
      }

      if (path.includes("/issues/43/comments") && method === "GET") {
        return { data: [], status: 200, etag: null } as any;
      }

      if (path.includes("/issues/43/comments") && method === "POST") {
        return { data: { id: 1002 }, status: 201, etag: null } as any;
      }

      if (path.includes("/labels?")) {
        return { data: [], status: 200, etag: null } as any;
      }

      return { data: {}, status: 200, etag: null } as any;
    };
    GitHubClient.prototype.request = requestStub;

    const result = await __processOneCommandForTests({
      repo: "3mdistal/ralph",
      issueNumber: 43,
      cmdLabel: RALPH_LABEL_CMD_QUEUE as any,
      // Stale snapshot: queue command present, but paused status missing locally.
      currentLabels: [RALPH_LABEL_CMD_QUEUE],
      issueState: "OPEN",
    });

    expect(result.processed).toBe(true);
    expect(result.removedCmdLabel).toBe(true);

    const pausedDeletes = requests.filter(
      (req) => req.method === "DELETE" && req.path.endsWith(`/issues/43/labels/${encodeURIComponent(RALPH_LABEL_STATUS_PAUSED)}`)
    );
    expect(pausedDeletes.length).toBeGreaterThan(0);
  });

  test("queue command pagination uses latest event id", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    originalRequest = GitHubClient.prototype.request;
    const requestStub: GitHubClient["request"] = async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path.includes("/issues/44/events")) {
        const match = path.match(/[?&]page=(\d+)/);
        const page = Number(match?.[1] ?? "1");
        if (page === 1) {
          return {
            data: [{ id: 555, event: "labeled", label: { name: RALPH_LABEL_CMD_QUEUE } }],
            status: 200,
            etag: null,
          } as any;
        }
        if (page === 2) {
          return {
            data: [{ id: 999, event: "labeled", label: { name: RALPH_LABEL_CMD_QUEUE } }],
            status: 200,
            etag: null,
          } as any;
        }
        return { data: [], status: 200, etag: null } as any;
      }

      if (path.includes("/issues/44/comments") && method === "GET") {
        return { data: [], status: 200, etag: null } as any;
      }

      if (path.includes("/issues/44/comments") && method === "POST") {
        return { data: { id: 1003 }, status: 201, etag: null } as any;
      }

      if (path.includes("/labels?")) {
        return { data: [], status: 200, etag: null } as any;
      }

      return { data: {}, status: 200, etag: null } as any;
    };
    GitHubClient.prototype.request = requestStub;

    upsertIdempotencyKey({
      key: "ralph:cmd:v1:3mdistal/ralph#44:ralph:cmd:queue:555",
      scope: "cmd",
      payloadJson: JSON.stringify({
        version: 1,
        phase: "completed",
        repo: "3mdistal/ralph",
        issueNumber: 44,
        cmdLabel: RALPH_LABEL_CMD_QUEUE,
        eventId: "555",
        startedAt: "2026-02-07T00:00:00.000Z",
        completedAt: "2026-02-07T00:00:01.000Z",
        decision: "applied",
      }),
      createdAt: "2026-02-07T00:00:01.000Z",
    });

    const result = await __processOneCommandForTests({
      repo: "3mdistal/ralph",
      issueNumber: 44,
      cmdLabel: RALPH_LABEL_CMD_QUEUE as any,
      currentLabels: [RALPH_LABEL_CMD_QUEUE, RALPH_LABEL_STATUS_PAUSED, RALPH_LABEL_STATUS_ESCALATED],
      issueState: "OPEN",
    });

    expect(result.processed).toBe(true);
    expect(result.removedCmdLabel).toBe(true);

    const eventsPage2Calls = requests.filter((req) => req.path.includes("/issues/44/events") && req.path.includes("page=2"));
    expect(eventsPage2Calls.length).toBeGreaterThan(0);

    const newPayload = getIdempotencyPayload("ralph:cmd:v1:3mdistal/ralph#44:ralph:cmd:queue:999");
    expect(newPayload).toBeTruthy();
  });
});
