import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { GitHubApiError } from "../github/client";
import {
  __resetBlockedCommentWriteStateForTests,
  buildBlockedCommentBody,
  extractDependencyRefs,
  parseBlockedCommentState,
  upsertBlockedComment,
} from "../github/blocked-comment";

describe("blocked comment", () => {
  let homeDir: string;
  let priorHome: string | undefined;
  let priorStateDb: string | undefined;
  let priorWindow: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    priorWindow = process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-blocked-comment-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS = "0";
    __resetBlockedCommentWriteStateForTests();
    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
  });

  afterEach(async () => {
    const stateMod = await import("../state");
    stateMod.closeStateDbForTests();
    __resetBlockedCommentWriteStateForTests();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;
    if (priorWindow === undefined) delete process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS;
    else process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS = priorWindow;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("builds and parses v1 state payload", () => {
    const body = buildBlockedCommentBody({
      marker: "<!-- ralph-blocked:v1 id=abc123 -->",
      issueNumber: 745,
      state: {
        version: 1,
        kind: "deps",
        blocked: true,
        reason: "blocked by 3mdistal/ralph#11",
        deps: [{ repo: "3mdistal/ralph", issueNumber: 11 }],
        blockedAt: "2026-02-14T21:08:07.311Z",
        updatedAt: "2026-02-14T21:08:08.000Z",
      },
    });

    const parsed = parseBlockedCommentState(body);
    expect(parsed).toBeTruthy();
    expect(parsed?.blocked).toBe(true);
    expect(parsed?.deps).toEqual([{ repo: "3mdistal/ralph", issueNumber: 11 }]);
  });

  test("returns null for malformed state payload", () => {
    const parsed = parseBlockedCommentState("<!-- ralph-blocked:state={not-json} -->");
    expect(parsed).toBeNull();
  });

  test("extracts dependency refs from reason text", () => {
    const refs = extractDependencyRefs("blocked by #11 and 3mdistal/ralph#42", "3mdistal/ralph");
    expect(refs).toEqual([
      { repo: "3mdistal/ralph", issueNumber: 11 },
      { repo: "3mdistal/ralph", issueNumber: 42 },
    ]);
  });

  test("coalesces concurrent upserts for identical blocked payload", async () => {
    let createCalls = 0;
    const github = {
      request: async (path: string, opts: { method?: string } = {}) => {
        if (path.includes("/comments?")) return { data: [] };
        if (path.includes("/comments") && opts.method === "POST") {
          createCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/762#issuecomment-1" } };
        }
        return { data: {} };
      },
    } as any;

    const state = {
      version: 1 as const,
      kind: "deps" as const,
      blocked: true,
      reason: "blocked by #11",
      deps: [{ repo: "3mdistal/ralph", issueNumber: 11 }],
      blockedAt: "2026-02-15T00:00:00.000Z",
      updatedAt: "2026-02-15T00:00:01.000Z",
    };

    await Promise.all([
      upsertBlockedComment({ github, repo: "3mdistal/ralph", issueNumber: 762, state }),
      upsertBlockedComment({ github, repo: "3mdistal/ralph", issueNumber: 762, state }),
    ]);

    expect(createCalls).toBe(1);
  });

  test("suppresses best-effort writes during per-issue cooldown after transient failure", async () => {
    let createCalls = 0;
    const github = {
      request: async (path: string, opts: { method?: string } = {}) => {
        if (path.includes("/comments?")) return { data: [] };
        if (path.includes("/comments") && opts.method === "POST") {
          createCalls += 1;
          throw new GitHubApiError({
            message: "Rate limit",
            code: "rate_limit",
            status: 429,
            requestId: "req-1",
            responseText: "secondary rate limit",
          });
        }
        return { data: {} };
      },
    } as any;

    const state = {
      version: 1 as const,
      kind: "deps" as const,
      blocked: true,
      reason: "blocked by #11",
      deps: [{ repo: "3mdistal/ralph", issueNumber: 11 }],
      blockedAt: "2026-02-15T00:00:00.000Z",
      updatedAt: "2026-02-15T00:00:01.000Z",
    };

    await expect(upsertBlockedComment({ github, repo: "3mdistal/ralph", issueNumber: 762, state })).rejects.toThrow();
    const suppressed = await upsertBlockedComment({ github, repo: "3mdistal/ralph", issueNumber: 762, state });

    expect(suppressed).toEqual({ updated: false, url: null });
    expect(createCalls).toBe(1);
  });
});
