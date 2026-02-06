import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMarker,
  buildParentVerificationComment,
  planVerificationCommentWrite,
  writeParentVerificationToGitHub,
} from "../github/parent-verification-writeback";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("parent verification writeback", () => {
  test("buildMarker includes issue number", () => {
    expect(buildMarker({ issueNumber: 454 })).toBe("<!-- ralph-verify:v1 id=454 -->");
  });

  test("planVerificationCommentWrite prefers noop when body matches", () => {
    const marker = buildMarker({ issueNumber: 454 });
    const body = buildParentVerificationComment({
      marker,
      payload: {
        confidence: "high",
        checked: ["child issues reviewed"],
        whySatisfied: "All criteria met.",
        evidence: [{ url: "https://example.com" }],
      },
    });

    const plan = planVerificationCommentWrite({
      desiredBody: body,
      markerId: "454",
      marker,
      scannedComments: [{ body, databaseId: 123, url: "url", createdAt: "2026-01-01T00:00:00Z" }],
    });

    expect(plan.action).toBe("noop");
    expect(plan.markerFound).toBe(true);
  });

  test("writeParentVerificationToGitHub posts comment and closes", async () => {
    const release = await acquireGlobalTestLock();
    const stateDir = await mkdtemp(join(tmpdir(), "ralph-state-"));
    const previous = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = join(stateDir, "state.sqlite");

    const postedBodies: string[] = [];
    let closed = false;

    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
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
          return { data: { html_url: "https://example.com/comment" } };
        }
        if (path.includes("/issues/") && opts.method === "PATCH" && opts.body?.state === "closed") {
          closed = true;
          return { data: {} };
        }
        return { data: [] };
      },
    } as any;

    const result = await writeParentVerificationToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 454,
        payload: {
          confidence: "high",
          checked: ["child issues reviewed"],
          whySatisfied: "All criteria met.",
          evidence: [{ url: "https://example.com" }],
        },
      },
      { github }
    );

    expect(result.ok).toBe(true);
    expect(postedBodies.length).toBe(1);
    expect(postedBodies[0]).toContain("<!-- ralph-verify:v1 id=454 -->");
    expect(postedBodies[0]).toContain("RALPH_VERIFY:");
    expect(closed).toBe(true);

    process.env.RALPH_STATE_DB_PATH = previous;
    await rm(stateDir, { recursive: true, force: true });
    release();
  });
});
