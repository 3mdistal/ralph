import { describe, expect, test } from "bun:test";

import {
  buildWaitingResolutionUpdate,
  DEFAULT_RESOLUTION_RECHECK_INTERVAL_MS,
  shouldDeferWaitingResolutionCheck,
} from "../escalation-resume";

describe("escalation resume policy", () => {
  test("defers checks for waiting-resolution within the recheck interval", () => {
    const nowMs = Date.now();
    const deferredAt = new Date(nowMs - Math.floor(DEFAULT_RESOLUTION_RECHECK_INTERVAL_MS / 2)).toISOString();

    expect(
      shouldDeferWaitingResolutionCheck(
        {
          "resume-status": "waiting-resolution",
          "resume-deferred-at": deferredAt,
        } as any,
        nowMs
      )
    ).toBe(true);
  });

  test("does not defer when deferred-at is missing/invalid", () => {
    const nowMs = Date.now();

    expect(
      shouldDeferWaitingResolutionCheck(
        {
          "resume-status": "waiting-resolution",
          "resume-deferred-at": "not-a-date",
        } as any,
        nowMs
      )
    ).toBe(false);

    expect(
      shouldDeferWaitingResolutionCheck(
        {
          "resume-status": "waiting-resolution",
          "resume-deferred-at": "",
        } as any,
        nowMs
      )
    ).toBe(false);
  });

  test("does not defer for other resume-status values", () => {
    expect(shouldDeferWaitingResolutionCheck({ "resume-status": "failed" } as any, Date.now())).toBe(false);
  });

  test("waiting-resolution update never marks attempted", () => {
    const fields = buildWaitingResolutionUpdate("2026-01-10T00:00:00Z", "needs resolution");
    expect(fields["resume-status"]).toBe("waiting-resolution");
    expect(fields["resume-deferred-at"]).toBe("2026-01-10T00:00:00Z");
    expect(fields["resume-error"]).toBe("needs resolution");
    expect(fields["resume-attempted-at"]).toBeUndefined();
  });
});
