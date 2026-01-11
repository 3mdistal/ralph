import { describe, expect, test } from "bun:test";
import { normalizeBwrbNoteRef } from "../queue";

describe("bwrb identifier normalization", () => {
  test("normalizeBwrbNoteRef strips newlines and trims", () => {
    expect(normalizeBwrbNoteRef(" orchestration/tasks/foo.md\n")).toBe("orchestration/tasks/foo.md");
    expect(normalizeBwrbNoteRef("foo\r\nbar")).toBe("foobar");
    expect(normalizeBwrbNoteRef("  foo  ")).toBe("foo");
  });
});
