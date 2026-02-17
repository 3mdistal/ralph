import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createConfiguredSessionAdapter } from "../opencode/session-adapter-factory";
import type { SessionResult } from "../session";

describe("configured session adapter", () => {
  const priorMode = process.env.RALPH_OPENCODE_TRANSPORT;

  beforeEach(() => {
    process.env.RALPH_OPENCODE_TRANSPORT = "sdk-preferred";
  });

  afterEach(() => {
    if (priorMode === undefined) delete process.env.RALPH_OPENCODE_TRANSPORT;
    else process.env.RALPH_OPENCODE_TRANSPORT = priorMode;
  });

  test("sdk-preferred falls back to cli once and sticks to cli for run key", async () => {
    const cliCalls: string[] = [];
    const cliResult: SessionResult = { sessionId: "s-cli", output: "ok", success: true };
    const cli = {
      runAgent: async (_repoPath: string) => {
        cliCalls.push("runAgent");
        return cliResult;
      },
      continueSession: async (_repoPath: string, _sessionId: string) => {
        cliCalls.push("continueSession");
        return cliResult;
      },
      continueCommand: async (_repoPath: string, _sessionId: string) => {
        cliCalls.push("continueCommand");
        return cliResult;
      },
      getRalphXdgCacheHome: () => "/tmp/cache",
    };

    const adapter = createConfiguredSessionAdapter(cli as any);

    const warnings: string[] = [];
    const priorWarn = console.warn;
    console.warn = (message?: any) => {
      warnings.push(String(message ?? ""));
    };

    try {
      const first = await adapter.runAgent("/definitely/missing", "build", "hello", { cacheKey: "396" });
      const second = await adapter.runAgent("/definitely/missing", "build", "hello again", { cacheKey: "396" });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(cliCalls).toEqual(["runAgent", "runAgent"]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("falling back to CLI");
    } finally {
      console.warn = priorWarn;
    }
  });
});
