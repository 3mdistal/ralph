import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (must be declared before importing module under test) ---

const listOpencodeProfileNamesMock = mock(() => ["apple", "google"]);

mock.module("../config", () => ({
  listOpencodeProfileNames: listOpencodeProfileNamesMock,
}));

type GetThrottleArgs = { opencodeProfile?: string | null };

const defaultGetThrottleDecisionImpl = async (now: number, opts?: GetThrottleArgs) => {
  const name = (opts?.opencodeProfile ?? "").trim();

  const mk = (args: {
    state: "ok" | "soft" | "hard";
    nextResetTs: number;
    weeklyHardCapTokens: number;
    weeklyUsedTokens: number;
    rolling5hHardCapTokens: number;
    rolling5hUsedTokens: number;
  }) => ({
    state: args.state,
    resumeAtTs: null,
    snapshot: {
      computedAt: new Date(now).toISOString(),
      providerID: "openai",
      state: args.state,
      resumeAt: null,
      windows: [
        {
          name: "rolling5h",
          hardCapTokens: args.rolling5hHardCapTokens,
          usedTokens: args.rolling5hUsedTokens,
        },
        {
          name: "weekly",
          hardCapTokens: args.weeklyHardCapTokens,
          usedTokens: args.weeklyUsedTokens,
          weeklyNextResetTs: args.nextResetTs,
          windowEndTs: args.nextResetTs,
        },
      ],
    },
  });

  if (name === "google") {
    // Sooner reset, healthy remaining.
    return mk({
      state: "ok",
      nextResetTs: now + 2 * 24 * 60 * 60 * 1000,
      weeklyHardCapTokens: 1000,
      weeklyUsedTokens: 100,
      rolling5hHardCapTokens: 200,
      rolling5hUsedTokens: 50,
    });
  }

  // Later reset, also healthy remaining.
  return mk({
    state: "ok",
    nextResetTs: now + 5 * 24 * 60 * 60 * 1000,
    weeklyHardCapTokens: 1000,
    weeklyUsedTokens: 100,
    rolling5hHardCapTokens: 200,
    rolling5hUsedTokens: 50,
  });
};

const getThrottleDecisionMock = mock(defaultGetThrottleDecisionImpl);

mock.module("../throttle", () => ({
  getThrottleDecision: getThrottleDecisionMock,
}));

import { __resetAutoOpencodeProfileSelectionForTests, resolveAutoOpencodeProfileName } from "../opencode-auto-profile";

describe("auto opencode profile selection", () => {
  beforeEach(() => {
    __resetAutoOpencodeProfileSelectionForTests();
    listOpencodeProfileNamesMock.mockClear();
    getThrottleDecisionMock.mockClear();
    getThrottleDecisionMock.mockImplementation(defaultGetThrottleDecisionImpl);
  });

  test("prefers the profile whose reset is sooner when it has meaningful remaining", async () => {
    const now = Date.parse("2026-01-13T12:00:00Z");
    const chosen = await resolveAutoOpencodeProfileName(now);
    expect(chosen).toBe("google");
  });

  test("does not chase sooner reset when that profile is nearly depleted", async () => {
    const now = Date.parse("2026-01-13T12:00:00Z");

    getThrottleDecisionMock.mockImplementation(async (_now: number, opts?: GetThrottleArgs) => {
      const name = (opts?.opencodeProfile ?? "").trim();

      if (name === "google") {
        return {
          state: "ok",
          resumeAtTs: null,
          snapshot: {
            computedAt: new Date(_now).toISOString(),
            providerID: "openai",
            state: "ok",
            resumeAt: null,
            windows: [
              { name: "rolling5h", hardCapTokens: 200, usedTokens: 50 },
              // Only 1% remaining to hard cap.
              { name: "weekly", hardCapTokens: 1000, usedTokens: 990, weeklyNextResetTs: _now + 2 * 86400000, windowEndTs: _now + 2 * 86400000 },
            ],
          },
        } as any;
      }

      return defaultGetThrottleDecisionImpl(_now, opts);
    });

    const chosen = await resolveAutoOpencodeProfileName(now);
    expect(chosen).toBe("apple");
  });
});
