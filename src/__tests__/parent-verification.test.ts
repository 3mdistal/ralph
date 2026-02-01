import { describe, expect, test } from "bun:test";

import { parseLastLineJsonMarker } from "../markers";
import {
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

  test("backoff increases with attempts", () => {
    const first = getParentVerificationBackoffMs(1);
    const second = getParentVerificationBackoffMs(2);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
