import { describe, expect, test } from "bun:test";

import { buildStatusSnapshot } from "../status-snapshot";

describe("buildStatusSnapshot", () => {
  test("normalizes optional blocked/throttled fields", () => {
    const snapshot = buildStatusSnapshot({
      mode: "running",
      queue: { backend: "bwrb", health: "ok", fallback: false, diagnostics: null },
      daemon: null,
      controlProfile: null,
      activeProfile: null,
      throttle: { state: "ok" },
      escalations: { pending: 0 },
      inProgress: [],
      starting: [],
      queued: [],
      throttled: [
        {
          name: "Task A",
          repo: "3mdistal/ralph",
          issue: "3mdistal/ralph#1",
          priority: "p2-medium",
          opencodeProfile: null,
          sessionId: "",
          resumeAt: "",
        },
      ],
      blocked: [
        {
          name: "Task B",
          repo: "3mdistal/ralph",
          issue: "3mdistal/ralph#2",
          priority: "p2-medium",
          opencodeProfile: null,
          sessionId: "",
          blockedAt: "",
          blockedSource: "",
          blockedReason: "",
          blockedDetailsSnippet: "",
        },
      ],
      drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
    });

    expect(snapshot.throttled[0]?.sessionId).toBeNull();
    expect(snapshot.throttled[0]?.resumeAt).toBeNull();
    expect(snapshot.blocked[0]?.sessionId).toBeNull();
    expect(snapshot.blocked[0]?.blockedAt).toBeNull();
    expect(snapshot.blocked[0]?.blockedSource).toBeNull();
    expect(snapshot.blocked[0]?.blockedReason).toBeNull();
    expect(snapshot.blocked[0]?.blockedDetailsSnippet).toBeNull();
  });
});
