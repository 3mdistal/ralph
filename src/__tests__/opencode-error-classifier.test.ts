import { describe, expect, test } from "bun:test";

import { classifyOpencodeFailure } from "../opencode-error-classifier";

describe("classifyOpencodeFailure", () => {
  test("classifies invalid tool schema responses", () => {
    const output = [
      "{\"type\":\"error\",\"error\":{\"data\":{\"message\":\"Invalid schema for function 'ahrefs_batch-analysis-batch-analysis': In context=('properties', 'select'), array schema missing items.\"}}}",
      "code: invalid_function_parameters",
    ].join("\n");

    const classification = classifyOpencodeFailure(output);
    expect(classification?.blockedSource).toBe("opencode-config-invalid");
    expect(classification?.reason).toContain("invalid_function_parameters");
    expect(classification?.reason).toContain("ahrefs_batch-analysis-batch-analysis");
  });

  test("returns null for unrelated failures", () => {
    const classification = classifyOpencodeFailure("Build failed: test suite had 2 failures");
    expect(classification).toBeNull();
  });
});
