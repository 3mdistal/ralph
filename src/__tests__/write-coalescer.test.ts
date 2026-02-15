import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearIssueWriteCoalescerForTests, coalesceIssueLabelWrite } from "../github/write-coalescer";

describe("issue write coalescer", () => {
  let priorWindow: string | undefined;

  beforeEach(() => {
    priorWindow = process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS;
    process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS = "10";
    clearIssueWriteCoalescerForTests();
  });

  afterEach(() => {
    if (priorWindow === undefined) delete process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS;
    else process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS = priorWindow;
    clearIssueWriteCoalescerForTests();
  });

  test("coalesces identical label writes on same issue", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return "ok";
    };

    const [a, b] = await Promise.all([
      coalesceIssueLabelWrite({
        repo: "3mdistal/ralph",
        issueNumber: 762,
        add: ["ralph:status:queued"],
        remove: ["ralph:status:in-progress"],
        run,
      }),
      coalesceIssueLabelWrite({
        repo: "3mdistal/ralph",
        issueNumber: 762,
        add: ["ralph:status:queued"],
        remove: ["ralph:status:in-progress"],
        run,
      }),
    ]);

    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(runs).toBe(1);
  });

  test("does not coalesce critical writes", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return runs;
    };

    const [a, b] = await Promise.all([
      coalesceIssueLabelWrite({
        repo: "3mdistal/ralph",
        issueNumber: 762,
        add: ["ralph:status:done"],
        remove: ["ralph:status:in-progress"],
        critical: true,
        run,
      }),
      coalesceIssueLabelWrite({
        repo: "3mdistal/ralph",
        issueNumber: 762,
        add: ["ralph:status:done"],
        remove: ["ralph:status:in-progress"],
        critical: true,
        run,
      }),
    ]);

    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(runs).toBe(2);
  });
});
