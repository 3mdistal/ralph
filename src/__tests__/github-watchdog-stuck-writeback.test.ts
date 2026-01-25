import {
  buildWatchdogStuckMarker,
  extractExistingWatchdogMarker,
  planWatchdogStuckWriteback,
  writeWatchdogStuckToGitHub,
} from "../github/watchdog-stuck-writeback";

import type { WatchdogTimeoutInfo } from "../session";

describe("github watchdog stuck writeback", () => {
  const timeout: WatchdogTimeoutInfo = {
    kind: "watchdog-timeout",
    source: "tool-watchdog",
    toolName: "bash",
    callId: "call-1",
    elapsedMs: 120000,
    softMs: 30000,
    hardMs: 120000,
    lastProgressMsAgo: 120000,
    recentEvents: ["event-1"],
  };
  const signatureHash = "sig-1";

  test("buildWatchdogStuckMarker is deterministic", () => {
    const markerA = buildWatchdogStuckMarker({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      stage: "plan",
      retryIndex: 0,
      signatureHash,
      sessionId: "ses_1",
    });
    const markerB = buildWatchdogStuckMarker({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      stage: "plan",
      retryIndex: 0,
      signatureHash,
      sessionId: "ses_1",
    });
    const markerC = buildWatchdogStuckMarker({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      stage: "build",
      retryIndex: 0,
      signatureHash,
      sessionId: "ses_1",
    });

    expect(markerA).toBe(markerB);
    expect(markerA).not.toBe(markerC);
  });

  test("extractExistingWatchdogMarker parses marker id", () => {
    expect(extractExistingWatchdogMarker("<!-- ralph-watchdog-stuck:id=deadbeef -->")).toBe("deadbeef");
  });

  test("writeWatchdogStuckToGitHub posts once and records idempotency", async () => {
    const keys = new Set<string>();
    const postedBodies: string[] = [];

    const plan = planWatchdogStuckWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      taskName: "Watchdog stuck",
      taskPath: "orchestration/tasks/ralph 342.md",
      stage: "plan",
      retryIndex: 0,
      signatureHash,
      timeout,
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string; labels?: string[] } } = {}) => {
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/labels") && opts.method === "POST") {
          return { data: {} };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/342#issuecomment-1" } };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeWatchdogStuckToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 342,
        taskName: "Watchdog stuck",
        taskPath: "orchestration/tasks/ralph 342.md",
        stage: "plan",
        retryIndex: 0,
        signatureHash,
        timeout,
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
        },
        getIdempotencyPayload: () => null,
      }
    );

    expect(result.postedComment).toBe(true);
    expect(result.commentUrl).toBe("https://github.com/3mdistal/ralph/issues/342#issuecomment-1");
    expect(keys.has(plan.idempotencyKey)).toBe(true);
    expect(postedBodies.length).toBe(1);
    expect(postedBodies[0]).toContain(plan.marker);
  });

  test("writeWatchdogStuckToGitHub skips when marker already present", async () => {
    const keys = new Set<string>();
    const postedBodies: string[] = [];

    const plan = planWatchdogStuckWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 342,
      taskName: "Watchdog stuck",
      taskPath: "orchestration/tasks/ralph 342.md",
      stage: "plan",
      retryIndex: 0,
      signatureHash,
      timeout,
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string; labels?: string[] } } = {}) => {
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [{ body: `prior\n${plan.marker}`, url: "https://github.com/3mdistal/ralph/issues/342#issuecomment-2" }],
                      pageInfo: { hasPreviousPage: false },
                    },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/labels") && opts.method === "POST") {
          return { data: {} };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: {} };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeWatchdogStuckToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 342,
        taskName: "Watchdog stuck",
        taskPath: "orchestration/tasks/ralph 342.md",
        stage: "plan",
        retryIndex: 0,
        signatureHash,
        timeout,
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
        },
        getIdempotencyPayload: () => null,
      }
    );

    expect(result.postedComment).toBe(false);
    expect(result.markerFound).toBe(true);
    expect(result.commentUrl).toBe("https://github.com/3mdistal/ralph/issues/342#issuecomment-2");
    expect(postedBodies.length).toBe(0);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
  });
});
