import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorFetch: typeof fetch | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

async function writeMsg(opts: { root: string; session: string; file: string; createdAt: number; tokens: number }): Promise<void> {
  const dir = join(opts.root, opts.session);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, opts.file),
    JSON.stringify({
      providerID: "openai",
      role: "assistant",
      time: { created: opts.createdAt },
      tokens: { input: opts.tokens, output: 0, reasoning: 0 },
    }),
    "utf8"
  );
}

describe("throttle openai remoteUsage source", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorFetch = globalThis.fetch;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    __resetConfigForTests();
  });

  afterEach(async () => {
    if (priorFetch) globalThis.fetch = priorFetch;
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("uses remote usage meters when enabled", async () => {
    const xdgDataHome = await mkdtemp(join(tmpdir(), "ralph-xdg-"));
    const authPath = join(xdgDataHome, "opencode", "auth.json");
    const now = Date.parse("2026-01-24T12:00:00Z");
    await writeJson(authPath, {
      openai: { type: "oauth", access: "tok_access", refresh: "tok_refresh", expires: now + 10 * 3600_000 },
    });

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      opencode: {
        enabled: true,
        profiles: {
          p1: { xdgDataHome, xdgConfigHome: xdgDataHome, xdgStateHome: xdgDataHome },
        },
      },
      throttle: {
        enabled: true,
        providerID: "openai",
        openaiSource: "remoteUsage",
        minCheckIntervalMs: 0,
      },
    });
    __resetConfigForTests();

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/backend-api/wham/usage")) {
        return new Response(
          JSON.stringify({
            planType: "Pro",
            usage_breakdown: {
              rolling: { used_percent: 0.8, reset_at: "2026-01-24T13:00:00Z" },
              weekly: { used_percent: 0.1, reset_at: "2026-01-30T00:00:00Z" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/oauth/token")) return new Response("unexpected", { status: 500 });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { getThrottleDecision } = await import(`../throttle?remote-openai-source-${Math.random()}`);
    const decision = await getThrottleDecision(now, { opencodeProfile: "p1" });
    expect(decision.snapshot.openaiSource).toBe("remoteUsage");
    expect(decision.snapshot.remoteUsage?.planType).toBe("Pro");
    const rolling = (decision.snapshot.windows as any[]).find((w) => w.name === "rolling5h");
    expect(rolling.usedPct).toBeCloseTo(0.8, 6);
  });

  test("falls back to local logs if remote usage fails", async () => {
    const xdgDataHome = await mkdtemp(join(tmpdir(), "ralph-xdg-"));
    const authPath = join(xdgDataHome, "opencode", "auth.json");
    const now = Date.parse("2026-01-24T12:00:00Z");
    await writeJson(authPath, {
      openai: { type: "oauth", access: "tok_access", refresh: "tok_refresh", expires: now + 10 * 3600_000 },
    });

    const messagesRoot = join(xdgDataHome, "opencode", "storage", "message");
    await writeMsg({
      root: messagesRoot,
      session: "ses_a",
      file: "msg_1.json",
      createdAt: Date.parse("2026-01-24T11:30:00Z"),
      tokens: 100,
    });

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      opencode: {
        enabled: true,
        profiles: {
          p1: { xdgDataHome, xdgConfigHome: xdgDataHome, xdgStateHome: xdgDataHome },
        },
      },
      throttle: {
        enabled: true,
        providerID: "openai",
        openaiSource: "remoteUsage",
        minCheckIntervalMs: 0,
        windows: { rolling5h: { budgetTokens: 1000 }, weekly: { budgetTokens: 1000 } },
      },
    });
    __resetConfigForTests();

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/backend-api/wham/usage")) {
        return new Response("fail", { status: 500 });
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { getThrottleDecision } = await import(`../throttle?remote-openai-source-${Math.random()}`);
    const decision = await getThrottleDecision(now, { opencodeProfile: "p1" });
    expect(decision.snapshot.openaiSource).toBe("remoteUsage");
    expect(typeof decision.snapshot.remoteUsageError).toBe("string");

    const rolling = (decision.snapshot.windows as any[]).find((w) => w.name === "rolling5h");
    expect(rolling.usedTokens).toBe(100);
  });
});
