import { describe, expect, test } from "bun:test";

import { hasProductGap } from "../routing";

describe("hasProductGap", () => {
  test("true only for explicit PRODUCT GAP: markers", () => {
    expect(hasProductGap("PRODUCT GAP: missing policy for escalation markers")).toBe(true);
    expect(hasProductGap("  PRODUCT GAP: docs do not specify expected behavior")).toBe(true);
    expect(hasProductGap("- PRODUCT GAP: missing spec for X")).toBe(true);
    expect(hasProductGap("* PRODUCT GAP: missing spec for Y")).toBe(true);
    expect(hasProductGap("PRODUCT  GAP : missing spec for Z")).toBe(true);
    expect(hasProductGap("product gap: case-insensitive marker")).toBe(true);
  });

  test("false for NO PRODUCT GAP: and fuzzy language", () => {
    expect(hasProductGap("NO PRODUCT GAP: this is fully specified")).toBe(false);
    expect(hasProductGap("- NO PRODUCT GAP: fully specified")).toBe(false);
    expect(hasProductGap("* No PRODUCT GAP: fully specified")).toBe(false);

    expect(hasProductGap("product docs do not specify the color of the button")).toBe(false);
    expect(hasProductGap("this is not documented anywhere")).toBe(false);
    expect(hasProductGap("PRODUCT GAP")).toBe(false);
    expect(hasProductGap("Here is the marker: PRODUCT GAP: missing policy")).toBe(false);
  });
});
