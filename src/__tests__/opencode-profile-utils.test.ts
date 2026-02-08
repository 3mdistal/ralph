import { describe, expect, test } from "bun:test";

import { resolveRequestedOpencodeProfile } from "../opencode-profile-utils";

describe("resolveRequestedOpencodeProfile", () => {
  test("uses default profile and ignores unrelated control input", () => {
    const requested = resolveRequestedOpencodeProfile({
      defaultProfile: "auto",
    });

    expect(requested).toBe("auto");
  });

  test("returns auto when default profile is auto", () => {
    const requested = resolveRequestedOpencodeProfile({
      defaultProfile: "auto",
    });

    expect(requested).toBe("auto");
  });
});
