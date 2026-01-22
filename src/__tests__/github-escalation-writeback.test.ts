import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildEscalationComment,
  buildEscalationMarker,
  extractExistingMarker,
  planEscalationWriteback,
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

  test("extractExistingMarker parses marker id", () => {
    expect(extractExistingMarker("<!-- ralph-escalation:id=deadbeef -->")).toBe("deadbeef");
  });

  test("writeEscalationToGitHub posts once and records idempotency", async () => {
    const keys = new Set<string>();
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
          return true;
        },
      }
    );

    expect(result.postedComment).toBe(true);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
    expect(postedBodies.length).toBe(1);
    expect(postedBodies[0]).toContain(plan.marker);
  });

  test("writeEscalationToGitHub skips when marker already present", async () => {
    const keys = new Set<string>();
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
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [{ body: `prior\n${plan.marker}` }],
                      pageInfo: { hasPreviousPage: false },
                    },
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
          return true;
        },
      }
    );

    expect(result.postedComment).toBe(false);
    expect(result.markerFound).toBe(true);
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
