import { describe, expect, test } from "bun:test";

import { applyIssueLabelOps, removeIssueLabel } from "../github/issue-label-io";

describe("issue-label-io", () => {
  test("removeIssueLabel treats 404 as removed when allowNotFound", async () => {
    const github = {
      request: async () => ({ status: 404 }),
    } as any;

    const result = await removeIssueLabel({
      github,
      repo: "3mdistal/ralph",
      issueNumber: 123,
      label: "ralph:status:blocked",
      allowNotFound: true,
    });

    expect(result.removed).toBe(true);
  });

  test("applyIssueLabelOps includes remove when label already absent", async () => {
    const github = {
      request: async () => ({ status: 404 }),
    } as any;

    const result = await applyIssueLabelOps({
      ops: [{ action: "remove", label: "ralph:status:blocked" }],
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
    expect(result.remove).toEqual(["ralph:status:blocked"]);
  });
});
