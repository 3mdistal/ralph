import { describe, expect, test } from "bun:test";

import { buildPlannerPrompt } from "../planner-prompt";

describe("planner prompt", () => {
  test("includes required instructions and routing schema", () => {
    const prompt = buildPlannerPrompt({ repo: "3mdistal/ralph", issueNumber: 65 });

    expect(prompt).toContain("Planner prompt v1");
    expect(prompt).toContain("gh api repos/3mdistal/ralph/issues/65");
    expect(prompt).toContain("gh api repos/3mdistal/ralph/issues/65/comments --paginate");
    expect(prompt).toContain("Child completion dossier");
    expect(prompt).toContain("consult @product");
    expect(prompt).toContain("consult @devex");
    expect(prompt).toContain("RALPH_PLAN_REVIEW");
    expect(prompt).toContain("\"decision\": \"proceed\" | \"escalate\"");
    expect(prompt).toContain("\"confidence\": \"high\" | \"medium\" | \"low\"");
  });
});
