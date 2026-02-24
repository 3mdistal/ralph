import { describe, expect, test } from "bun:test";

import { buildFreshStartSessionResetPatch, shouldResetSessionForFreshStart } from "../scheduler/fresh-start-session-reset";

describe("fresh-start session reset", () => {
  test("resets stale session-id for profile-unresolvable fresh routing", () => {
    expect(
      shouldResetSessionForFreshStart({
        blockedSource: "profile-unresolvable",
        sessionId: "ses_123",
        queuedResumePath: "fresh",
      })
    ).toBe(true);
  });

  test("does not reset when there is no session id", () => {
    expect(
      shouldResetSessionForFreshStart({
        blockedSource: "profile-unresolvable",
        sessionId: "",
        queuedResumePath: "fresh",
      })
    ).toBe(false);
  });

  test("does not reset for non-profile-unresolvable fresh routing", () => {
    expect(
      shouldResetSessionForFreshStart({
        blockedSource: "runtime-error",
        sessionId: "ses_123",
        queuedResumePath: "fresh",
      })
    ).toBe(false);
  });

  test("builds deterministic reset patch", () => {
    expect(buildFreshStartSessionResetPatch()).toEqual({
      "session-id": "",
      "blocked-source": "",
      "blocked-reason": "",
      "blocked-details": "",
      "blocked-at": "",
      "blocked-checked-at": "",
    });
  });
});
