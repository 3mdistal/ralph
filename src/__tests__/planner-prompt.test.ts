import { describe, expect, test } from "bun:test";

import { buildPlannerPrompt } from "../planner-prompt";

describe("planner prompt", () => {
  test("includes required instructions and routing schema", () => {
    const prompt = buildPlannerPrompt({ repo: "3mdistal/ralph", issueNumber: 65 });

    expect(prompt).toContain("Planner prompt v1");
    expect(prompt).toContain("GH_PAGER=cat gh issue view 65 --repo 3mdistal/ralph --comments");
    expect(prompt).toContain("consult @product");
    expect(prompt).toContain("consult @devex");
    expect(prompt).toContain("\"decision\": \"proceed\" | \"escalate\"");
    expect(prompt).toContain("\"confidence\": \"high\" | \"medium\" | \"low\"");
  });
});
