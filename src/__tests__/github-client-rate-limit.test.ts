import { describe, expect, test } from "bun:test";

import { GitHubApiError, GitHubClient } from "../github/client";

async function withPatchedNow<T>(nowMs: number, fn: () => Promise<T> | T): Promise<T> {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

describe("GitHubClient rate limit handling", () => {
  test("classifies 403 API rate limit exceeded as rate_limit and backs off until reset", async () => {
    await withPatchedNow(1_000_000, async () => {
      let call = 0;
      const sleepCalls: number[] = [];

      const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        call += 1;
        if (call === 1) {
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
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
        });
      };

      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
        sleepMs: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      try {
        await client.request("/rate_limit_test", { method: "DELETE" });
        throw new Error("expected request to fail");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubApiError);
        const err = e as GitHubApiError;
        expect(err.status).toBe(403);
        expect(err.code).toBe("rate_limit");
      }

      await client.request("/after_backoff", { method: "GET" });
      expect(sleepCalls.length).toBe(1);
      expect(sleepCalls[0]).toBe(120_000);
    });
  });

  test("does not misclassify generic 403 as rate_limit", async () => {
    await withPatchedNow(2_000_000, async () => {
      const sleepCalls: number[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        const headers = new Headers({ "x-github-request-id": "req-403" });
        return new Response("Forbidden", { status: 403, headers });
      };

      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
        sleepMs: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      try {
        await client.request("/forbidden", { method: "DELETE" });
        throw new Error("expected request to fail");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubApiError);
        const err = e as GitHubApiError;
        expect(err.code).toBe("auth");
      }

      expect(sleepCalls.length).toBe(0);
    });
  });

  test("treats secondary rate limit text as rate_limit (transient)", async () => {
    await withPatchedNow(3_000_000, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        const headers = new Headers({ "x-github-request-id": "req-secondary" });
        return new Response("You have exceeded a secondary rate limit", { status: 403, headers });
      };

      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
        sleepMs: async () => {},
      });

      try {
        await client.request("/secondary", { method: "GET" });
        throw new Error("expected request to fail");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubApiError);
        const err = e as GitHubApiError;
        expect(err.code).toBe("rate_limit");
      }
    });
  });

  test("does not apply rate-limit backoff across different tokens", async () => {
    await withPatchedNow(4_000_000, async () => {
      let call = 0;
      const sleepCalls: Array<{ token: string; ms: number }> = [];

      const resetSeconds = Math.floor((Date.now() + 60_000) / 1000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        call += 1;
        if (call === 1) {
          const headers = new Headers({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
            "x-github-request-id": "req-a",
          });
          return new Response(JSON.stringify({ message: "API rate limit exceeded for installation ID 104421788." }), {
            status: 403,
            headers,
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
        });
      };

      const clientA = new GitHubClient("3mdistal/bwrb", {
        getToken: async () => "token-a",
        sleepMs: async (ms) => {
          sleepCalls.push({ token: "a", ms });
        },
      });

      const clientB = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token-b",
        sleepMs: async (ms) => {
          sleepCalls.push({ token: "b", ms });
        },
      });

      try {
        await clientA.request("/rate_limit_test", { method: "GET" });
        throw new Error("expected request to fail");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubApiError);
      }

      await clientB.request("/after_other_token", { method: "GET" });
      expect(sleepCalls).toEqual([]);
    });
  });
});
