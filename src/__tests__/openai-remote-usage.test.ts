import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { __clearRemoteOpenaiUsageCacheForTests, getRemoteOpenaiUsage } from "../openai-remote-usage";

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("openai remote usage", () => {
  test("parses rate_limit primary/secondary windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-openai-remote-usage-"));
    const authPath = join(root, "opencode", "auth.json");
    const now = Date.parse("2026-01-24T12:00:00Z");

    const priorFetch = globalThis.fetch;
    __clearRemoteOpenaiUsageCacheForTests();

    try {
      await writeJson(authPath, {
        openai: {
          type: "oauth",
          access: "tok_access",
          refresh: "tok_refresh",
          expires: now + 30 * 60_000,
        },
      });

      const fetchMock = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/backend-api/wham/usage")) {
          return new Response(
            JSON.stringify({
              planType: "pro",
              rate_limit: {
                primary_window: { used_percent: 12.5, reset_at: 1769307600 },
                secondary_window: { used_percent: 50, reset_at: 1769817600 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("unexpected", { status: 500 });
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const usage = await getRemoteOpenaiUsage({ authFilePath: authPath, now, skipCache: true });
      expect(usage.planType).toBe("pro");
      // 12.5% => 0.125
      expect(usage.rolling5h.usedPct).toBeCloseTo(0.125, 6);
      // 50% => 0.5
      expect(usage.weekly.usedPct).toBeCloseTo(0.5, 6);
      expect(typeof usage.rolling5h.resetAt).toBe("string");
      expect(typeof usage.weekly.resetAt).toBe("string");
    } finally {
      globalThis.fetch = priorFetch;
      await rm(root, { recursive: true, force: true });
      __clearRemoteOpenaiUsageCacheForTests();
    }
  });

  test("fetches usage and normalizes usedPct/resetAt", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-openai-remote-usage-"));
    const authPath = join(root, "opencode", "auth.json");
    const now = Date.parse("2026-01-24T12:00:00Z");

    const priorFetch = globalThis.fetch;
    __clearRemoteOpenaiUsageCacheForTests();

    try {
      await writeJson(authPath, {
        openai: {
          type: "oauth",
          access: "tok_access",
          refresh: "tok_refresh",
          expires: now + 30 * 60_000,
        },
      });

      const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/backend-api/wham/usage")) {
          const auth = (init?.headers as any)?.Authorization ?? (init?.headers as any)?.authorization;
          if (auth !== "Bearer tok_access") {
            return new Response("bad auth", { status: 401 });
          }
          return new Response(
            JSON.stringify({
              planType: "Pro",
              usage_breakdown: {
                rolling: { used_percent: 0.12, reset_at: "2026-01-24T13:00:00Z" },
                weekly: { used_percent: 52, reset_at: "2026-01-30T00:00:00Z" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/oauth/token")) {
          return new Response("unexpected refresh", { status: 500 });
        }
        return new Response("unexpected", { status: 500 });
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const usage = await getRemoteOpenaiUsage({ authFilePath: authPath, now, skipCache: true });
      expect(usage.planType).toBe("Pro");
      expect(usage.rolling5h.usedPct).toBeCloseTo(0.12, 6);
      // Weekly input is 52, normalize from 0..100 => 0.52
      expect(usage.weekly.usedPct).toBeCloseTo(0.52, 6);
      expect(usage.rolling5h.resetAt).toBe("2026-01-24T13:00:00.000Z");
      expect(usage.weekly.resetAt).toBe("2026-01-30T00:00:00.000Z");
    } finally {
      globalThis.fetch = priorFetch;
      await rm(root, { recursive: true, force: true });
      __clearRemoteOpenaiUsageCacheForTests();
    }
  });

  test("refreshes expired token and writes back", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-openai-remote-usage-"));
    const authPath = join(root, "opencode", "auth.json");
    const now = Date.parse("2026-01-24T12:00:00Z");

    const priorFetch = globalThis.fetch;
    __clearRemoteOpenaiUsageCacheForTests();

    try {
      await writeJson(authPath, {
        openai: {
          type: "oauth",
          access: "tok_old",
          refresh: "tok_refresh",
          expires: now - 60_000,
        },
      });

      let sawRefresh = false;
      let sawUsageAuth = "";

      const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          sawRefresh = true;
          return new Response(
            JSON.stringify({
              access_token: "tok_new",
              refresh_token: "tok_new_refresh",
              expires_in: 3600,
              token_type: "bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/backend-api/wham/usage")) {
          const auth = (init?.headers as any)?.Authorization ?? (init?.headers as any)?.authorization;
          sawUsageAuth = String(auth ?? "");
          return new Response(
            JSON.stringify({
              planType: "Pro",
              usage_breakdown: {
                rolling: { used_percent: 0.1, reset_at: "2026-01-24T13:00:00Z" },
                weekly: { used_percent: 0.2, reset_at: "2026-01-30T00:00:00Z" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("unexpected", { status: 500 });
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await getRemoteOpenaiUsage({ authFilePath: authPath, now, skipCache: true });
      expect(sawRefresh).toBe(true);
      expect(sawUsageAuth).toBe("Bearer tok_new");

      const persisted = JSON.parse(await readFile(authPath, "utf8"));
      expect(persisted.openai.access).toBe("tok_new");
      expect(persisted.openai.refresh).toBe("tok_new_refresh");
      expect(typeof persisted.openai.expires).toBe("number");
      expect(persisted.openai.expires).toBeGreaterThan(now);
    } finally {
      globalThis.fetch = priorFetch;
      await rm(root, { recursive: true, force: true });
      __clearRemoteOpenaiUsageCacheForTests();
    }
  });

  test("dedupes in-flight fetches", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-openai-remote-usage-"));
    const authPath = join(root, "opencode", "auth.json");
    const now = Date.parse("2026-01-24T12:00:00Z");

    const priorFetch = globalThis.fetch;
    __clearRemoteOpenaiUsageCacheForTests();

    try {
      await writeJson(authPath, {
        openai: {
          type: "oauth",
          access: "tok_access",
          refresh: "tok_refresh",
          expires: now + 30 * 60_000,
        },
      });

      let usageCalls = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const fetchMock = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/backend-api/wham/usage")) {
          usageCalls++;
          await gate;
          return new Response(
            JSON.stringify({
              planType: "Pro",
              usage_breakdown: {
                rolling: { used_percent: 0.1, reset_at: "2026-01-24T13:00:00Z" },
                weekly: { used_percent: 0.2, reset_at: "2026-01-30T00:00:00Z" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/oauth/token")) return new Response("unexpected", { status: 500 });
        return new Response("unexpected", { status: 500 });
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const p1 = getRemoteOpenaiUsage({ authFilePath: authPath, now, cacheTtlMs: 0 });
      const p2 = getRemoteOpenaiUsage({ authFilePath: authPath, now, cacheTtlMs: 0 });

      // Let both reach the in-flight dedupe.
      await new Promise((r) => setTimeout(r, 10));
      release?.();

      const [u1, u2] = await Promise.all([p1, p2]);
      expect(u1.planType).toBe("Pro");
      expect(u2.planType).toBe("Pro");
      expect(usageCalls).toBe(1);
    } finally {
      globalThis.fetch = priorFetch;
      await rm(root, { recursive: true, force: true });
      __clearRemoteOpenaiUsageCacheForTests();
    }
  });
});
