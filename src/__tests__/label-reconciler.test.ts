import { describe, expect, test } from "bun:test";

import { __testOnlyShouldBypassReconcilerCooldown } from "../github/label-reconciler";

describe("label reconciler deps-blocked cooldown bypass", () => {
  test("bypasses cooldown when deps-blocked is projected as in-progress", () => {
    const bypass = __testOnlyShouldBypassReconcilerCooldown({
      labels: ["ralph:status:in-progress"],
      depsBlocked: true,
    });
    expect(bypass).toBe(true);
  });

  test("bypasses cooldown when deps-blocked is missing meta label", () => {
    const bypass = __testOnlyShouldBypassReconcilerCooldown({
      labels: ["ralph:status:queued"],
      depsBlocked: true,
    });
    expect(bypass).toBe(true);
  });

  test("does not bypass cooldown when deps-blocked projection is already correct", () => {
    const bypass = __testOnlyShouldBypassReconcilerCooldown({
      labels: ["ralph:status:queued", "ralph:meta:blocked"],
      depsBlocked: true,
    });
    expect(bypass).toBe(false);
  });

  test("bypasses cooldown to remove stale meta label after unblocking", () => {
    const bypass = __testOnlyShouldBypassReconcilerCooldown({
      labels: ["ralph:status:queued", "ralph:meta:blocked"],
      depsBlocked: false,
    });
    expect(bypass).toBe(true);
  });
});
