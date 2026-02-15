import { describe, expect, test } from "bun:test";

import { waitForRequiredChecks } from "../worker/merge/wait-required-checks";

describe("waitForRequiredChecks", () => {
  test("records timeout in CI gate summary callback", async () => {
    const records: Array<{ timedOut: boolean }> = [];

    const result = await waitForRequiredChecks({
      repo: "3mdistal/ralph",
      prUrl: "https://github.com/3mdistal/ralph/pull/731",
      requiredChecks: ["Test"],
      opts: { timeoutMs: 1, pollIntervalMs: 1 },
      getPullRequestChecks: async () => ({
        headSha: "sha-timeout",
        mergeStateStatus: "CLEAN",
        baseRefName: "bot/integration",
        checks: [{ name: "Test", state: "PENDING", rawState: "IN_PROGRESS", detailsUrl: null }],
      }),
      recordCiGateSummary: (_prUrl, _summary, opts) => {
        records.push({ timedOut: Boolean(opts?.timedOut) });
      },
    });

    expect(result.timedOut).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.timedOut).toBe(true);
  });
});
