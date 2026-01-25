import { describe, expect, test } from "bun:test";

import { buildCiDebugMarker, upsertCiDebugComment } from "../github/ci-debug-writeback";

describe("github ci-debug writeback", () => {
  test("buildCiDebugMarker is deterministic", () => {
    const markerA = buildCiDebugMarker({ repo: "3mdistal/ralph", prNumber: 123 });
    const markerB = buildCiDebugMarker({ repo: "3mdistal/ralph", prNumber: 123 });
    const markerC = buildCiDebugMarker({ repo: "3mdistal/ralph", prNumber: 124 });

    expect(markerA).toBe(markerB);
    expect(markerA).not.toBe(markerC);
  });

  test("upsertCiDebugComment creates comment when missing", async () => {
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
          return { data: { id: 55 } };
        }
        return { data: {} };
      },
    } as any;

    const body = `${buildCiDebugMarker({ repo: "3mdistal/ralph", prNumber: 123 })}\nhello`;
    const result = await upsertCiDebugComment({
      github,
      repo: "3mdistal/ralph",
      prNumber: 123,
      commentBody: body,
    });

    expect(result.created).toBe(true);
    expect(result.commentId).toBe(55);
    expect(postedBodies[0]).toContain("ralph-ci-debug");
  });

  test("upsertCiDebugComment updates by comment id", async () => {
    const calls: Array<{ method: string; path: string }> = [];

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        const method = (opts.method ?? "GET").toUpperCase();
        calls.push({ method, path });
        return { data: {} };
      },
    } as any;

    const body = `${buildCiDebugMarker({ repo: "3mdistal/ralph", prNumber: 123 })}\nupdated`;
    const result = await upsertCiDebugComment({
      github,
      repo: "3mdistal/ralph",
      prNumber: 123,
      commentBody: body,
      commentId: 42,
    });

    expect(result.updated).toBe(true);
    expect(calls).toEqual([
      { method: "PATCH", path: "/repos/3mdistal/ralph/issues/comments/42" },
    ]);
  });
});
