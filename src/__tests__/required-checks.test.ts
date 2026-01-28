import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import {
  __buildCheckRunsResponse,
  __buildGitRefResponse,
  __buildRepoDefaultBranchResponse,
  __decideBranchProtectionForTests,
  __formatRequiredChecksGuidanceForTests,
  __summarizeRequiredChecksForTests,
  __TEST_ONLY_DEFAULT_BRANCH,
  __TEST_ONLY_DEFAULT_SHA,
  RepoWorker,
} from "../worker";
import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("requiredChecks semantics", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
  });

  afterEach(() => {
    releaseLock?.();
    releaseLock = null;
  });

  test("requiredChecks=[] is treated as no gating (success)", () => {
    const summary = __summarizeRequiredChecksForTests(
      [{ name: "ci", state: "FAILURE", rawState: "FAILURE" }] as any,
      []
    );

    expect(summary.status).toBe("success");
    expect(summary.required).toEqual([]);
    expect(summary.available).toEqual(["ci"]);
  });

  test("requiredChecks with missing check is pending", () => {
    const summary = __summarizeRequiredChecksForTests([], ["ci"]);

    expect(summary.status).toBe("pending");
    expect(summary.required).toEqual([{ name: "ci", state: "UNKNOWN", rawState: "missing" }]);
    expect(summary.available).toEqual([]);
  });

  test("required checks guidance includes repo, branch, and hints", () => {
    const guidance = __formatRequiredChecksGuidanceForTests({
      repo: "acme/rocket",
      branch: "main",
      requiredChecks: ["ci"],
      missingChecks: ["ci"],
      availableChecks: [],
    });

    expect(guidance).toContain("Repo: acme/rocket");
    expect(guidance).toContain("Branch: main");
    expect(guidance).toContain("Required checks: ci");
    expect(guidance).toContain("Available check contexts: (none)");
    expect(guidance).toContain("update repos[].requiredChecks");
  });

  test("decideBranchProtection returns ok/defer as expected", () => {
    expect(
      __decideBranchProtectionForTests({ requiredChecks: [], availableChecks: [] })
    ).toEqual({ kind: "ok", missingChecks: [] });

    expect(
      __decideBranchProtectionForTests({ requiredChecks: ["ci"], availableChecks: [] })
    ).toEqual({ kind: "defer", missingChecks: ["ci"] });

    expect(
      __decideBranchProtectionForTests({ requiredChecks: ["ci"], availableChecks: ["lint"] })
    ).toEqual({ kind: "defer", missingChecks: ["ci"] });
  });

  test("defers branch protection when check contexts are empty", async () => {
    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/commits/main/check-runs?per_page=100")) {
        return new Response(JSON.stringify(__buildCheckRunsResponse([])), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/commits/main/status?per_page=100")) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/branches/main/protection")) {
        throw new Error("Unexpected branch protection fetch");
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const warnMock = mock(() => {});
    const originalWarn = console.warn;
    const originalFetch = globalThis.fetch;
    console.warn = warnMock as any;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp", {
        session: {
          runAgent: mock(async () => ({ sessionId: "", success: true, output: "" })) as any,
          continueSession: mock(async () => ({ sessionId: "" })) as any,
          continueCommand: mock(async () => ({ stdout: "" })) as any,
          getRalphXdgCacheHome: mock(() => "/tmp") as any,
        },
        queue: { updateTaskStatus: mock(async () => ({ ok: true })) as any },
        notify: {
          notifyEscalation: mock(async () => {}) as any,
          notifyError: mock(async () => {}) as any,
          notifyTaskComplete: mock(async () => {}) as any,
        },
        throttle: { getThrottleDecision: mock(async () => ({ shouldThrottle: false })) as any },
      });

      const result = await (worker as any).ensureBranchProtectionForBranch("main", ["ci"]);
      expect(result).toBe("defer");
      expect(warnMock).toHaveBeenCalled();
      const warnCalls = (warnMock as any).mock.calls as unknown[][];
      const message = String(warnCalls[0]?.[0] ?? "");
      expect(message).toContain("RALPH_BRANCH_PROTECTION_SKIPPED_MISSING_CHECKS");
      expect(message).toContain("acme/rocket@main");
      expect(message).toContain("Required checks: ci");
      expect(message).toContain("Available check contexts: (none)");
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  test("warns when required checks missing but contexts exist", async () => {
    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/commits/main/check-runs?per_page=100")) {
        return new Response(JSON.stringify(__buildCheckRunsResponse(["lint"])), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/commits/main/status?per_page=100")) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/branches/main/protection")) {
        throw new Error("Unexpected branch protection fetch");
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const warnMock = mock(() => {});
    const originalWarn = console.warn;
    const originalFetch = globalThis.fetch;
    console.warn = warnMock as any;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp", {
        session: {
          runAgent: mock(async () => ({ sessionId: "", success: true, output: "" })) as any,
          continueSession: mock(async () => ({ sessionId: "" })) as any,
          continueCommand: mock(async () => ({ stdout: "" })) as any,
          getRalphXdgCacheHome: mock(() => "/tmp") as any,
        },
        queue: { updateTaskStatus: mock(async () => ({ ok: true })) as any },
        notify: {
          notifyEscalation: mock(async () => {}) as any,
          notifyError: mock(async () => {}) as any,
          notifyTaskComplete: mock(async () => {}) as any,
        },
        throttle: { getThrottleDecision: mock(async () => ({ shouldThrottle: false })) as any },
      });

      await expect((worker as any).ensureBranchProtectionForBranch("main", ["ci"])).resolves.toBe("defer");
      expect(warnMock).toHaveBeenCalled();
      const warnCalls = (warnMock as any).mock.calls as unknown[][];
      const message = String(warnCalls[0]?.[0] ?? "");
      expect(message).toContain("RALPH_BRANCH_PROTECTION_SKIPPED_MISSING_CHECKS");
      expect(message).toContain("acme/rocket@main");
      expect(message).toContain("Required checks: ci");
      expect(message).toContain("Available check contexts: lint");
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when check context fetch fails", async () => {
    process.env.GH_TOKEN = "test-token";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/repos/acme/rocket/commits/main/check-runs?per_page=100")) {
        throw new Error("HTTP 403");
      }

      if (url.endsWith("/repos/acme/rocket/commits/main/status?per_page=100")) {
        throw new Error("HTTP 403");
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const worker = new RepoWorker("acme/rocket", "/tmp", {
        session: {
          runAgent: mock(async () => ({ sessionId: "", success: true, output: "" })) as any,
          continueSession: mock(async () => ({ sessionId: "" })) as any,
          continueCommand: mock(async () => ({ stdout: "" })) as any,
          getRalphXdgCacheHome: mock(() => "/tmp") as any,
        },
        queue: { updateTaskStatus: mock(async () => ({ ok: true })) as any },
        notify: {
          notifyEscalation: mock(async () => {}) as any,
          notifyError: mock(async () => {}) as any,
          notifyTaskComplete: mock(async () => {}) as any,
        },
        throttle: { getThrottleDecision: mock(async () => ({ shouldThrottle: false })) as any },
      });

      await expect((worker as any).ensureBranchProtectionForBranch("main", ["ci"])).rejects.toThrow(
        "Unable to read check contexts"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries branch protection after defer cooldown", async () => {
    let homeDir: string | null = null;
    let priorHome: string | undefined;
    let priorGhToken: string | undefined;
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let nowMs = 1_000_000;
    Date.now = () => nowMs;

    try {
      priorHome = process.env.HOME;
      priorGhToken = process.env.GH_TOKEN;
      homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
      process.env.HOME = homeDir;
      process.env.GH_TOKEN = "test-token";
      __resetConfigForTests();

      await writeJson(getRalphConfigJsonPath(), {
        repos: [{ name: "acme/rocket", botBranch: "main", requiredChecks: ["ci"] }],
      });

      let checkRunCalls = 0;
      const fetchMock = mock(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/repos/acme/rocket")) {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
        }

        if (url.endsWith("/repos/acme/rocket/git/ref/heads/main")) {
          return new Response(JSON.stringify(__buildGitRefResponse(__TEST_ONLY_DEFAULT_SHA)), { status: 200 });
        }

        if (url.endsWith("/repos/acme/rocket/commits/main/check-runs?per_page=100")) {
          checkRunCalls += 1;
          if (checkRunCalls === 1) {
            return new Response(JSON.stringify(__buildCheckRunsResponse([])), { status: 200 });
          }
          return new Response(JSON.stringify(__buildCheckRunsResponse(["ci"])), { status: 200 });
        }

        if (url.endsWith("/repos/acme/rocket/commits/main/status?per_page=100")) {
          return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
        }

        if (url.endsWith("/repos/acme/rocket/branches/main/protection")) {
          if (init?.method === "PUT") {
            return new Response(JSON.stringify({}), { status: 200 });
          }
          return new Response("Not Found", { status: 404 });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      });

      globalThis.fetch = fetchMock as any;

      const worker = new RepoWorker("acme/rocket", "/tmp", {
        session: {
          runAgent: mock(async () => ({ sessionId: "", success: true, output: "" })) as any,
          continueSession: mock(async () => ({ sessionId: "" })) as any,
          continueCommand: mock(async () => ({ stdout: "" })) as any,
          getRalphXdgCacheHome: mock(() => "/tmp") as any,
        },
        queue: { updateTaskStatus: mock(async () => ({ ok: true })) as any },
        notify: {
          notifyEscalation: mock(async () => {}) as any,
          notifyError: mock(async () => {}) as any,
          notifyTaskComplete: mock(async () => {}) as any,
        },
        throttle: { getThrottleDecision: mock(async () => ({ shouldThrottle: false })) as any },
      });

      await (worker as any).ensureBranchProtectionOnce();

      nowMs += 60_000 + 1;
      await (worker as any).ensureBranchProtectionOnce();

      const putCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
        const [url, init] = call as [string, RequestInit | undefined];
        return String(url).endsWith("/repos/acme/rocket/branches/main/protection") && init?.method === "PUT";
      });
      expect(putCalls.length).toBe(1);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      if (priorHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = priorHome;
      }
      if (priorGhToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = priorGhToken;
      }
      if (homeDir) {
        await rm(homeDir, { recursive: true, force: true });
      }
      __resetConfigForTests();
    }
  });

  test("creates missing bot branch before checks", async () => {
    let sawProtectionPut = false;
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/repos/acme/rocket")) {
        return new Response(JSON.stringify(__buildRepoDefaultBranchResponse()), { status: 200 });
      }

      if (url.endsWith(`/repos/acme/rocket/git/ref/heads/${__TEST_ONLY_DEFAULT_BRANCH}`)) {
        return new Response(JSON.stringify(__buildGitRefResponse(__TEST_ONLY_DEFAULT_SHA)), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/git/ref/heads/bot/integration")) {
        return new Response("Not Found", { status: 404 });
      }

      if (url.endsWith("/repos/acme/rocket/git/refs")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toEqual({ ref: "refs/heads/bot/integration", sha: __TEST_ONLY_DEFAULT_SHA });
        return new Response("", { status: 201 });
      }

      if (url.endsWith("/repos/acme/rocket/commits/bot%2Fintegration/check-runs?per_page=100")) {
        return new Response(JSON.stringify(__buildCheckRunsResponse(["ci"])), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/commits/bot%2Fintegration/status?per_page=100")) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }

      if (url.endsWith("/repos/acme/rocket/branches/bot%2Fintegration/protection")) {
        if (init?.method === "PUT") {
          sawProtectionPut = true;
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const worker = new RepoWorker("acme/rocket", "/tmp", {
      session: {
        runAgent: mock(async () => ({ sessionId: "", success: true, output: "" })) as any,
        continueSession: mock(async () => ({ sessionId: "" })) as any,
        continueCommand: mock(async () => ({ stdout: "" })) as any,
        getRalphXdgCacheHome: mock(() => "/tmp") as any,
      },
      queue: { updateTaskStatus: mock(async () => ({ ok: true })) as any },
      notify: {
        notifyEscalation: mock(async () => {}) as any,
        notifyError: mock(async () => {}) as any,
        notifyTaskComplete: mock(async () => {}) as any,
      },
      throttle: { getThrottleDecision: mock(async () => ({ shouldThrottle: false })) as any },
    });

    process.env.GH_TOKEN = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      await (worker as any).ensureBranchProtectionForBranch("bot/integration", ["ci"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalled();
    expect(sawProtectionPut).toBe(true);
  });
});
