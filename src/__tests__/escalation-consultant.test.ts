import { describe, expect, test } from "bun:test";

import {
  CONSULTANT_MARKER,
  buildConsultantPrompt,
  parseConsultantResponse,
  renderConsultantPacket,
} from "../escalation-consultant/core";

describe("escalation consultant core", () => {
  test("parses sentinel-delimited response", () => {
    const output = [
      "RALPH_CONSULTANT_BRIEF_BEGIN",
      "Trigger: Needs input",
      "Recommendation: Needs human decision.",
      "RALPH_CONSULTANT_BRIEF_END",
      "RALPH_CONSULTANT_JSON_BEGIN",
      JSON.stringify({
        schema_version: 1,
        decision: "needs-human",
        confidence: "medium",
        requires_approval: true,
        proposed_resolution_text: "Add guidance",
        reason: "Missing requirements",
        followups: [{ type: "issue", title: "Clarify", body: "Ask for details" }],
      }),
      "RALPH_CONSULTANT_JSON_END",
    ].join("\n");

    const parsed = parseConsultantResponse(output);
    expect(parsed).not.toBeNull();
    expect(parsed?.decision.decision).toBe("needs-human");
    expect(parsed?.decision.requires_approval).toBe(true);
  });

  test("returns null when missing sentinels", () => {
    const output = "No sentinels here";
    expect(parseConsultantResponse(output)).toBeNull();
  });

  test("renders packet with marker and json", () => {
    const parsed = parseConsultantResponse(
      [
        "RALPH_CONSULTANT_BRIEF_BEGIN",
        "Trigger: Needs input",
        "Recommendation: Needs human decision.",
        "RALPH_CONSULTANT_BRIEF_END",
        "RALPH_CONSULTANT_JSON_BEGIN",
        JSON.stringify({
          schema_version: 1,
          decision: "needs-human",
          confidence: "low",
          requires_approval: true,
          proposed_resolution_text: "Add guidance",
          reason: "Missing requirements",
          followups: [],
        }),
        "RALPH_CONSULTANT_JSON_END",
      ].join("\n")
    );

    if (!parsed) throw new Error("Expected parsed response");
    const packet = renderConsultantPacket(parsed);
    expect(packet).toContain(CONSULTANT_MARKER);
    expect(packet).toContain("```json");
  });

  test("prompt includes sentinels", () => {
    const prompt = buildConsultantPrompt({
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      taskName: "Test task",
      escalationType: "other",
      reason: "Needs guidance",
    });
    expect(prompt).toContain("RALPH_CONSULTANT_BRIEF_BEGIN");
    expect(prompt).toContain("RALPH_CONSULTANT_JSON_BEGIN");
  });
});
