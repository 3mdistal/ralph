import { describe, expect, test } from "bun:test";

import {
  extractExistingWatchdogMarker,
  planWatchdogWriteback,
  writeWatchdogToGitHub,
} from "../github/watchdog-writeback";

describe("github watchdog writeback", () => {
  test("planWatchdogWriteback includes marker and redacts diagnostics", async () => {
    const plan = await planWatchdogWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      taskName: "Watchdog test",
      taskPath: "orchestration/tasks/ralph 342.md",
      sessionId: null,
      worktreePath: "/home/alice/worktrees/ralph",
      stage: "plan",
      kind: "stuck",
      watchdogTimeout: {
        toolName: "bash",
        callId: "call_123",
        elapsedMs: 120000,
        softMs: 60000,
        hardMs: 120000,
        lastProgressMsAgo: 119000,
        recentEvents: ["{\"type\":\"tool-start\",\"toolName\":\"bash\"} ghp_abcdefghijklmnopqrstuv"],
      },
      suggestedCommands: ["bun test"],
    });

    expect(plan.commentBody).toContain("ralph-watchdog");
    expect(plan.commentBody).toContain("Session:");
    expect(plan.commentBody).toContain("Worktree:");
    expect(plan.commentBody).toContain("Stage:");
    expect(plan.commentBody).toContain("Recent OpenCode events");
    expect(plan.commentBody).toContain("Suggested deterministic commands");
    expect(plan.commentBody).toContain("~/worktrees/ralph");
    expect(plan.commentBody).not.toContain("/home/alice");
    expect(plan.commentBody).not.toContain("ghp_abcdefghijklmnopqrstuv");
  });

  test("extractExistingWatchdogMarker parses marker id", () => {
    expect(extractExistingWatchdogMarker("<!-- ralph-watchdog:id=deadbeef -->")).toBe("deadbeef");
  });

  test("writeWatchdogToGitHub posts once and records idempotency", async () => {
    const keys = new Set<string>();
    const postedBodies: string[] = [];

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/342#issuecomment-1" } };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeWatchdogToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 342,
        taskName: "Watchdog test",
        taskPath: "orchestration/tasks/ralph 342.md",
        sessionId: "ses_test",
        worktreePath: "/home/alice/worktrees/ralph",
        stage: "build",
        kind: "stuck",
        watchdogTimeout: {
          toolName: "bash",
          callId: "call_123",
          elapsedMs: 120000,
          softMs: 60000,
          hardMs: 120000,
          lastProgressMsAgo: 119000,
        },
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
        },
      }
    );

    expect(result.postedComment).toBe(true);
    expect(keys.size).toBe(1);
    expect(postedBodies.length).toBe(1);
    expect(result.commentUrl).toContain("issuecomment-1");
  });

  test("writeWatchdogToGitHub skips when marker already present", async () => {
    const keys = new Set<string>();
    const postedBodies: string[] = [];

    const plan = await planWatchdogWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      taskName: "Watchdog test",
      taskPath: "orchestration/tasks/ralph 342.md",
      sessionId: "ses_test",
      worktreePath: "/home/alice/worktrees/ralph",
      stage: "build",
      kind: "stuck",
      watchdogTimeout: {
        toolName: "bash",
        callId: "call_123",
        elapsedMs: 120000,
        softMs: 60000,
        hardMs: 120000,
        lastProgressMsAgo: 119000,
      },
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: { nodes: [{ body: `prior\n${plan.marker}` }], pageInfo: { hasPreviousPage: false } },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: {} };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeWatchdogToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 342,
        taskName: "Watchdog test",
        taskPath: "orchestration/tasks/ralph 342.md",
        sessionId: "ses_test",
        worktreePath: "/home/alice/worktrees/ralph",
        stage: "build",
        kind: "stuck",
        watchdogTimeout: {
          toolName: "bash",
          callId: "call_123",
          elapsedMs: 120000,
          softMs: 60000,
          hardMs: 120000,
          lastProgressMsAgo: 119000,
        },
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
        },
      }
    );

    expect(result.postedComment).toBe(false);
    expect(result.markerFound).toBe(true);
    expect(postedBodies.length).toBe(0);
  });
});
