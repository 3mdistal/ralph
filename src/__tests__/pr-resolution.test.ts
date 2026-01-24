import { describe, expect, test } from "bun:test";
import { selectCanonicalPr } from "../pr-resolution";

describe("pr-resolution", () => {
  test("prefers candidates with GitHub createdAt", () => {
    const result = selectCanonicalPr([
      {
        url: "https://github.com/3mdistal/ralph/pull/1",
        source: "db" as const,
        dbUpdatedAt: "2026-01-11T00:00:02.000Z",
      },
      {
        url: "https://github.com/3mdistal/ralph/pull/2",
        source: "db" as const,
        ghCreatedAt: "2026-01-11T00:00:03.000Z",
      },
    ]);

    expect(result.selected?.url).toBe("https://github.com/3mdistal/ralph/pull/2");
    expect(result.duplicates.map((dup) => dup.url)).toEqual(["https://github.com/3mdistal/ralph/pull/1"]);
  });

  test("orders by newest GitHub createdAt", () => {
    const result = selectCanonicalPr([
      {
        url: "https://github.com/3mdistal/ralph/pull/1",
        source: "gh-search" as const,
        ghCreatedAt: "2026-01-11T00:00:01.000Z",
      },
      {
        url: "https://github.com/3mdistal/ralph/pull/2",
        source: "gh-search" as const,
        ghCreatedAt: "2026-01-11T00:00:02.000Z",
      },
    ]);

    expect(result.selected?.url).toBe("https://github.com/3mdistal/ralph/pull/2");
    expect(result.duplicates.map((dup) => dup.url)).toEqual(["https://github.com/3mdistal/ralph/pull/1"]);
  });

  test("uses url tie-breaker when timestamps match", () => {
    const result = selectCanonicalPr([
      {
        url: "https://github.com/3mdistal/ralph/pull/2",
        source: "db" as const,
        ghCreatedAt: "2026-01-11T00:00:02.000Z",
      },
      {
        url: "https://github.com/3mdistal/ralph/pull/1",
        source: "db" as const,
        ghCreatedAt: "2026-01-11T00:00:02.000Z",
      },
    ]);

    expect(result.selected?.url).toBe("https://github.com/3mdistal/ralph/pull/1");
    expect(result.duplicates.map((dup) => dup.url)).toEqual(["https://github.com/3mdistal/ralph/pull/2"]);
  });
});
