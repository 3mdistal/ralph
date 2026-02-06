import { describe, expect, test } from "bun:test";

import { parseLastLineJsonMarker } from "../markers";
import {
  evaluateParentVerificationNoPrEligibility,
  getParentVerificationBackoffMs,
  parseParentVerificationMarker,
  PARENT_VERIFY_MARKER_PREFIX,
} from "../parent-verification";

describe("parent verification markers", () => {
  test("parses last-line marker JSON", () => {
    const payload = { version: 1, work_remains: true, reason: "Work remains" };
    const output = ["Note", `${PARENT_VERIFY_MARKER_PREFIX}: ${JSON.stringify(payload)}`].join("\n");
    const parsed = parseLastLineJsonMarker(output, PARENT_VERIFY_MARKER_PREFIX);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const marker = parseParentVerificationMarker(parsed.value);
      expect(marker?.work_remains).toBe(true);
    }
  });

  test("rejects invalid marker payloads", () => {
    const payload = { version: 1, work_remains: true, reason: "" };
    const output = `${PARENT_VERIFY_MARKER_PREFIX}: ${JSON.stringify(payload)}`;
    const parsed = parseLastLineJsonMarker(output, PARENT_VERIFY_MARKER_PREFIX);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const marker = parseParentVerificationMarker(parsed.value);
      expect(marker).toBe(null);
    }
  });

  test("accepts extended marker payload and no-pr eligibility", () => {
    const payload = {
      version: 1,
      work_remains: false,
      reason: "No implementation work remains",
      confidence: "high",
      checked: ["Reviewed child issues", "Checked acceptance criteria"],
      why_satisfied: "Child work fully satisfies this parent issue.",
      evidence: [{ url: "https://github.com/3mdistal/ralph/issues/1", note: "Child completion" }],
    };
    const marker = parseParentVerificationMarker(payload);
    expect(marker).not.toBe(null);
    if (!marker) return;
    const eligibility = evaluateParentVerificationNoPrEligibility(marker);
    expect(eligibility.ok).toBe(true);
  });

  test("rejects no-pr completion eligibility when confidence is low", () => {
    const marker = parseParentVerificationMarker({
      version: 1,
      work_remains: false,
      reason: "Probably done",
      confidence: "low",
      checked: ["Checked child issues"],
      why_satisfied: "Likely done",
      evidence: [{ url: "https://github.com/3mdistal/ralph/issues/1" }],
    });
    expect(marker).not.toBe(null);
    if (!marker) return;
    const eligibility = evaluateParentVerificationNoPrEligibility(marker);
    expect(eligibility.ok).toBe(false);
  });

  test("backoff increases with attempts", () => {
    const first = getParentVerificationBackoffMs(1);
    const second = getParentVerificationBackoffMs(2);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
