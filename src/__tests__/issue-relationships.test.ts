import { afterEach, describe, expect, test } from "bun:test";

import { GitHubClient } from "../github/client";
import { GitHubRelationshipProvider } from "../github/issue-relationships";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function buildRestIssues(count: number) {
  return Array.from({ length: count }, (_, idx) => ({
    number: idx + 1,
    state: "OPEN",
    repository: { full_name: "org/repo" },
  }));
}

function buildGraphNodes(count: number) {
  return Array.from({ length: count }, (_, idx) => ({
    number: idx + 1,
    state: "OPEN",
    repository: { nameWithOwner: "org/repo" },
  }));
}

function buildGraphResponse(field: "blockedBy" | "subIssues", nodes: unknown[], hasNextPage?: boolean) {
  const connection: Record<string, unknown> = { nodes };
  if (typeof hasNextPage === "boolean") {
    connection.pageInfo = { hasNextPage };
  }
  return {
    data: {
      repository: {
        issue: {
          [field]: connection,
        },
      },
    },
  };
}

function makeProvider() {
  const client = new GitHubClient("org/repo", { token: "token", requestTimeoutMs: 0 });
  return new GitHubRelationshipProvider("org/repo", client);
}

describe("GitHubRelationshipProvider coverage", () => {
  const priorFetch = globalThis.fetch;

  test("graphql uses hasNextPage=false to mark deps complete", async () => {
    const fetchMock: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/graphql")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const query = String(body.query ?? "");
        if (query.includes("blockedBy")) {
          return new Response(JSON.stringify(buildGraphResponse("blockedBy", buildGraphNodes(100), false)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(buildGraphResponse("subIssues", [], false)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(true);
  });

  test("graphql uses hasNextPage=true to mark deps partial", async () => {
    const fetchMock: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/graphql")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const query = String(body.query ?? "");
        if (query.includes("blockedBy")) {
          return new Response(JSON.stringify(buildGraphResponse("blockedBy", buildGraphNodes(100), true)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(buildGraphResponse("subIssues", [], false)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(false);
  });

  test("graphql missing pageInfo does not mark complete", async () => {
    const fetchMock: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/graphql")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const query = String(body.query ?? "");
        if (query.includes("blockedBy")) {
          return new Response(JSON.stringify(buildGraphResponse("blockedBy", buildGraphNodes(100))), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(buildGraphResponse("subIssues", [], false)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(false);
  });

  test("rest without Link rel=next marks deps complete", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response(JSON.stringify(buildRestIssues(100)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(true);
  });

  test("rest with Link rel=next marks deps partial", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response(JSON.stringify(buildRestIssues(10)), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://api.github.com/repos/org/repo/issues/1/dependencies?page=2>; rel="next"',
          },
        });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(false);
  });

  test("rest Link without next rel keeps deps complete", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response(JSON.stringify(buildRestIssues(10)), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://api.github.com/repos/org/repo/issues/1/dependencies?page=1>; rel="prev"',
          },
        });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(true);
  });

  test("rest Link parsing is case/whitespace tolerant", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/issues/1/dependencies")) {
        return new Response(JSON.stringify(buildRestIssues(10)), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://api.github.com/repos/org/repo/issues/1/dependencies?page=2>; rel=next',
          },
        });
      }
      if (url.includes("/issues/1/sub_issues")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/issues/1")) {
        return new Response(JSON.stringify({ body: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    };

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    const snapshot = await provider.getSnapshot({ repo: "org/repo", number: 1 });
    expect(snapshot.coverage.githubDepsComplete).toBe(false);
  });

  afterEach(() => {
    globalThis.fetch = priorFetch;
  });
});
