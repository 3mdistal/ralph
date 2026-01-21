import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config", () => {
  const config = {
    repos: [],
    maxWorkers: 1,
    batchSize: 10,
    pollInterval: 30_000,
    bwrbVault: "/tmp",
    owner: "3mdistal",
    allowedOwners: ["3mdistal"],
    devDir: "/tmp",
    githubApp: {
      appId: 123,
      installationId: 456,
      privateKeyPath: "/does/not/matter.pem",
    },
  };

  return {
    loadConfig: () => ({
      config,
      meta: { source: "json", queueBackendExplicit: false },
    }),
    getConfig: () => config,
  };
});

import {
  __resetGitHubAuthForTests,
  __setGitHubAuthDepsForTests,
  getInstallationToken,
  listAccessibleRepos,
} from "../github-app-auth";

afterAll(() => {
  mock.restore();
});

describe("github app auth", () => {
  beforeEach(() => {
    __resetGitHubAuthForTests();
  });

  test("caches installation token in memory", async () => {
    const readFileMock = mock(async () => "PEM");

    let tokenCalls = 0;
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/access_tokens")) {
        tokenCalls++;
        return new Response(
          JSON.stringify({
            token: "tok_1",
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    __setGitHubAuthDepsForTests({
      readFile: readFileMock as any,
      createSign: (() => ({
        update: () => {},
        end: () => {},
        sign: () => new Uint8Array([1, 2, 3]),
      })) as any,
      fetch: fetchMock as any,
    });

    const t1 = await getInstallationToken();
    const t2 = await getInstallationToken();

    expect(t1).toBe("tok_1");
    expect(t2).toBe("tok_1");
    expect(tokenCalls).toBe(1);
    expect(readFileMock).toHaveBeenCalled();
  });

  test("refreshes installation token when near expiry", async () => {
    const readFileMock = mock(async () => "PEM");

    let tokenCalls = 0;
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/access_tokens")) {
        tokenCalls++;
        const expiresSoon = tokenCalls === 1;
        return new Response(
          JSON.stringify({
            token: `tok_${tokenCalls}`,
            expires_at: new Date(Date.now() + (expiresSoon ? 30_000 : 60 * 60_000)).toISOString(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    __setGitHubAuthDepsForTests({
      readFile: readFileMock as any,
      createSign: (() => ({
        update: () => {},
        end: () => {},
        sign: () => new Uint8Array([1, 2, 3]),
      })) as any,
      fetch: fetchMock as any,
    });

    const t1 = await getInstallationToken();
    const t2 = await getInstallationToken();

    expect(t1).toBe("tok_1");
    expect(t2).toBe("tok_2");
    expect(tokenCalls).toBe(2);
  });

  test("lists installation repositories with pagination", async () => {
    const readFileMock = mock(async () => "PEM");

    let tokenCalls = 0;
    let listCalls = 0;

    const fetchMock = mock(async (url: string) => {
      if (url.includes("/access_tokens")) {
        tokenCalls++;
        return new Response(
          JSON.stringify({
            token: "tok_1",
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.startsWith("https://api.github.com/installation/repositories")) {
        listCalls++;
        const page2 = url.includes("page=2");

        const repositories = page2
          ? [
              {
                id: 2,
                name: "repo2",
                full_name: "builder-org/repo2",
                owner: { login: "builder-org" },
                private: true,
                archived: false,
                fork: false,
                default_branch: "main",
              },
            ]
          : [
              {
                id: 1,
                name: "repo1",
                full_name: "3mdistal/repo1",
                owner: { login: "3mdistal" },
                private: false,
                archived: false,
                fork: false,
                default_branch: "main",
              },
            ];

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (!page2) {
          headers.link =
            '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next", <https://api.github.com/installation/repositories?per_page=100&page=2>; rel="last"';
        }

        return new Response(JSON.stringify({ total_count: 2, repositories }), { status: 200, headers });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    __setGitHubAuthDepsForTests({
      readFile: readFileMock as any,
      createSign: (() => ({
        update: () => {},
        end: () => {},
        sign: () => new Uint8Array([1, 2, 3]),
      })) as any,
      fetch: fetchMock as any,
    });

    const repos = await listAccessibleRepos();

    expect(tokenCalls).toBe(1);
    expect(listCalls).toBe(2);
    expect(repos.map((r) => r.fullName)).toEqual(["3mdistal/repo1", "builder-org/repo2"]);
  });
});
