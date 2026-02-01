import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __resetGitHubClientForTests, GitHubApiError, GitHubClient } from "../github/client";
import { planGitHubRateLimitThrottle } from "../github/rate-limit-throttle";

async function withPatchedNow<T>(nowMs: number, fn: () => Promise<T> | T): Promise<T> {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

describe("planGitHubRateLimitThrottle", () => {
  let priorFetch: typeof fetch | undefined;

  beforeEach(() => {
    priorFetch = globalThis.fetch;
    __resetGitHubClientForTests();
  });

  afterEach(() => {
    if (priorFetch) globalThis.fetch = priorFetch;
  });

  test("uses header-based reset timestamp for primary rate limits", async () => {
    await withPatchedNow(1_000_000, async () => {
      const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        const headers = new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
          "x-github-request-id": "req-1",
        });
        return new Response(
          JSON.stringify({
            message: "API rate limit exceeded for installation ID 104421788.",
          }),
          { status: 403, headers }
        );
      };

      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
      });

      let err: GitHubApiError | null = null;
      try {
        await client.request("/rate_limit_test", { method: "GET" });
      } catch (e) {
        err = e as GitHubApiError;
      }

      expect(err).toBeInstanceOf(GitHubApiError);
      const plan = planGitHubRateLimitThrottle(Date.now(), err);
      expect(plan).not.toBeNull();
      expect(plan?.resumeAt).toBe(new Date(resetSeconds * 1000).toISOString());
      expect(plan?.snapshot.kind).toBe("github-rate-limit");
    });
  });

  test("uses embedded timestamp for secondary rate limits", async () => {
    await withPatchedNow(Date.parse("2026-01-31T19:34:17.000Z"), async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        const headers = new Headers({
          "x-github-request-id": "req-ts",
        });
        return new Response(
          JSON.stringify({
            message:
              "API rate limit exceeded for installation ID 104421788. If you reach out to GitHub Support for help, please include the request ID 80D8:1DA0:6C7BD7:1D56133:697E5939 and timestamp 2026-01-31 19:49:07 UTC.",
          }),
          { status: 403, headers }
        );
      };

      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
      });

      let err: GitHubApiError | null = null;
      try {
        await client.request("/rate_limit_test", { method: "GET" });
      } catch (e) {
        err = e as GitHubApiError;
      }

      expect(err).toBeInstanceOf(GitHubApiError);
      const plan = planGitHubRateLimitThrottle(Date.now(), err);
      expect(plan).not.toBeNull();
      expect(plan?.resumeAt).toBe(new Date("2026-01-31T19:49:07.000Z").toISOString());
    });
  });

  test("ignores non-rate-limit GitHub errors", async () => {
    await withPatchedNow(2_000_000, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        const headers = new Headers({ "x-github-request-id": "req-403" });
        return new Response("Forbidden", { status: 403, headers });
      };

      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
      });

      let err: GitHubApiError | null = null;
      try {
        await client.request("/forbidden", { method: "GET" });
      } catch (e) {
        err = e as GitHubApiError;
      }

      expect(err).toBeInstanceOf(GitHubApiError);
      const plan = planGitHubRateLimitThrottle(Date.now(), err);
      expect(plan).toBeNull();
    });
  });
});
