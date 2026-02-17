import { describe, expect, test } from "bun:test";

import { parseRalphPlanReviewMarker } from "../gates/plan-review";

describe("parseRalphPlanReviewMarker", () => {
  test("parses valid marker on last non-empty line", () => {
    const output = [
      "Plan notes",
      'RALPH_PLAN_REVIEW: {"status":"pass","reason":"Plan is executable"}',
      "",
    ].join("\n");

    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pass");
      expect(result.reason).toBe("Plan is executable");
    }
  });

  test("fails when marker is missing", () => {
    const result = parseRalphPlanReviewMarker("No marker");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_marker");
    }
  });

  test("fails when marker is not final line", () => {
    const output = [
      'RALPH_PLAN_REVIEW: {"status":"pass","reason":"ok"}',
      "Trailing text",
    ].join("\n");

    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("marker_not_final_line");
    }
  });

  test("fails when multiple markers are present", () => {
    const output = [
      'RALPH_PLAN_REVIEW: {"status":"pass","reason":"ok"}',
      "Other text",
      'RALPH_PLAN_REVIEW: {"status":"fail","reason":"no"}',
    ].join("\n");

    const result = parseRalphPlanReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("multiple_markers");
    }
  });

  test("fails on empty output", () => {
    const result = parseRalphPlanReviewMarker("\n\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("empty_output");
    }
  });

  test("fails when marker JSON is missing", () => {
    const result = parseRalphPlanReviewMarker("RALPH_PLAN_REVIEW:");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_json");
    }
  });

  test("fails on malformed marker JSON", () => {
    const result = parseRalphPlanReviewMarker('RALPH_PLAN_REVIEW: {"status":"pass",');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_json");
    }
  });

  test("fails when marker status is invalid", () => {
    const result = parseRalphPlanReviewMarker('RALPH_PLAN_REVIEW: {"status":"maybe","reason":"x"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_status");
    }
  });

  test("fails when marker reason is missing", () => {
    const result = parseRalphPlanReviewMarker('RALPH_PLAN_REVIEW: {"status":"pass","reason":""}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_reason");
    }
  });
});
