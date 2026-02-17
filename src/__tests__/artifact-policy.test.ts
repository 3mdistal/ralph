import { describe, test, expect } from "bun:test";

import {
  applyGateArtifactPolicy,
  applyGateFieldPolicy,
  applyTextPolicy,
  ARTIFACT_POLICY_VERSION,
  MAX_TEXT_CHARS,
} from "../gates/artifact-policy";

describe("gate artifact policy", () => {
  test("tail-truncates log artifacts with metadata", () => {
    const long = `prefix-${"x".repeat(MAX_TEXT_CHARS)}-suffix`;
    const out = applyGateArtifactPolicy({ kind: "failure_excerpt", content: long });
    expect(out.artifactPolicyVersion).toBe(ARTIFACT_POLICY_VERSION);
    expect(out.truncationMode).toBe("tail");
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(MAX_TEXT_CHARS);
    expect(out.content.endsWith("-suffix")).toBe(true);
  });

  test("head-truncates note artifacts", () => {
    const out = applyGateArtifactPolicy({ kind: "note", content: "hello-" + "y".repeat(800) });
    expect(out.truncationMode).toBe("head");
    expect(out.truncated).toBe(true);
    expect(out.content.startsWith("hello-")).toBe(true);
  });

  test("redacts before truncation deterministically", () => {
    const out = applyTextPolicy({
      value: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      truncationMode: "head",
      maxChars: 32,
    });
    expect(out.value).toContain("[REDACTED]");
    expect(out.value).not.toContain("ghp_");
  });

  test("gate field policy preserves undefined/null and trims", () => {
    expect(applyGateFieldPolicy(undefined, 100)).toBeUndefined();
    expect(applyGateFieldPolicy(null, 100)).toBeNull();
    expect(applyGateFieldPolicy("   ", 100)).toBeNull();
    expect(applyGateFieldPolicy("  hi  ", 100)).toBe("hi");
  });
});
