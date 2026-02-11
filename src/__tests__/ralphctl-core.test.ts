import { describe, expect, test } from "bun:test";

import {
  getResumptionVerificationSkipReason,
  isSnapshotDrained,
  shouldUseGraceDrainFallback,
} from "../ralphctl-core";
import type { StatusSnapshot } from "../status-snapshot";

function makeSnapshot(overrides?: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    mode: "running",
    queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
    daemon: null,
    controlProfile: null,
    activeProfile: null,
    throttle: {},
    escalations: { pending: 0 },
    inProgress: [],
    starting: [],
    queued: [],
    throttled: [],
    blocked: [],
    drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
    ...overrides,
  };
}

describe("ralphctl core helpers", () => {
  test("uses grace drain fallback when durable state is degraded", () => {
    const degraded = makeSnapshot({ durableState: { ok: false, code: "forward_incompatible" } });
    expect(shouldUseGraceDrainFallback(degraded)).toBeTrue();
  });

  test("detects drained snapshots from task arrays", () => {
    expect(isSnapshotDrained(makeSnapshot())).toBeTrue();
    expect(
      isSnapshotDrained(
        makeSnapshot({
          inProgress: [
            {
              repo: "r",
              issue: "r#1",
              name: "n",
              priority: "p2",
              opencodeProfile: null,
              sessionId: null,
              nowDoing: null,
              line: null,
            },
          ],
        })
      )
    ).toBeFalse();
  });

  test("skips resumption verification when either side is degraded", () => {
    const healthy = makeSnapshot();
    const degradedBefore = makeSnapshot({ durableState: { ok: false, code: "forward_incompatible" } });
    const degradedAfter = makeSnapshot({ durableState: { ok: false, code: "lock_timeout" } });
    expect(getResumptionVerificationSkipReason(degradedBefore, healthy)).toContain("before restart");
    expect(getResumptionVerificationSkipReason(healthy, degradedAfter)).toContain("after restart");
    expect(getResumptionVerificationSkipReason(healthy, healthy)).toBeNull();
  });
});
