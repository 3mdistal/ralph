import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath } from "../paths";
import { __resetConfigForTests } from "../config";
import { GitHubClient } from "../github/client";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorToken: string | undefined;
let priorFetch: typeof fetch | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("sandbox github client", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    priorFetch = globalThis.fetch;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.GITHUB_SANDBOX_TOKEN = "token";

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
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
    if (priorFetch) globalThis.fetch = priorFetch;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("allows GraphQL queries in sandbox", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true, headers: init?.headers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubClient("3mdistal/ralph-sandbox-demo");
    const result = await client.request("/graphql", { method: "POST", body: { query: "{ viewer { login } }" } });
    expect(result.data).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });

  test("blocks REST writes before fetch outside sandbox boundary", async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubClient("3mdistal/prod-repo");
    await expect(
      client.request("/repos/3mdistal/prod-repo/issues", { method: "POST", body: { title: "nope" } })
    ).rejects.toThrow(/SANDBOX TRIPWIRE/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("blocks GraphQL mutation outside sandbox boundary", async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubClient("3mdistal/prod-repo");
    await expect(
      client.request("/graphql", { method: "POST", body: { query: "mutation { addStar }" } })
    ).rejects.toThrow(/SANDBOX TRIPWIRE/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("allows template generation when target repo is within sandbox", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify({ ok: true, default_branch: "main", full_name: "3mdistal/ralph-sandbox-abc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubClient("3mdistal/ralph-sandbox-demo");
    const result = await client.request("/repos/3mdistal/template-repo/generate", {
      method: "POST",
      body: { name: "ralph-sandbox-demo", owner: "3mdistal", private: true },
    });
    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenCalled();
  });
});
