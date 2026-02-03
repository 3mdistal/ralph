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
        schema_version: 2,
        decision: "needs-human",
        confidence: "medium",
        requires_approval: true,
        current_state: "Planner output lacks product guidance.",
        whats_missing: "Expected behavior in escalation policy.",
        options: ["Define packet fields", "Defer until owner input"],
        recommendation: "Define packet fields and proceed.",
        questions: ["Approve the recommended fields?"],
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
    expect(parsed?.decision.options.length).toBeGreaterThanOrEqual(2);
    expect(parsed?.decision.questions.length).toBeGreaterThanOrEqual(1);
  });

  test("normalizes v1 payloads into v2 shape", () => {
    const output = [
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
    ].join("\n");

    const parsed = parseConsultantResponse(output);
    expect(parsed).not.toBeNull();
    expect(parsed?.decision.schema_version).toBe(2);
    expect(parsed?.decision.options.length).toBeGreaterThanOrEqual(2);
    expect(parsed?.decision.questions.length).toBeGreaterThanOrEqual(1);
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
          schema_version: 2,
          decision: "needs-human",
          confidence: "low",
          requires_approval: true,
          current_state: "Planner lacks policy.",
          whats_missing: "Expected packet fields.",
          options: ["Define fields", "Defer"],
          recommendation: "Define fields.",
          questions: ["Approve?"],
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

  test("product-gap prompt specialization", () => {
    const prompt = buildConsultantPrompt({
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      taskName: "Test task",
      escalationType: "product-gap",
      reason: "Needs guidance",
    });

    expect(prompt).toContain("Product-gap escalation");
    expect(prompt).toContain("1-3");
    expect(prompt).toContain("needs-human");
  });

  test("does not specialize prompt for NO PRODUCT GAP marker", () => {
    const prompt = buildConsultantPrompt({
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      taskName: "Test task",
      escalationType: "other",
      reason: "Needs guidance",
      noteContent: "NO PRODUCT GAP: fully specified",
    });

    expect(prompt).not.toContain("Product-gap escalation");
  });
});
