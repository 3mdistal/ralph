
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
    ].join("\n");

    expect(__extractClosingIssuesFromBodyForTests(body)).toEqual(["12", "34", "56", "90"]);
  });

  test("builds rollup body with closes section", () => {
    const body = __buildRollupBodyForTests({
      today: "2026-01-15",
      botBranch: "bot/integration",
      prs: ["https://github.com/acme/widgets/pull/10"],
      closingIssues: ["2", "9"],
      generatedAt: "2026-01-15T12:00:00.000Z",
    });

    expect(body).toContain("### Included PRs");
    expect(body).toContain("- https://github.com/acme/widgets/pull/10");
    expect(body).toContain("### Closes");
    expect(body).toContain("Fixes #2");
    expect(body).toContain("Fixes #9");
  });

  test("omits closes section when none found", () => {
    const body = __buildRollupBodyForTests({
      today: "2026-01-15",
      botBranch: "bot/integration",
      prs: ["https://github.com/acme/widgets/pull/11"],
      closingIssues: [],
      generatedAt: "2026-01-15T12:00:00.000Z",
    });

    expect(body).toContain("### Included PRs");
    expect(body).not.toContain("### Closes");
  });
});
