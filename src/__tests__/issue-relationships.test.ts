import { afterEach, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { GitHubClient } from "../github/client";
import { GitHubRelationshipProvider } from "../github/issue-relationships";
import { closeStateDbForTests, initStateDb, recordIssueLabelsSnapshot } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

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

  test("treats in-bot dependencies as satisfied (unblocked)", async () => {
    const releaseLock = await acquireGlobalTestLock();
    const priorHome = process.env.HOME;
    const priorStateDb = process.env.RALPH_STATE_DB_PATH;
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-issue-relationships-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

    try {
      closeStateDbForTests();
      initStateDb();
      const at = new Date("2026-02-05T00:00:00.000Z").toISOString();
      recordIssueLabelsSnapshot({
        repo: "org/repo",
        issue: "org/repo#2",
        labels: ["ralph:status:in-bot"],
        at,
      });

      const fetchMock: FetchLike = async (input) => {
        const url = String(input);
        if (url.includes("/issues/1/dependencies")) {
          return new Response(
            JSON.stringify([
              {
                number: 2,
                state: "OPEN",
                repository: { full_name: "org/repo" },
              },
            ]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
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

      const dep = snapshot.signals.find(
        (signal) => signal.kind === "blocked_by" && signal.source === "github" && signal.ref?.repo === "org/repo" && signal.ref?.number === 2
      );
      expect(dep?.state).toBe("closed");
    } finally {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorStateDb;
      releaseLock();
    }
  });

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
