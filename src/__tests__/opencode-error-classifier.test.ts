import { describe, expect, test } from "bun:test";

import { classifyOpencodeFailure } from "../opencode-error-classifier";

describe("classifyOpencodeFailure", () => {
  test("classifies sandbox permission denials with capability and target", () => {
    const output = "permission requested: external_directory (/tmp/merge-conflict.patch); auto-rejecting";
    const classification = classifyOpencodeFailure(output);

    expect(classification?.code).toBe("permission-denied");
    expect(classification?.blockedSource).toBe("permission");
    expect(classification?.capability).toBe("external_directory");
    expect(classification?.target).toBe("/tmp/merge-conflict.patch");
    expect(classification?.reason).toContain("blocked:permission");
  });

  test("classifies sandbox permission denials without explicit target", () => {
    const output = "permission requested: external_directory; auto-rejecting";
    const classification = classifyOpencodeFailure(output);

    expect(classification?.code).toBe("permission-denied");
    expect(classification?.blockedSource).toBe("permission");
    expect(classification?.capability).toBe("external_directory");
    expect(classification?.target).toBeUndefined();
  });

  test("classifies invalid tool schema responses", () => {
    const output = [
      "{\"type\":\"error\",\"error\":{\"data\":{\"message\":\"Invalid schema for function 'ahrefs_batch-analysis-batch-analysis': In context=('properties', 'select'), array schema missing items.\"}}}",
      "code: invalid_function_parameters",
    ].join("\n");

    const classification = classifyOpencodeFailure(output);
    expect(classification?.code).toBe("config-invalid");
    expect(classification?.blockedSource).toBe("opencode-config-invalid");
    expect(classification?.reason).toContain("invalid_function_parameters");
    expect(classification?.reason).toContain("ahrefs_batch-analysis-batch-analysis");
  });

  test("does not classify unrelated mentions of permissions", () => {
    const classification = classifyOpencodeFailure("docs: mention 'permission requested' phrase in guide");
    expect(classification).toBeNull();
  });

  test("returns null for unrelated failures", () => {
    const classification = classifyOpencodeFailure("Build failed: test suite had 2 failures");
    expect(classification).toBeNull();
  });
});
