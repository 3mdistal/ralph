import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { RepoWorker } from "../worker";

let homeDir: string;
let priorHome: string | undefined;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("required checks resolution", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    __resetConfigForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
  });

  test("uses explicit requiredChecks override without derivation", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [{ name: "acme/rocket", requiredChecks: ["ci"] }],
    });

    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp");
      const result = await (worker as any).resolveRequiredChecksForMerge();
      expect(result).toEqual({ checks: ["ci"], source: "config" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("derives required checks from bot branch protection", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [{ name: "acme/rocket" }],
    });

    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/branches/bot%2Fintegration/protection")) {
        return new Response(
          JSON.stringify({
            required_status_checks: { contexts: ["Test"], checks: [{ context: "Vercel" }] },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp");
      const result = await (worker as any).resolveRequiredChecksForMerge();
      expect(result).toEqual({ checks: ["Test", "Vercel"], source: "protection", branch: "bot/integration" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to main branch protection when bot branch missing", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [{ name: "acme/rocket" }],
    });

    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/branches/bot%2Fintegration/protection")) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/repos/acme/rocket/branches/main/protection")) {
        return new Response(
          JSON.stringify({ required_status_checks: { contexts: ["CI"] } }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp");
      const result = await (worker as any).resolveRequiredChecksForMerge();
      expect(result).toEqual({ checks: ["CI"], source: "protection", branch: "main" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unreadable branch protection disables gating", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [{ name: "acme/rocket" }],
    });

    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/branches/bot%2Fintegration/protection")) {
        return new Response("Forbidden", { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp");
      const result = await (worker as any).resolveRequiredChecksForMerge();
      expect(result).toEqual({ checks: [], source: "none" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("includes legacy status contexts in available checks", async () => {
    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/commits/bot/integration/check-runs?per_page=100")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (url.endsWith("/repos/acme/rocket/commits/bot/integration/status?per_page=100")) {
        return new Response(JSON.stringify({ statuses: [{ context: "Vercel" }] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp");
      const contexts = await (worker as any).fetchAvailableCheckContexts("bot/integration");
      expect(contexts).toEqual(["Vercel"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
