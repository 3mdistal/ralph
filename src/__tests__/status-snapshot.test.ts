import { describe, expect, test } from "bun:test";

import { buildStatusSnapshot } from "../status-snapshot";

describe("buildStatusSnapshot", () => {
  test("normalizes optional blocked/throttled fields", () => {
    const snapshot = buildStatusSnapshot({
      mode: "running",
      queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
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

  test("preserves in-progress token fields", () => {
    const snapshot = buildStatusSnapshot({
      mode: "running",
      desiredMode: " running ",
      queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
      daemon: null,
      daemonLiveness: {
        state: "missing",
        mismatch: true,
        hint: "  mismatch  ",
        pid: null,
        daemonId: "  ",
      },
      controlProfile: null,
      activeProfile: null,
      throttle: { state: "ok" },
      escalations: { pending: 0 },
      inProgress: [
        {
          name: "Task C",
          repo: "3mdistal/ralph",
          issue: "3mdistal/ralph#3",
          priority: "p2-medium",
          opencodeProfile: null,
          sessionId: null,
          nowDoing: null,
          line: null,
          tokensTotal: 42,
          tokensComplete: true,
        },
      ],
      starting: [],
      queued: [],
      throttled: [],
      blocked: [],
      drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
    });

    expect(snapshot.inProgress[0]?.tokensTotal).toBe(42);
    expect(snapshot.inProgress[0]?.tokensComplete).toBe(true);
    expect(snapshot.desiredMode).toBe("running");
    expect(snapshot.daemonLiveness?.hint).toBe("mismatch");
    expect(snapshot.daemonLiveness?.daemonId).toBeNull();
  });

  test("normalizes onboarding payload", () => {
    const snapshot = buildStatusSnapshot({
      mode: "running",
      queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
      daemon: null,
      controlProfile: null,
      activeProfile: null,
      throttle: { state: "ok" },
      escalations: { pending: 0 },
      inProgress: [],
      starting: [],
      queued: [],
      throttled: [],
      blocked: [],
      drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
      onboarding: {
        version: 1,
        repos: [
          {
            repo: " 3mdistal/ralph ",
            status: "warn",
            checks: [
              {
                checkId: " repo.access ",
                title: " Repo access ",
                critical: true,
                status: "pass",
                reason: " ok ",
                remediation: ["  retry  ", ""],
              },
            ],
          },
        ],
      },
    });

    expect(snapshot.onboarding?.repos[0]?.repo).toBe("3mdistal/ralph");
    expect(snapshot.onboarding?.repos[0]?.checks[0]?.checkId).toBe("repo.access");
    expect(snapshot.onboarding?.repos[0]?.checks[0]?.title).toBe("Repo access");
    expect(snapshot.onboarding?.repos[0]?.checks[0]?.reason).toBe("ok");
    expect(snapshot.onboarding?.repos[0]?.checks[0]?.remediation).toEqual(["retry"]);
  });
});
