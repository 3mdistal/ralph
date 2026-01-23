import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __buildCheckRunsResponse,
  __buildGitRefResponse,
  __buildRepoDefaultBranchResponse,
  __formatRequiredChecksGuidanceForTests,
  __summarizeRequiredChecksForTests,
  __TEST_ONLY_DEFAULT_BRANCH,
  __TEST_ONLY_DEFAULT_SHA,
  RepoWorker,
} from "../worker";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let releaseLock: (() => void) | null = null;

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

  test("creates missing bot branch before checks", async () => {
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
  });
});
