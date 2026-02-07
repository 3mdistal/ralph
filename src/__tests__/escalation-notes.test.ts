import { describe, expect, test } from "bun:test";

import { extractResolutionSection, patchResolutionSection } from "../escalation-notes";

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

  test("patches placeholder Resolution section", () => {
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
    const patched = patchResolutionSection(md, "Auto guidance line 1\nAuto guidance line 2");
    expect(patched.changed).toBe(true);
    expect(extractResolutionSection(patched.markdown)).toBe("Auto guidance line 1\nAuto guidance line 2");
  });

  test("does not overwrite existing human resolution", () => {
    const md = ["## Resolution", "Human guidance", "", "## Next Steps", "..."].join("\n");
    const patched = patchResolutionSection(md, "Auto guidance");
    expect(patched.changed).toBe(false);
    expect(patched.reason).toBe("already-filled");
  });

  test("adds Resolution section when missing", () => {
    const md = ["# Escalation", "", "## Next Steps", "..."].join("\n");
    const patched = patchResolutionSection(md, "Auto guidance");
    expect(patched.changed).toBe(true);
    expect(patched.markdown).toContain("## Resolution");
    expect(extractResolutionSection(patched.markdown)).toBe("Auto guidance");
  });
});
