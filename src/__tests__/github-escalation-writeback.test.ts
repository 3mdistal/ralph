import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildEscalationComment,
  buildEscalationMarker,
  extractExistingMarker,
  planEscalationCommentWrite,
  planEscalationWriteback,
  sanitizeEscalationReason,
  writeEscalationToGitHub,
} from "../github/escalation-writeback";
import { closeStateDbForTests } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("github escalation writeback", () => {
  test("buildEscalationMarker is deterministic", () => {
    const markerA = buildEscalationMarker({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      escalationType: "other",
    });
    const markerB = buildEscalationMarker({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      escalationType: "other",
    });
    const markerC = buildEscalationMarker({
      repo: "3mdistal/ralph",
      issueNumber: 67,
      escalationType: "other",
    });

    expect(markerA).toBe(markerB);
    expect(markerA).not.toBe(markerC);
  });

  test("buildEscalationComment includes marker + owner mention", () => {
    const marker = "<!-- ralph-escalation:id=abc123 -->";
    const comment = buildEscalationComment({
      marker,
      taskName: "Escalation task",
      issueUrl: "https://github.com/3mdistal/ralph/issues/66",
      reason: "Need guidance",
      ownerHandle: "@3mdistal",
    });

    expect(comment.split("\n")[0]).toBe(marker);
    expect(comment).toContain("@3mdistal");
  });

  test("sanitizeEscalationReason redacts tokens and paths", () => {
    const input =
      "ghp_abcdefghijklmnopqrstuv Authorization: Bearer secret-token /home/alice/project /Users/bob/app \x1b[31mred\x1b[0m";
    const output = sanitizeEscalationReason(input);

    expect(output).toContain("ghp_[REDACTED]");
    expect(output).toContain("Bearer [REDACTED]");
    expect(output).toContain("~/project");
    expect(output).toContain("~/app");
    expect(output).not.toContain("~//");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(output).not.toContain("secret-token");
  });

  test("extractExistingMarker parses marker id", () => {
    expect(extractExistingMarker("<!-- ralph-escalation:id=deadbeef -->")).toBe("deadbeef");
  });

  test("planEscalationCommentWrite prefers noop when body matches", () => {
    const plan = planEscalationWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      taskName: "Escalation task",
      taskPath: "orchestration/tasks/ralph 66.md",
      reason: "Need guidance",
      escalationType: "other",
    });

    const commentBody = buildEscalationComment({
      marker: plan.marker,
      taskName: "Escalation task",
      issueUrl: "https://github.com/3mdistal/ralph/issues/66",
      reason: "Need guidance",
      ownerHandle: "@3mdistal",
    });

    const result = planEscalationCommentWrite({
      desiredBody: plan.commentBody,
      markerId: plan.markerId,
      marker: plan.marker,
      scannedComments: [{ body: commentBody, databaseId: 123, createdAt: "2025-01-01T00:00:00Z", url: "url" }],
    });

    expect(result.action).toBe("noop");
    expect(result.markerFound).toBe(true);
    expect(result.targetCommentId).toBe(123);
  });

  test("planEscalationCommentWrite selects newest matching marker comment", () => {
    const plan = planEscalationWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      taskName: "Escalation task",
      taskPath: "orchestration/tasks/ralph 66.md",
      reason: "Need guidance",
      escalationType: "other",
    });

    const result = planEscalationCommentWrite({
      desiredBody: "Updated body",
      markerId: plan.markerId,
      marker: plan.marker,
      scannedComments: [
        { body: `${plan.marker}\nold`, databaseId: 111, createdAt: "2024-01-01T00:00:00Z", url: "old" },
        { body: `${plan.marker}\nnew`, databaseId: 222, createdAt: "2024-02-01T00:00:00Z", url: "new" },
      ],
    });

    expect(result.action).toBe("patch");
    expect(result.targetCommentId).toBe(222);
    expect(result.targetCommentUrl).toBe("new");
  });

  test("writeEscalationToGitHub posts once and records idempotency", async () => {
    const keys = new Set<string>();
    const payloads = new Map<string, string>();
    const postedBodies: string[] = [];

    const plan = planEscalationWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      taskName: "Escalation task",
      taskPath: "orchestration/tasks/ralph 66.md",
      reason: "Need guidance",
      escalationType: "other",
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }
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
          return { data: {} };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeEscalationToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 66,
        taskName: "Escalation task",
        taskPath: "orchestration/tasks/ralph 66.md",
        reason: "Need guidance",
        escalationType: "other",
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          if (input.payloadJson) payloads.set(input.key, input.payloadJson);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
          payloads.delete(key);
        },
        getIdempotencyPayload: (key) => payloads.get(key) ?? null,
        upsertIdempotencyKey: (input) => {
          keys.add(input.key);
          payloads.set(input.key, input.payloadJson ?? "");
        },
      }
    );

    expect(result.postedComment).toBe(true);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
    expect(postedBodies.length).toBe(1);
    expect(postedBodies[0]).toContain(plan.marker);
  });

  test("writeEscalationToGitHub updates when marker already present", async () => {
    const keys = new Set<string>();
    const payloads = new Map<string, string>();
    const postedBodies: string[] = [];
    const patchedBodies: string[] = [];

    const plan = planEscalationWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      taskName: "Escalation task",
      taskPath: "orchestration/tasks/ralph 66.md",
      reason: "Need guidance",
      escalationType: "other",
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [
                        {
                          body: `prior\n${plan.marker}`,
                          databaseId: 123,
                          createdAt: "2024-01-01T00:00:00Z",
                          url: "https://github.com/3mdistal/ralph/issues/66#issuecomment-123",
                        },
                      ],
                      pageInfo: { hasPreviousPage: false },
                    },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/issues/comments/") && opts.method === "PATCH") {
          patchedBodies.push(opts.body?.body ?? "");
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/66#issuecomment-123" } };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: {} };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeEscalationToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 66,
        taskName: "Escalation task",
        taskPath: "orchestration/tasks/ralph 66.md",
        reason: "Need guidance",
        escalationType: "other",
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          if (input.payloadJson) payloads.set(input.key, input.payloadJson);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
          payloads.delete(key);
        },
        getIdempotencyPayload: (key) => payloads.get(key) ?? null,
        upsertIdempotencyKey: (input) => {
          keys.add(input.key);
          payloads.set(input.key, input.payloadJson ?? "");
        },
      }
    );

    expect(result.postedComment).toBe(false);
    expect(result.markerFound).toBe(true);
    expect(result.skippedComment).toBe(false);
    expect(patchedBodies.length).toBe(1);
    expect(postedBodies.length).toBe(0);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
  });

  test("writeEscalationToGitHub no-ops when marker comment matches", async () => {
    const keys = new Set<string>();
    const payloads = new Map<string, string>();
    const postedBodies: string[] = [];
    const patchedBodies: string[] = [];

    const plan = planEscalationWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 66,
      taskName: "Escalation task",
      taskPath: "orchestration/tasks/ralph 66.md",
      reason: "Need guidance",
      escalationType: "other",
    });

    const canonicalBody = buildEscalationComment({
      marker: plan.marker,
      taskName: "Escalation task",
      issueUrl: "https://github.com/3mdistal/ralph/issues/66",
      reason: "Need guidance",
      ownerHandle: "@3mdistal",
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [
                        {
                          body: canonicalBody,
                          databaseId: 123,
                          createdAt: "2024-01-01T00:00:00Z",
                          url: "https://github.com/3mdistal/ralph/issues/66#issuecomment-123",
                        },
                      ],
                      pageInfo: { hasPreviousPage: false },
                    },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/issues/comments/") && opts.method === "PATCH") {
          patchedBodies.push(opts.body?.body ?? "");
          return { data: {} };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: {} };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeEscalationToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 66,
        taskName: "Escalation task",
        taskPath: "orchestration/tasks/ralph 66.md",
        reason: "Need guidance",
        escalationType: "other",
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          if (input.payloadJson) payloads.set(input.key, input.payloadJson);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
          payloads.delete(key);
        },
        getIdempotencyPayload: (key) => payloads.get(key) ?? null,
        upsertIdempotencyKey: (input) => {
          keys.add(input.key);
          payloads.set(input.key, input.payloadJson ?? "");
        },
      }
    );

    expect(result.postedComment).toBe(false);
    expect(result.skippedComment).toBe(true);
    expect(result.markerFound).toBe(true);
    expect(patchedBodies.length).toBe(0);
    expect(postedBodies.length).toBe(0);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
  });

  test("writeEscalationToGitHub initializes state when using defaults", async () => {
    const releaseLock = await acquireGlobalTestLock();
    const priorPath = process.env.RALPH_STATE_DB_PATH;
    const tempDir = await mkdtemp(join(tmpdir(), "ralph-state-"));

    try {
      process.env.RALPH_STATE_DB_PATH = join(tempDir, "state.sqlite");
      closeStateDbForTests();

      const github = {
        request: async (path: string, opts: { method?: string } = {}) => {
          if (path.startsWith("/repos/3mdistal/ralph/labels")) {
            return { data: [] };
          }
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
            return { data: {} };
          }
          return { data: {} };
        },
      } as any;

      await writeEscalationToGitHub(
        {
          repo: "3mdistal/ralph",
          issueNumber: 66,
          taskName: "Escalation task",
          taskPath: "orchestration/tasks/ralph 66.md",
          reason: "Need guidance",
          escalationType: "other",
        },
        {
          github,
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      closeStateDbForTests();
      if (priorPath === undefined) {
        delete process.env.RALPH_STATE_DB_PATH;
      } else {
        process.env.RALPH_STATE_DB_PATH = priorPath;
      }
      releaseLock?.();
    }
  });
});
