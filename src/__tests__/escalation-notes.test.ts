import { describe, expect, test } from "bun:test";

import { extractResolutionSection } from "../escalation-notes";

describe("escalation resolution parsing", () => {
  test("returns null when no Resolution section", () => {
    const md = ["# Escalation", "", "## Next Steps", "foo"].join("\n");
    expect(extractResolutionSection(md)).toBeNull();
  });

  test("returns null when Resolution section is empty/placeholder", () => {
    const md = [
      "# Escalation",
      "",
      "## Resolution",
      "",
      "<!-- Add human guidance here. -->",
      "",
      "## Next Steps",
      "...",
    ].join("\n");

    expect(extractResolutionSection(md)).toBeNull();
  });

  test("extracts Resolution section until next heading", () => {
    const md = [
      "# Escalation",
      "",
      "## Resolution",
      "Please do X.",
      "Then do Y.",
      "",
      "## Next Steps",
      "ignored",
    ].join("\n");

    expect(extractResolutionSection(md)).toBe(["Please do X.", "Then do Y."].join("\n"));
  });

  test("matches Resolution heading case-insensitively", () => {
    const md = ["## RESOLUTION", "Guidance"].join("\n");
    expect(extractResolutionSection(md)).toBe("Guidance");
  });
});
