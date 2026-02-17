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
    priorWindow = process.env.RALPH_GITHUB_BLOCKED_COMMENT_COALESCE_MS;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-blocked-comment-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    process.env.RALPH_GITHUB_BLOCKED_COMMENT_COALESCE_MS = "0";
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
    if (priorWindow === undefined) delete process.env.RALPH_GITHUB_BLOCKED_COMMENT_COALESCE_MS;
    else process.env.RALPH_GITHUB_BLOCKED_COMMENT_COALESCE_MS = priorWindow;
    await rm(homeDir, { recursive: true, force: true });
  });

  function markerFor(repo: string, issueNumber: number): string {
    const fnv = (input: string): string => {
      let hash = 2166136261;
      for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    };
    const base = `${repo}|${issueNumber}|blocked`;
    const id = `${fnv(base)}${fnv(base.split("").reverse().join(""))}`.slice(0, 12);
    return `<!-- ralph-blocked:v1 id=${id} -->`;
  }

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
    process.env.RALPH_GITHUB_BLOCKED_COMMENT_COALESCE_MS = "20";
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
      upsertBlockedComment({ github, repo: "3mdistal/ralph", issueNumber: 762, state, writeClass: "best-effort" }),
      upsertBlockedComment({ github, repo: "3mdistal/ralph", issueNumber: 762, state, writeClass: "best-effort" }),
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

  test("skips patch when semantic blocked state is unchanged", async () => {
    const marker = markerFor("3mdistal/ralph", 762);
    const existingBody = buildBlockedCommentBody({
      marker,
      issueNumber: 762,
      state: {
        version: 1,
        kind: "deps",
        blocked: true,
        reason: "blocked by #11",
        deps: [{ repo: "3mdistal/ralph", issueNumber: 11 }],
        blockedAt: "2026-02-15T00:00:00.000Z",
        updatedAt: "2026-02-15T00:00:01.000Z",
      },
    });
    let patchCalls = 0;

    const github = {
      request: async (path: string, opts?: { method?: string }) => {
        if (String(path).includes("/comments?")) {
          return {
            data: [
              {
                id: 99,
                body: existingBody,
                html_url: "https://github.com/3mdistal/ralph/issues/762#issuecomment-99",
              },
            ],
          };
        }
        if (opts?.method === "PATCH") {
          patchCalls += 1;
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/762#issuecomment-99" } };
        }
        throw new Error(`unexpected call: ${opts?.method ?? "GET"} ${path}`);
      },
    } as any;

    const result = await upsertBlockedComment({
      github,
      repo: "3mdistal/ralph",
      issueNumber: 762,
      state: {
        version: 1,
        kind: "deps",
        blocked: true,
        reason: "blocked by #11",
        deps: [{ repo: "3mdistal/ralph", issueNumber: 11 }],
        blockedAt: "2026-02-15T00:00:00.000Z",
        updatedAt: "2026-02-15T01:00:00.000Z",
      },
    });

    expect(result.updated).toBe(false);
    expect(patchCalls).toBe(0);
  });
});
