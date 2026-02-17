import { describe, test, expect } from "bun:test";

import { redactSensitiveText } from "../redaction";

describe("redaction", () => {
  test("redacts additional GitHub token prefixes", () => {
    const input = "ghs_abcdefghijklmnopqrstuvwxyz123456 and gho_abcdefghijklmnopqrstuvwxyz123456";
    const out = redactSensitiveText(input);
    expect(out).toContain("ghs_[REDACTED]");
    expect(out).toContain("gho_[REDACTED]");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  test("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "abc",
      "def",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactSensitiveText(input);
    expect(out).toBe("[REDACTED_PRIVATE_KEY]");
  });

  test("redacts aws access key ids", () => {
    const out = redactSensitiveText("key=AKIA1234567890ABCDEF");
    expect(out).toContain("AKIA[REDACTED]");
    expect(out).not.toContain("AKIA1234567890ABCDEF");
  });
});
