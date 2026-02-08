import { describe, expect, test } from "bun:test";

import { parseGlobalRuntimeFlags } from "../runtime-flags";

describe("parseGlobalRuntimeFlags", () => {
  test("parses global runtime flags before command", () => {
    const parsed = parseGlobalRuntimeFlags(["--profile", "sandbox", "--run-id", "sandbox-123", "status", "--json"]);
    expect(parsed.profileOverride).toBe("sandbox");
    expect(parsed.sandboxRunId).toBe("sandbox-123");
    expect(parsed.args).toEqual(["status", "--json"]);
  });

  test("does not consume subcommand-local usage --profile", () => {
    const parsed = parseGlobalRuntimeFlags(["usage", "--profile", "auto", "--json"]);
    expect(parsed.profileOverride).toBeNull();
    expect(parsed.args).toEqual(["usage", "--profile", "auto", "--json"]);
  });

  test("supports equals forms", () => {
    const parsed = parseGlobalRuntimeFlags(["--profile=sandbox", "--run-id=sandbox-xyz", "watch"]);
    expect(parsed.profileOverride).toBe("sandbox");
    expect(parsed.sandboxRunId).toBe("sandbox-xyz");
    expect(parsed.args).toEqual(["watch"]);
  });
});
