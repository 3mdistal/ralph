import { formatActiveOpencodeProfileLine } from "../status-utils";

describe("formatActiveOpencodeProfileLine", () => {
  test("renders auto selection line when requested is auto", () => {
    const line = formatActiveOpencodeProfileLine({
      requestedProfile: "auto",
      resolvedProfile: "apple",
      selectionSource: "auto",
    });

    expect(line).toBe("Active OpenCode profile: auto (resolved: apple)");
  });

  test("renders failover line when selection is failover", () => {
    const line = formatActiveOpencodeProfileLine({
      requestedProfile: "tempo",
      resolvedProfile: "apple",
      selectionSource: "failover",
    });

    expect(line).toBe("Active OpenCode profile: apple (failover from: tempo)");
  });
});
