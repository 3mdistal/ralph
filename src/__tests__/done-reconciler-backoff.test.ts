import { describe, expect, test } from "bun:test";

import { __createDefaultBranchCacheForTests, __resolveDoneReconcileDelayForTests } from "../github/done-reconciler";

describe("done reconciler backoff", () => {
  test("backs off when idle and resets on work", () => {
    const idle = __resolveDoneReconcileDelayForTests({
      baseMs: 300_000,
      previousMs: 300_000,
      hadError: false,
      hadWork: false,
    });

    expect(idle.reason).toBe("idle");
    expect(idle.delayMs).toBe(450_000);

    const work = __resolveDoneReconcileDelayForTests({
      baseMs: 300_000,
      previousMs: 450_000,
      hadError: false,
      hadWork: true,
    });

    expect(work.reason).toBe("work");
    expect(work.delayMs).toBe(300_000);
  });

  test("backs off faster on error", () => {
    const errored = __resolveDoneReconcileDelayForTests({
      baseMs: 300_000,
      previousMs: 300_000,
      hadError: true,
      hadWork: false,
    });

    expect(errored.reason).toBe("error");
    expect(errored.delayMs).toBe(600_000);
  });

  test("caches default branch lookups", async () => {
    let nowMs = 0;
    const cache = __createDefaultBranchCacheForTests({ ttlMs: 1000, now: () => nowMs });
    let calls = 0;
    const github = {
      request: async () => {
        calls += 1;
        return { data: { default_branch: "main" } };
      },
    } as any;

    expect(await cache.get("3mdistal/ralph", github)).toBe("main");
    expect(calls).toBe(1);

    expect(await cache.get("3mdistal/ralph", github)).toBe("main");
    expect(calls).toBe(1);

    nowMs = 2000;
    expect(await cache.get("3mdistal/ralph", github)).toBe("main");
    expect(calls).toBe(2);
  });
});
