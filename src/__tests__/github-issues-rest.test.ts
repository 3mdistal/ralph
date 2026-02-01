import { describe, expect, test } from "bun:test";

import { fetchIssuesSince } from "../github/issues-rest";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("github issues rest", () => {
  test("paginates and preserves max updated_at across PR rows", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("page=2")) {
        return new Response(
          JSON.stringify([
            {
              number: 3,
              updated_at: "2026-01-11T00:00:01.000Z",
              labels: [],
              pull_request: {},
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 1,
            updated_at: "2026-01-11T00:00:03.000Z",
            labels: [],
            pull_request: {},
          },
          {
            number: 2,
            updated_at: "2026-01-11T00:00:02.000Z",
            labels: [],
          },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://api.github.com/repos/org/repo/issues?page=2>; rel="next"',
          },
        }
      );
    };

    const result = await fetchIssuesSince({
      repo: "org/repo",
      since: "2026-01-11T00:00:00.000Z",
      token: "token",
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.number).toBe(2);
    expect(result.maxUpdatedAt).toBe("2026-01-11T00:00:03.000Z");
    expect(calls.length).toBe(2);
  });

  test("reports rate limit reset from headers", async () => {
    const fetchMock: FetchLike = async () =>
      new Response("API rate limit exceeded", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1700000000",
        },
      });

    const result = await fetchIssuesSince({
      repo: "org/repo",
      since: null,
      token: "token",
      fetchImpl: fetchMock,
      nowMs: 1699990000000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rateLimitResetMs).toBe(1700000000 * 1000);
    expect(result.error).toContain("HTTP 403");
  });
});
