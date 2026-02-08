import { describe, expect, test } from "bun:test";

import { writeParentVerificationNoPrCompletion } from "../github/parent-verification-writeback";

describe("parent verification no-pr writeback", () => {
  test("creates structured verification comment, closes issue, and applies done label", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const idempotencyKeys = new Set<string>();

    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        const method = opts.method ?? "GET";
        requests.push({ path, method, body: opts.body });

        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [],
                      pageInfo: { hasPreviousPage: false },
                    },
                  },
                },
              },
            },
          };
        }

        if (path.endsWith("/issues/454/comments") && method === "POST") {
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/454#issuecomment-1", id: 1 } };
        }

        if (path.endsWith("/issues/454") && method === "PATCH") {
          return { data: { state: "closed" } };
        }

        if (path.endsWith("/issues/454/labels") && method === "POST") {
          return { data: {} };
        }

        if (path.includes("/issues/454/labels/") && method === "DELETE") {
          return { status: 200, data: {} };
        }

        return { data: {} };
      },
    } as any;

    const result = await writeParentVerificationNoPrCompletion(
      {
        repo: "3mdistal/ralph",
        issueNumber: 454,
        marker: {
          version: 1,
          work_remains: false,
          reason: "All done",
          confidence: "high",
          checked: ["Checked child closures"],
          why_satisfied: "Children fully satisfy parent acceptance criteria.",
          evidence: [{ url: "https://github.com/3mdistal/ralph/issues/123", note: "Child issue" }],
        },
      },
      {
        github,
        initStateDb: () => {},
        hasIdempotencyKey: (key) => idempotencyKeys.has(key),
        recordIdempotencyKey: (input) => {
          idempotencyKeys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          idempotencyKeys.delete(key);
        },
      }
    );

    expect(result.ok).toBe(true);
    const commentPost = requests.find((entry) => entry.path.endsWith("/issues/454/comments") && entry.method === "POST");
    expect(commentPost).toBeDefined();
    expect(String((commentPost?.body as any)?.body ?? "")).toContain("<!-- ralph-verify:v1 id=454 -->");
    expect(String((commentPost?.body as any)?.body ?? "")).toContain("RALPH_VERIFY:");

    const closePatch = requests.find((entry) => entry.path.endsWith("/issues/454") && entry.method === "PATCH");
    expect(closePatch).toBeDefined();
    expect((closePatch?.body as any)?.state).toBe("closed");

    const labelAdd = requests.find((entry) => entry.path.endsWith("/issues/454/labels") && entry.method === "POST");
    expect(labelAdd).toBeDefined();
    expect((labelAdd?.body as any)?.labels).toContain("ralph:status:done");
  });

  test("updates existing verification comment instead of creating a new one", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const idempotencyKeys = new Set<string>();

    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        const method = opts.method ?? "GET";
        requests.push({ path, method, body: opts.body });

        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [
                        {
                          body: "<!-- ralph-verify:v1 id=454 -->\nRALPH_VERIFY: {\"version\":1}",
                          databaseId: 99,
                          url: "https://github.com/3mdistal/ralph/issues/454#issuecomment-99",
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

        if (path.endsWith("/issues/comments/99") && method === "PATCH") {
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/454#issuecomment-99" } };
        }

        if (path.endsWith("/issues/454/comments") && method === "POST") {
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/454#issuecomment-1", id: 1 } };
        }

        if (path.endsWith("/issues/454") && method === "PATCH") {
          return { data: { state: "closed" } };
        }

        if (path.endsWith("/issues/454/labels") && method === "POST") {
          return { data: {} };
        }

        if (path.includes("/issues/454/labels/") && method === "DELETE") {
          return { status: 200, data: {} };
        }

        return { data: {} };
      },
    } as any;

    const result = await writeParentVerificationNoPrCompletion(
      {
        repo: "3mdistal/ralph",
        issueNumber: 454,
        marker: {
          version: 1,
          work_remains: false,
          reason: "All done",
          confidence: "medium",
          checked: ["Checked child closures"],
          why_satisfied: "Satisfied",
          evidence: [{ url: "https://github.com/3mdistal/ralph/issues/123" }],
        },
      },
      {
        github,
        initStateDb: () => {},
        hasIdempotencyKey: (key) => idempotencyKeys.has(key),
        recordIdempotencyKey: (input) => {
          idempotencyKeys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          idempotencyKeys.delete(key);
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.commentUpdated).toBe(true);
    const created = requests.find((entry) => entry.path.endsWith("/issues/454/comments") && entry.method === "POST");
    expect(created).toBeUndefined();
    const updated = requests.find((entry) => entry.path.endsWith("/issues/comments/99") && entry.method === "PATCH");
    expect(updated).toBeDefined();
  });
});
