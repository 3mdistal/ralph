import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __resetGitHubClientForTests, GitHubClient } from "../github/client";

type Deferred = { promise: Promise<void>; resolve: () => void };

function defer(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("GitHubClient concurrency backpressure", () => {
  let priorFetch: typeof fetch | undefined;

  beforeEach(() => {
    priorFetch = globalThis.fetch;
    __resetGitHubClientForTests({ maxInflight: 1, maxInflightWrites: 1 });
  });

  afterEach(() => {
    __resetGitHubClientForTests();
    if (priorFetch) globalThis.fetch = priorFetch;
  });

  test("serializes concurrent requests when maxInflight=1", async () => {
    const calls: string[] = [];
    const gate = defer();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) {
        await gate.promise;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
      });
    };

    const client = new GitHubClient("3mdistal/ralph", {
      getToken: async () => "token",
    });

    const p1 = client.request("/a", { method: "GET" });
    const p2 = client.request("/b", { method: "GET" });

    // Let the first request start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(calls.length).toBe(2);
  });
});
