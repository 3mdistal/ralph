import { describe, expect, test } from "bun:test";

import { resolveRequestedOpencodeProfile } from "../opencode-profile-utils";

describe("resolveRequestedOpencodeProfile", () => {
  test("prefers control profile when set", () => {
    const requested = resolveRequestedOpencodeProfile({
      controlProfile: "apple",
      defaultProfile: "auto",
    });

    expect(requested).toBe("apple");
  });

  test("returns auto when default profile is auto", () => {
    const requested = resolveRequestedOpencodeProfile({
      controlProfile: "",
      defaultProfile: "auto",
    });

    expect(requested).toBe("auto");
  });
});
