import { describe, expect, test } from "bun:test";

import { hasProductGap, selectPrUrl } from "../routing";

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

  test("NO PRODUCT GAP takes precedence globally", () => {
    const mixed = [
      "PRODUCT GAP: docs appear incomplete",
      "Some extra context",
      "- NO PRODUCT GAP: clarified by latest comment",
    ].join("\n");

    expect(hasProductGap(mixed)).toBe(false);
  });
});

describe("PR URL selection", () => {
  test("prefers structured PR URL", () => {
    expect(
      selectPrUrl({
        output: "https://github.com/acme/tools/pull/12",
        repo: "3mdistal/ralph",
        prUrl: "https://github.com/3mdistal/ralph/pull/101",
      })
    ).toBe("https://github.com/3mdistal/ralph/pull/101");
  });

  test("selects latest PR URL when repo is not provided", () => {
    const output = [
      "https://github.com/acme/tools/pull/12",
      "noise",
      "https://github.com/3mdistal/ralph/pull/67",
    ].join("\n");

    expect(selectPrUrl({ output })).toBe("https://github.com/3mdistal/ralph/pull/67");
  });

  test("selects latest PR URL for repo", () => {
    const output = [
      "https://github.com/acme/tools/pull/12",
      "https://github.com/3mdistal/ralph/pull/45",
      "https://github.com/3mdistal/ralph/pull/67",
      "https://github.com/acme/tools/pull/99",
    ].join("\n");

    expect(selectPrUrl({ output, repo: "3mdistal/ralph" })).toBe("https://github.com/3mdistal/ralph/pull/67");
  });

  test("returns null when repo does not match", () => {
    const output = [
      "https://github.com/acme/tools/pull/12",
      "https://github.com/another/repo/pull/99",
    ].join("\n");

    expect(selectPrUrl({ output, repo: "3mdistal/ralph" })).toBe(null);
  });
});
