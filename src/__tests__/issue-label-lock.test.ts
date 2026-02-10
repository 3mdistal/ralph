import { describe, expect, test } from "bun:test";

import { withIssueLabelLock } from "../github/issue-label-lock";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("issue label lock", () => {
  test("serializes same issue key", async () => {
    let active = 0;
    let maxActive = 0;

    const run = async () =>
      await withIssueLabelLock({
        repo: "3mdistal/ralph",
        issueNumber: 1,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(10);
          active -= 1;
        },
      });

    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(1);
  });

  test("allows parallel work for different issues", async () => {
    let active = 0;
    let maxActive = 0;

    await Promise.all([
      withIssueLabelLock({
        repo: "3mdistal/ralph",
        issueNumber: 1,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(10);
          active -= 1;
        },
      }),
      withIssueLabelLock({
        repo: "3mdistal/ralph",
        issueNumber: 2,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(10);
          active -= 1;
        },
      }),
    ]);

    expect(maxActive).toBeGreaterThanOrEqual(2);
  });
});
