import { describe, expect, test } from "bun:test";

import { __isCiOnlyChangeSetForTests, __isCiRelatedIssueForTests } from "../worker";

describe("ci-only guardrail helpers", () => {
  test("detects ci-only change sets", () => {
    expect(__isCiOnlyChangeSetForTests([".github/workflows/ci.yml"])).toBe(true);
    expect(__isCiOnlyChangeSetForTests([".github/actions/action.yml"])).toBe(true);
  });

  test("rejects non-ci change sets", () => {
    expect(__isCiOnlyChangeSetForTests(["src/index.ts"])).toBe(false);
    expect(__isCiOnlyChangeSetForTests([".github/workflows/ci.yml", "src/index.ts"])).toBe(false);
  });

  test("detects ci-related labels", () => {
    expect(__isCiRelatedIssueForTests(["ci"])).toBe(true);
    expect(__isCiRelatedIssueForTests(["Build"])).toBe(true);
    expect(__isCiRelatedIssueForTests(["infra"])).toBe(true);
    expect(__isCiRelatedIssueForTests(["bug"])).toBe(false);
  });
});
