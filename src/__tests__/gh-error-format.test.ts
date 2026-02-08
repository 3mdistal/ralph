import { describe, expect, test } from "bun:test";

import { formatGhError } from "../worker/gh-error-format";

describe("formatGhError", () => {
  test("includes ghCommand and decodes Uint8Array stderr", () => {
    const stderrText = "HTTP 405: Required status checks are expected.";
    const err: any = new Error("ShellError: Failed with exit code 1");
    err.ghCommand = "gh pr merge 1 --repo 3mdistal/ralph";
    err.exitCode = 1;
    err.stderr = new TextEncoder().encode(stderrText);

    const out = formatGhError(err);
    expect(out).toContain("Command: gh pr merge 1 --repo 3mdistal/ralph");
    expect(out).toContain("Exit code: 1");
    expect(out).toContain("stderr:");
    expect(out).toContain(stderrText);

    // Guard against Uint8Array default .toString() output (comma-separated bytes).
    expect(out).not.toMatch(/\b\d+(?:,\d+){5,}\b/);
  });

  test("redacts obvious tokens in stderr", () => {
    const err: any = new Error("ShellError: Failed with exit code 1");
    err.ghCommand = "gh api /repos/x/y";
    err.stderr = "Bad credentials: ghp_abcdefghijklmnopqrstuvwxyz0123456789";

    const out = formatGhError(err);
    expect(out).toContain("ghp_[REDACTED]");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
