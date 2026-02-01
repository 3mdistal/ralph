import { describe, expect, test } from "bun:test";

import {
  buildStatusUsageRow,
  collectStatusUsageRows,
  formatStatusUsageSection,
} from "../status-usage";
import type { ThrottleDecision, ThrottleSnapshot, ThrottleWindowSnapshot } from "../throttle";

function baseWindow(name: string): ThrottleWindowSnapshot {
  return {
    name,
    windowMs: 1000,
    budgetTokens: 100,
    softCapTokens: 65,
    hardCapTokens: 75,
    usedTokens: 10,
    usedPct: 0.1,
    oldestTsInWindow: null,
    resumeAtTs: null,
  };
}

function baseSnapshot(overrides: Partial<ThrottleSnapshot> = {}): ThrottleSnapshot {
  return {
    computedAt: new Date().toISOString(),
    providerID: "openai",
    openaiSource: "localLogs",
    remoteUsage: undefined,
    remoteUsageError: null,
    opencodeProfile: "p1",
    xdgDataHome: "/tmp",
    messagesRootDir: "/tmp",
    authFilePath: "/tmp/auth.json",
    authFileExists: false,
    messagesRootDirExists: true,
    scannedSessionDirs: 1,
    scannedFiles: 1,
    parsedFiles: 1,
    newestMessageTs: null,
    newestMessageAt: null,
    newestCountedEventTs: Date.now(),
    state: "ok",
    resumeAt: null,
    windows: [baseWindow("rolling5h"), baseWindow("weekly")],
    ...overrides,
  };
}

function makeDecision(snapshot: ThrottleSnapshot): ThrottleDecision {
  return { state: snapshot.state, resumeAtTs: null, snapshot };
}

describe("status usage mapping", () => {
  test("orders active profile first", async () => {
    const activeSnapshot = baseSnapshot({ opencodeProfile: "a" });
    const activeDecision = makeDecision(activeSnapshot);
    const otherDecision = makeDecision(baseSnapshot({ opencodeProfile: "b" }));

    const rows = await collectStatusUsageRows({
      profiles: ["b", "a"],
      activeProfile: "a",
      activeDecision,
      decide: async (profileKey: string | null) => (profileKey === "b" ? otherDecision : activeDecision),
      concurrency: 1,
      timeoutMs: 50,
    });

    expect(rows[0]?.profileKey).toBe("a");
    expect(rows[1]?.profileKey).toBe("b");
  });

  test("renders remote usage windows", () => {
    const snapshot = baseSnapshot({
      openaiSource: "remoteUsage",
      remoteUsage: {
        fetchedAt: new Date().toISOString(),
        planType: "Pro",
        rolling5h: { usedPct: 0.5, resetAt: "2026-01-26T00:00:00.000Z", resetAtTs: null, usedPercentRaw: 50 },
        weekly: { usedPct: 0.1, resetAt: "2026-02-01T00:00:00.000Z", resetAtTs: null, usedPercentRaw: 10 },
      },
    });

    const row = buildStatusUsageRow("p1", makeDecision(snapshot));
    const lines = formatStatusUsageSection([row]).join("\n");

    expect(lines).toContain("source=remoteUsage");
    expect(lines).toContain("rolling5h: usedPct=50.0%");
    expect(lines).toContain("weekly: usedPct=10.0%");
  });

  test("renders local logs fallback and remoteUsageError", () => {
    const snapshot = baseSnapshot({
      openaiSource: "remoteUsage",
      remoteUsage: undefined,
      remoteUsageError: "remote down",
    });

    const row = buildStatusUsageRow("p1", makeDecision(snapshot));
    const lines = formatStatusUsageSection([row]).join("\n");

    expect(lines).toContain("source=localLogs");
    expect(lines).toContain("remoteUsageError=remote down");
  });

  test("redacts sensitive tokens in remoteUsageError", () => {
    const snapshot = baseSnapshot({
      openaiSource: "remoteUsage",
      remoteUsage: undefined,
      remoteUsageError: "Bearer sk-1234567890123456789012345",
    });

    const row = buildStatusUsageRow("p1", makeDecision(snapshot));
    expect(row.remoteUsageError).not.toContain("sk-");
  });

  test("shows no data when logs are missing", () => {
    const snapshot = baseSnapshot({
      messagesRootDirExists: false,
      scannedFiles: 0,
      parsedFiles: 0,
      newestCountedEventTs: null,
    });

    const row = buildStatusUsageRow("ambient", makeDecision(snapshot));
    const lines = formatStatusUsageSection([row]).join("\n");

    expect(lines).toContain("no data / 0 usage");
  });

  test("times out slow profiles without throwing", async () => {
    const rows = await collectStatusUsageRows({
      profiles: ["slow"],
      activeProfile: null,
      decide: async () => new Promise<ThrottleDecision>(() => {}),
      concurrency: 1,
      timeoutMs: 5,
    });

    expect(rows[0]?.dataQuality).toBe("none");
    expect(rows[0]?.remoteUsageError).toContain("Timeout");
  });
});
