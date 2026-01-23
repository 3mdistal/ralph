import { describe, test, expect } from "bun:test";

import { __buildRollupBodyForTests, __extractClosingIssuesFromBodyForTests } from "../rollup";

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
    expect(body).toContain("Ralph-Rollup-Batch: batch-123");
    expect(body).toContain("<!-- ralph-rollup-batch-id=batch-123 -->");
  });

  test("omits closes section when none found", () => {
    const body = __buildRollupBodyForTests({
      today: "2026-01-15",
      botBranch: "bot/integration",
      prs: ["https://github.com/acme/widgets/pull/11"],
      includedIssues: [],
      closingIssues: [],
      batchId: "batch-456",
      generatedAt: "2026-01-15T12:00:00.000Z",
    });

    expect(body).toContain("### Included PRs");
    expect(body).toContain("### Included Issues");
    expect(body).not.toContain("### Closes");
    expect(body).toContain("Ralph-Rollup-Batch: batch-456");
  });
});
