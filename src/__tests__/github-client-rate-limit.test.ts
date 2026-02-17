import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __resetGitHubClientForTests, GitHubApiError, GitHubClient } from "../github/client";
import { __resetGitHubGovernorForTests, __setGitHubGovernorCooldownForTests } from "../github/budget-governor";

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
  let priorFetch: typeof fetch | undefined;

  beforeEach(() => {
    priorFetch = globalThis.fetch;
    __resetGitHubClientForTests();
    __resetGitHubGovernorForTests();
  });

  afterEach(() => {
    if (priorFetch) globalThis.fetch = priorFetch;
    delete process.env.RALPH_GITHUB_BUDGET_GOVERNOR;
    delete process.env.RALPH_GITHUB_BUDGET_GOVERNOR_DRY_RUN;
  });

  test("requestWithLane defers best-effort during cooldown without fetch", async () => {
    process.env.RALPH_GITHUB_BUDGET_GOVERNOR = "1";
    let fetchCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const nowMs = 5_000_000;
    await withPatchedNow(nowMs, async () => {
      __setGitHubGovernorCooldownForTests("3mdistal/ralph", nowMs + 45_000);
      const client = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token",
      });

      const result = await client.requestWithLane("/deferred", {
        method: "GET",
        lane: "best_effort",
        source: "blocked-comment:find",
      });
      expect(result.ok).toBeFalse();
      if (!result.ok) {
        expect("deferred" in result).toBeTrue();
      }
      expect(fetchCalls).toBe(0);
    });
  });

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

  test("backs off until timestamp embedded in secondary rate limit message", async () => {
    await withPatchedNow(Date.parse("2026-01-31T19:34:17.000Z"), async () => {
      let call = 0;
      const sleepCalls: number[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        call += 1;
        if (call === 1) {
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
        await client.request("/rate_limit_test", { method: "GET" });
        throw new Error("expected request to fail");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubApiError);
        const err = e as GitHubApiError;
        expect(err.code).toBe("rate_limit");
        expect(err.resumeAtTs).toBe(Date.parse("2026-01-31T19:49:07.000Z"));
      }

      await client.request("/after_backoff", { method: "GET" });
      expect(sleepCalls).toEqual([890_000]);
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

      const clientA = new GitHubClient("3mdistal/ralph", {
        getToken: async () => "token-a",
        sleepMs: async (ms) => {
          sleepCalls.push({ token: "a", ms });
        },
      });

      const clientB = new GitHubClient("3mdistal/agentlib", {
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
