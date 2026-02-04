import { describe, test, expect } from "bun:test";

import { __buildRollupBodyForTests, __extractClosingIssuesFromBodyForTests, __extractManualChecksFromBodyForTests } from "../rollup";

describe("rollup closing issues", () => {
  test("extracts explicit closing keywords only", () => {
    const body = [
      "Fixes #12",
      "closes #34",
      "Resolves #56",
      "Related to #78",
      "Fixes #12",
      "closes #90 and more",
      "Fixes other/repo#99",
      "Fixes: (#101)",
      "Fixed #102",
    ].join("\n");

    expect(__extractClosingIssuesFromBodyForTests(body)).toEqual([
      "acme/widgets#12",
      "acme/widgets#34",
      "acme/widgets#56",
      "acme/widgets#90",
      "acme/widgets#101",
      "acme/widgets#102",
    ]);
  });

  test("builds rollup body with closes section", () => {
    const body = __buildRollupBodyForTests({
      today: "2026-01-15",
      botBranch: "bot/integration",
      prs: ["https://github.com/acme/widgets/pull/10"],
      includedIssues: ["acme/widgets#2", "acme/widgets#9"],
      closingIssues: ["acme/widgets#2", "acme/widgets#9"],
      verification: {
        baseBranch: "main",
        requiredChecks: { checks: ["CI"], source: "config" },
        preflight: ["bun test"],
        e2e: [{ title: "Core flow", steps: ["Create a widget", "Delete a widget"] }],
        staging: [{ url: "https://staging.example.test", expected: "Dashboard loads" }],
        manualChecks: ["Verify widget list renders"],
      },
      batchId: "batch-123",
      generatedAt: "2026-01-15T12:00:00.000Z",
    });

    expect(body).toContain("### Included PRs");
    expect(body).toContain("- https://github.com/acme/widgets/pull/10");
    expect(body).toContain("### Included Issues");
    expect(body).toContain("- acme/widgets#2");
    expect(body).toContain("- acme/widgets#9");
    expect(body).toContain("### Closes");
    expect(body).toContain("Closes acme/widgets#2");
    expect(body).toContain("Closes acme/widgets#9");
    expect(body).toContain("### CI (already covered)");
    expect(body).toContain("`CI`");
    expect(body).toContain("### Quick sanity (optional)");
    expect(body).toContain("`bun test`");
    expect(body).toContain("### E2E verification (human)");
    expect(body).toContain("Core flow: Create a widget; Delete a widget");
    expect(body).toContain("Verify widget list renders");
    expect(body).toContain("### Staging / preview (optional)");
    expect(body).toContain("https://staging.example.test");
    expect(body).toContain("Ralph-Rollup-Batch: batch-123");
    expect(body).toContain("ralph-rollup-batch-id=batch-123");
    expect(body).toContain("<!-- ralph-rollup-batch-id=batch-123 -->");
  });

  test("omits closes section when none found", () => {
    const body = __buildRollupBodyForTests({
      today: "2026-01-15",
      botBranch: "bot/integration",
      prs: ["https://github.com/acme/widgets/pull/11"],
      includedIssues: [],
      closingIssues: [],
      verification: {
        baseBranch: "main",
        requiredChecks: { checks: [], source: "none" },
        preflight: [],
        e2e: [],
        staging: [],
        manualChecks: [],
      },
      batchId: "batch-456",
      generatedAt: "2026-01-15T12:00:00.000Z",
    });

    expect(body).toContain("### Included PRs");
    expect(body).toContain("### Included Issues");
    expect(body).not.toContain("### Closes");
    expect(body).toContain("Ralph-Rollup-Batch: batch-456");
  });
});

describe("rollup manual checks extraction", () => {
  test("prefers marker section when present", () => {
    const body = [
      "# Summary",
      "",
      "<!-- ralph:manual-checks:start -->",
      "- Open the dashboard",
      "- Confirm widgets render",
      "<!-- ralph:manual-checks:end -->",
      "",
      "## Manual checks",
      "- This should not be picked",
    ].join("\n");

    expect(__extractManualChecksFromBodyForTests(body)).toEqual(["Open the dashboard", "Confirm widgets render"]);
  });

  test("falls back to heading when markers are missing", () => {
    const body = [
      "## Manual checks",
      "1. Launch the app",
      "2. Create a record",
      "",
      "## Notes",
      "- Ignore this section",
    ].join("\n");

    expect(__extractManualChecksFromBodyForTests(body)).toEqual(["Launch the app", "Create a record"]);
  });

  test("ignores headings inside fenced code blocks", () => {
    const body = [
      "## Manual checks",
      "- Outside fence",
      "```",
      "## Manual checks",
      "- Inside fence",
      "```",
      "## Next",
      "- Not included",
    ].join("\n");

    expect(__extractManualChecksFromBodyForTests(body)).toEqual(["Outside fence", "Inside fence"]);
  });
});
