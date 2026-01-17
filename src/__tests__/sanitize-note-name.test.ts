import { describe, expect, test } from "bun:test";
import { sanitizeNoteName } from "../util/sanitize-note-name";

describe("sanitizeNoteName", () => {
  test("replaces path separators and trims", () => {
    expect(sanitizeNoteName("Foo/bar")).toBe("Foo - bar");
    expect(sanitizeNoteName("Foo\\bar")).toBe("Foo - bar");
  });

  test("removes forbidden characters and normalizes whitespace", () => {
    expect(sanitizeNoteName("  Foo: bar  ")).toBe("Foo- bar");
    expect(sanitizeNoteName("Foo   bar")).toBe("Foo bar");
  });

  test("caps length", () => {
    const longTitle = "a".repeat(300);
    expect(sanitizeNoteName(longTitle)).toHaveLength(180);
  });

  test("falls back for empty names", () => {
    expect(sanitizeNoteName("////")).toBe("Untitled");
  });
});
