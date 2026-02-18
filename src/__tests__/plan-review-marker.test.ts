import { describe, expect, test } from "bun:test";

import { parseRalphPlanReviewMarker } from "../gates/plan-review";

describe("parseRalphPlanReviewMarker", () => {
  test("parses valid marker on final non-empty line", () => {
    const output = [
      "Plan review notes",
      'RALPH_PLAN_REVIEW: {"status":"pass","reason":"Plan aligns with canon"}',
      "",
    ].join("\n");

    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pass");
      expect(result.reason).toBe("Plan aligns with canon");
    }
  });

  test("parses marker with leading whitespace", () => {
    const output = ["notes", '   RALPH_PLAN_REVIEW: {"status":"pass","reason":"ok"}'].join("\n");
    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pass");
    }
  });

  test("fails when marker is missing", () => {
    const result = parseRalphPlanReviewMarker("No marker present");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_marker");
    }
  });

  test("fails when marker is not final line", () => {
    const output = [
      'RALPH_PLAN_REVIEW: {"status":"pass","reason":"ok"}',
      "extra",
    ].join("\n");
    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("marker_not_final_line");
    }
  });

  test("fails when a trailing code fence appears after marker", () => {
    const output = ['RALPH_PLAN_REVIEW: {"status":"pass","reason":"ok"}', "```"].join("\n");
    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("marker_not_final_line");
    }
  });

  test("fails when multiple markers exist", () => {
    const output = [
      'RALPH_PLAN_REVIEW: {"status":"pass","reason":"ok"}',
      'RALPH_PLAN_REVIEW: {"status":"fail","reason":"no"}',
    ].join("\n");
    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("multiple_markers");
    }
  });

  test("fails on malformed json", () => {
    const result = parseRalphPlanReviewMarker("RALPH_PLAN_REVIEW: {not json}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_json");
    }
  });

  test("fails on invalid status", () => {
    const result = parseRalphPlanReviewMarker('RALPH_PLAN_REVIEW: {"status":"maybe","reason":"?"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_status");
    }
  });

  test("fails on missing reason", () => {
    const result = parseRalphPlanReviewMarker('RALPH_PLAN_REVIEW: {"status":"pass"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_reason");
    }
  });
});
