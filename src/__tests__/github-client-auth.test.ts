import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { __resetGitHubAuthForTests, __setGitHubAuthDepsForTests } from "../github-app-auth";
import { getRalphConfigJsonPath } from "../paths";
import { GitHubClient } from "../github/client";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorGhToken: string | undefined;
let priorGithubToken: string | undefined;
let priorSandboxToken: string | undefined;
let priorFetch: typeof fetch | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

function restoreEnvVar(name: "GH_TOKEN" | "GITHUB_TOKEN", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function getHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return match?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

afterAll(() => {
  mock.restore();
});

describe("github client auth", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorGhToken = process.env.GH_TOKEN;
    priorGithubToken = process.env.GITHUB_TOKEN;
    priorSandboxToken = process.env.GITHUB_SANDBOX_TOKEN;
    priorFetch = globalThis.fetch;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    __resetConfigForTests();

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
    });
    __resetConfigForTests();
    __resetGitHubAuthForTests();
  });

  afterEach(async () => {
    restoreEnvVar("GH_TOKEN", priorGhToken);
    restoreEnvVar("GITHUB_TOKEN", priorGithubToken);
    if (priorSandboxToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorSandboxToken;
    if (priorFetch) {
      globalThis.fetch = priorFetch;
    }
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    __resetGitHubAuthForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("uses env token set after construction", async () => {
    const client = new GitHubClient("3mdistal/ralph");
    process.env.GH_TOKEN = "late-token";

    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = getHeader(init?.headers, "Authorization");
      return new Response(JSON.stringify({ ok: true, auth }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await client.request<{ ok: boolean; auth: string | null }>("/rate_limit");

    expect(fetchMock).toHaveBeenCalled();
    expect(result.data?.auth).toBe("token late-token");
  });

  test("uses sandbox token env var instead of GH_TOKEN", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      profile: "sandbox",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
      },
    });
    __resetConfigForTests();

    process.env.GH_TOKEN = "prod-token";
    process.env.GITHUB_SANDBOX_TOKEN = "sandbox-token";

    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = getHeader(init?.headers, "Authorization");
      return new Response(JSON.stringify({ ok: true, auth }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new GitHubClient("3mdistal/ralph-sandbox-demo");
    const result = await client.request<{ ok: boolean; auth: string | null }>("/rate_limit");

    expect(fetchMock).toHaveBeenCalled();
    expect(result.data?.auth).toBe("token sandbox-token");
  });

  test("refreshes GitHub App tokens between requests", async () => {
    await writeJson(getRalphConfigJsonPath(), {
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
    });
    __resetConfigForTests();
    process.env.GH_TOKEN = "stale-token";

    let tokenCalls = 0;
    const auths: Array<string | null> = [];

    __setGitHubAuthDepsForTests({
      readFile: mock(async () => "PEM") as any,
      createSign: (() => ({
        update: () => {},
        end: () => {},
        sign: () => new Uint8Array([1, 2, 3]),
      })) as any,
      fetch: mock(async (url: string) => {
        if (url.includes("/access_tokens")) {
          tokenCalls += 1;
          return new Response(
            JSON.stringify({
              token: `tok_${tokenCalls}`,
              expires_at: new Date(Date.now() - 60_000).toISOString(),
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as any,
    });

    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      auths.push(getHeader(init?.headers, "Authorization"));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubClient("3mdistal/ralph");
    await client.request("/rate_limit");
    await client.request("/rate_limit");

    expect(tokenCalls).toBe(2);
    expect(auths).toEqual(["token tok_1", "token tok_2"]);
  });
});
