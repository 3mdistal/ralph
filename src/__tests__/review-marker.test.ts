import { describe, expect, test } from "bun:test";

import { parseRalphReviewMarker } from "../gates/review";

describe("parseRalphReviewMarker", () => {
  test("parses valid marker on last non-empty line", () => {
    const output = [
      "Review notes",
      "RALPH_REVIEW: {\"status\":\"pass\",\"reason\":\"Looks good\"}",
      "",
    ].join("\n");

    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pass");
      expect(result.reason).toBe("Looks good");
    }
  });

  test("fails when marker is missing", () => {
    const result = parseRalphReviewMarker("No marker here");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_marker");
    }
  });

  test("accepts raw JSON payload on final line when marker is missing", () => {
    const output = [
      "Review notes",
      '{"status":"pass","reason":"Looks good"}',
    ].join("\n");

    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pass");
      expect(result.reason).toBe("Looks good");
    }
  });

  test("accepts case-insensitive marker prefix", () => {
    const output = 'ralph_review: {"status":"fail","reason":"Needs changes"}';

    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("fail");
      expect(result.reason).toBe("Needs changes");
    }
  });

  test("accepts marker prefix without colon", () => {
    const output = 'RALPH_REVIEW {"status":"pass","reason":"Looks good"}';

    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pass");
      expect(result.reason).toBe("Looks good");
    }
  });

  test("accepts multiline trailing JSON payload when marker is missing", () => {
    const output = [
      "Review notes",
      "{",
      '  "status": "fail",',
      '  "reason": "Needs follow-up"',
      "}",
    ].join("\n");

    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("fail");
      expect(result.reason).toBe("Needs follow-up");
    }
  });

  test("fails when marker is not final line", () => {
    const output = [
      "RALPH_REVIEW: {\"status\":\"pass\",\"reason\":\"ok\"}",
      "Extra content",
    ].join("\n");
    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("marker_not_final_line");
    }
  });

  test("fails when multiple markers are present", () => {
    const output = [
      "RALPH_REVIEW: {\"status\":\"pass\",\"reason\":\"ok\"}",
      "Other text",
      "RALPH_REVIEW: {\"status\":\"fail\",\"reason\":\"no\"}",
    ].join("\n");
    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("multiple_markers");
    }
  });

  test("fails on invalid JSON", () => {
    const output = "RALPH_REVIEW: {not json}";
    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_json");
    }
  });

  test("fails on missing reason", () => {
    const output = "RALPH_REVIEW: {\"status\":\"pass\"}";
    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("missing_reason");
    }
  });

  test("fails on invalid status", () => {
    const output = "RALPH_REVIEW: {\"status\":\"maybe\",\"reason\":\"?\"}";
    const result = parseRalphReviewMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_status");
    }
  });
});
