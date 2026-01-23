import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { GitHubClient } from "../github/client";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorGhToken: string | undefined;
let priorGithubToken: string | undefined;
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
  });

  afterEach(async () => {
    restoreEnvVar("GH_TOKEN", priorGhToken);
    restoreEnvVar("GITHUB_TOKEN", priorGithubToken);
    if (priorFetch) {
      globalThis.fetch = priorFetch;
    }
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
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

    globalThis.fetch = fetchMock as typeof fetch;
    const result = await client.request<{ ok: boolean; auth: string | null }>("/rate_limit");

    expect(fetchMock).toHaveBeenCalled();
    expect(result.data?.auth).toBe("token late-token");
  });
});
