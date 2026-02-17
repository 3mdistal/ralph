import { afterEach, describe, expect, test } from "bun:test";

import { applyIssueLabelOps, removeIssueLabel } from "../github/issue-label-io";

const ORIGINAL_COALESCE = process.env.RALPH_GITHUB_LABEL_WRITE_COALESCE_MS;

afterEach(() => {
  if (ORIGINAL_COALESCE === undefined) {
    delete process.env.RALPH_GITHUB_LABEL_WRITE_COALESCE_MS;
  } else {
    process.env.RALPH_GITHUB_LABEL_WRITE_COALESCE_MS = ORIGINAL_COALESCE;
  }
});

describe("issue-label-io", () => {
  test("removeIssueLabel treats 404 as removed when allowNotFound", async () => {
    const github = {
      request: async () => ({ status: 404 }),
    } as any;

    const result = await removeIssueLabel({
      github,
      repo: "3mdistal/ralph",
      issueNumber: 123,
      label: "ralph:status:escalated",
      allowNotFound: true,
    });

    expect(result.removed).toBe(true);
  });

  test("applyIssueLabelOps includes remove when label already absent", async () => {
    const github = {
      request: async () => ({ status: 404 }),
    } as any;

    const result = await applyIssueLabelOps({
      ops: [{ action: "remove", label: "ralph:status:escalated" }],
      io: {
        addLabel: async () => {},
        removeLabel: async (label: string) =>
          await removeIssueLabel({
            github,
            repo: "3mdistal/ralph",
            issueNumber: 123,
            label,
            allowNotFound: true,
          }),
      },
      log: () => {},
      logLabel: "3mdistal/ralph#123",
      retryMissingLabelOnce: false,
    });

    expect(result.ok).toBe(true);
    expect(result.remove).toEqual(["ralph:status:escalated"]);
  });

  test("coalesces concurrent best-effort writes for same issue", async () => {
    process.env.RALPH_GITHUB_LABEL_WRITE_COALESCE_MS = "20";
    let addCalls = 0;

    const io = {
      addLabel: async () => {
        addCalls += 1;
      },
      removeLabel: async () => ({ removed: true }),
      listLabels: async () => [],
    };

    const [a, b] = await Promise.all([
      applyIssueLabelOps({
        ops: [{ action: "add", label: "ralph:status:queued" }],
        io,
        log: () => {},
        repo: "3mdistal/ralph",
        issueNumber: 762,
        writeClass: "best-effort",
      }),
      applyIssueLabelOps({
        ops: [{ action: "add", label: "ralph:status:queued" }],
        io,
        log: () => {},
        repo: "3mdistal/ralph",
        issueNumber: 762,
        writeClass: "best-effort",
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(addCalls).toBe(1);
  });

  test("drops best-effort no-op writes against live labels", async () => {
    process.env.RALPH_GITHUB_LABEL_WRITE_COALESCE_MS = "1";
    let addCalls = 0;
    let removeCalls = 0;

    const result = await applyIssueLabelOps({
      ops: [{ action: "add", label: "ralph:status:queued" }],
      io: {
        addLabel: async () => {
          addCalls += 1;
        },
        removeLabel: async () => {
          removeCalls += 1;
          return { removed: true };
        },
        listLabels: async () => ["ralph:status:queued"],
      },
      log: () => {},
      repo: "3mdistal/ralph",
      issueNumber: 762,
      writeClass: "best-effort",
    });

    expect(result.ok).toBe(true);
    expect(result.add).toEqual([]);
    expect(result.remove).toEqual([]);
    expect(addCalls).toBe(0);
    expect(removeCalls).toBe(0);
  });
});
