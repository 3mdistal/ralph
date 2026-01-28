import { describe, expect, test } from "bun:test";

import { __prBodyClosesIssueForTests } from "../worker";

describe("prBodyClosesIssue", () => {
  test("detects Fixes/Closes/Resolves directives", () => {
    expect(__prBodyClosesIssueForTests("Fixes #123", "123")).toBe(true);
    expect(__prBodyClosesIssueForTests("closes #123", "123")).toBe(true);
    expect(__prBodyClosesIssueForTests("Resolves #123", "123")).toBe(true);
  });

  test("requires exact issue number boundary", () => {
    expect(__prBodyClosesIssueForTests("Fixes #1234", "123")).toBe(false);
    expect(__prBodyClosesIssueForTests("Fixes #123", "1234")).toBe(false);
  });

  test("works with CRLF and multiline bodies", () => {
    const body = "## Summary\r\n- thing\r\n\r\nFixes #9\r\n";
    expect(__prBodyClosesIssueForTests(body, "9")).toBe(true);
  });
});
