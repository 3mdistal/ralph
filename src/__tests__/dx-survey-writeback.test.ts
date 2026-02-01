import { describe, expect, test } from "bun:test";

import { parseDxSurveyV1FromText } from "../github/dx-survey-writeback";

describe("parseDxSurveyV1FromText", () => {
  test("parses direct JSON", () => {
    const parsed = parseDxSurveyV1FromText(
      JSON.stringify({ schema: "ralph.dx_survey.v1", negativeItems: [{ title: "t", severity: "p2" }] })
    );
    expect(parsed?.schema).toBe("ralph.dx_survey.v1");
    expect(parsed?.negativeItems?.[0]?.title).toBe("t");
  });

  test("parses fenced JSON", () => {
    const text = [
      "Here you go:\n",
      "```json\n",
      JSON.stringify({ schema: "ralph.dx_survey.v1", negativeItems: [] }, null, 2),
      "\n```\n",
    ].join("");
    const parsed = parseDxSurveyV1FromText(text);
    expect(parsed?.schema).toBe("ralph.dx_survey.v1");
    expect(parsed?.negativeItems).toEqual([]);
  });

  test("returns null when schema mismatches", () => {
    const parsed = parseDxSurveyV1FromText(JSON.stringify({ schema: "other", negativeItems: [] }));
    expect(parsed).toBe(null);
  });
});
