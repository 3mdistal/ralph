import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { __processOneCommandForTests } from "../github/cmd-processor";
import { GitHubClient } from "../github/client";
import {
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_STATUS_ESCALATED,
  RALPH_LABEL_STATUS_QUEUED,
} from "../github-labels";
import { closeStateDbForTests, initStateDb } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("github cmd processor", () => {
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

  test("refuses stale queue command when escalation is newer", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    originalRequest = GitHubClient.prototype.request;
    const requestStub: GitHubClient["request"] = async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path.includes("/issues/42/events")) {
        return {
          data: [
            { id: 100, event: "labeled", label: { name: RALPH_LABEL_CMD_QUEUE } },
            { id: 200, event: "labeled", label: { name: RALPH_LABEL_STATUS_ESCALATED } },
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

      if (method === "DELETE") {
        return { data: null, status: 204, etag: null } as any;
      }

      return { data: {}, status: 200, etag: null } as any;
    };
    GitHubClient.prototype.request = requestStub;

    const result = await __processOneCommandForTests({
      repo: "3mdistal/ralph",
      issueNumber: 42,
      cmdLabel: RALPH_LABEL_CMD_QUEUE,
      currentLabels: [RALPH_LABEL_CMD_QUEUE, RALPH_LABEL_STATUS_ESCALATED],
      issueState: "OPEN",
    });

    expect(result.processed).toBe(true);
    expect(result.removedCmdLabel).toBe(true);

    const addRequests = requests.filter((req) => req.method === "POST" && req.path.endsWith("/issues/42/labels"));
    expect(addRequests).toHaveLength(0);

    const deleteRequests = requests.filter((req) => req.method === "DELETE" && req.path.includes("/issues/42/labels/"));
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0]?.path).toContain(encodeURIComponent(RALPH_LABEL_CMD_QUEUE));

    const commentPost = requests.find((req) => req.method === "POST" && req.path.endsWith("/issues/42/comments"));
    expect(commentPost?.body?.body).toContain("Refused: stale `ralph:cmd:queue` command did not clear escalation.");
  });

  test("applies queue command when it is newer than escalation", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    originalRequest = GitHubClient.prototype.request;
    const requestStub: GitHubClient["request"] = async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path.includes("/issues/43/events")) {
        return {
          data: [
            { id: 200, event: "labeled", label: { name: RALPH_LABEL_STATUS_ESCALATED } },
            { id: 300, event: "labeled", label: { name: RALPH_LABEL_CMD_QUEUE } },
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

      if (method === "DELETE") {
        return { data: null, status: 204, etag: null } as any;
      }

      return { data: {}, status: 200, etag: null } as any;
    };
    GitHubClient.prototype.request = requestStub;

    const result = await __processOneCommandForTests({
      repo: "3mdistal/ralph",
      issueNumber: 43,
      cmdLabel: RALPH_LABEL_CMD_QUEUE,
      currentLabels: [RALPH_LABEL_CMD_QUEUE, RALPH_LABEL_STATUS_ESCALATED],
      issueState: "OPEN",
    });

    expect(result.processed).toBe(true);
    expect(result.removedCmdLabel).toBe(true);

    const addRequests = requests.filter((req) => req.method === "POST" && req.path.endsWith("/issues/43/labels"));
    expect(addRequests).toHaveLength(1);
    expect(addRequests[0]?.body?.labels).toEqual([RALPH_LABEL_STATUS_QUEUED]);

    const deleteRequests = requests.filter((req) => req.method === "DELETE" && req.path.includes("/issues/43/labels/"));
    expect(deleteRequests.some((req) => req.path.includes(encodeURIComponent(RALPH_LABEL_STATUS_ESCALATED)))).toBe(true);
    expect(deleteRequests.some((req) => req.path.includes(encodeURIComponent(RALPH_LABEL_CMD_QUEUE)))).toBe(true);
  });

  test("allows queue command with unknown causality and logs warning", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    originalRequest = GitHubClient.prototype.request;
    const requestStub: GitHubClient["request"] = async (path: string, opts: { method?: string; body?: any } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: opts.body });

      if (path.includes("/issues/44/events")) {
        throw new Error("event fetch unavailable");
      }

      if (path.includes("/issues/44/comments") && method === "GET") {
        return { data: [], status: 200, etag: null } as any;
      }

      if (path.includes("/issues/44/comments") && method === "POST") {
        return { data: { id: 1003 }, status: 201, etag: null } as any;
      }

      if (method === "DELETE") {
        return { data: null, status: 204, etag: null } as any;
      }

      return { data: {}, status: 200, etag: null } as any;
    };
    GitHubClient.prototype.request = requestStub;

    try {
      const result = await __processOneCommandForTests({
        repo: "3mdistal/ralph",
        issueNumber: 44,
        cmdLabel: RALPH_LABEL_CMD_QUEUE,
        currentLabels: [RALPH_LABEL_CMD_QUEUE, RALPH_LABEL_STATUS_ESCALATED],
        issueState: "OPEN",
      });

      expect(result.processed).toBe(true);
      expect(result.removedCmdLabel).toBe(true);
      expect(warnings.some((line) => line.includes("queue-causality-unknown"))).toBe(true);

      const addRequests = requests.filter((req) => req.method === "POST" && req.path.endsWith("/issues/44/labels"));
      expect(addRequests).toHaveLength(1);
      expect(addRequests[0]?.body?.labels).toEqual([RALPH_LABEL_STATUS_QUEUED]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
