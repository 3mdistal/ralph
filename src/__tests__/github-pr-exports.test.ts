import { describe, expect, test } from "bun:test";

import { searchMergedPullRequestsByIssueLink } from "../github/pr";

describe("github pr exports", () => {
  test("searchMergedPullRequestsByIssueLink is exported", () => {
    expect(typeof searchMergedPullRequestsByIssueLink).toBe("function");
  });
});
