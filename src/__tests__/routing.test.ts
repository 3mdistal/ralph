import { describe, expect, test } from "bun:test";

import { extractFirstPrUrl, extractLatestPrUrl, extractPrUrls, hasProductGap, pickPrUrlForRepo } from "../routing";

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

describe("PR URL extraction", () => {
  test("extracts all PR URLs in output", () => {
    const output = [
      "Starting work...",
      "https://github.com/acme/tools/pull/12",
      "other text",
      "https://github.com/3mdistal/ralph/pull/67",
    ].join("\n");

    expect(extractPrUrls(output)).toEqual([
      "https://github.com/acme/tools/pull/12",
      "https://github.com/3mdistal/ralph/pull/67",
    ]);
  });

  test("extracts the latest PR URL", () => {
    const output = [
      "https://github.com/acme/tools/pull/12",
      "noise",
      "https://github.com/3mdistal/ralph/pull/67",
    ].join("\n");

    expect(extractLatestPrUrl(output)).toBe("https://github.com/3mdistal/ralph/pull/67");
    expect(extractFirstPrUrl(output)).toBe("https://github.com/acme/tools/pull/12");
  });

  test("prefers latest URL for repo when multiple present", () => {
    const urls = [
      "https://github.com/acme/tools/pull/12",
      "https://github.com/3mdistal/ralph/pull/45",
      "https://github.com/3mdistal/ralph/pull/67",
      "https://github.com/acme/tools/pull/99",
    ];

    expect(pickPrUrlForRepo(urls, "3mdistal/ralph")).toBe("https://github.com/3mdistal/ralph/pull/67");
  });

  test("falls back to last URL when repo does not match", () => {
    const urls = [
      "https://github.com/acme/tools/pull/12",
      "https://github.com/another/repo/pull/99",
    ];

    expect(pickPrUrlForRepo(urls, "3mdistal/ralph")).toBe("https://github.com/another/repo/pull/99");
  });
});
