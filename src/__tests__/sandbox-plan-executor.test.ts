import { describe, expect, test } from "bun:test";

import { executeSandboxActions } from "../sandbox/plan-executor";

describe("sandbox plan executor", () => {
  test("skips execution when apply=false", async () => {
    let calls = 0;
    const actions = [{ repoFullName: "3mdistal/ralph-sandbox-demo", action: "archive" as const }];

    const result = await executeSandboxActions({
      actions,
      apply: false,
      execute: async () => {
        calls += 1;
      },
    });

    expect(calls).toBe(0);
    expect(result.executed.length).toBe(0);
    expect(result.skipped.length).toBe(1);
  });
});
