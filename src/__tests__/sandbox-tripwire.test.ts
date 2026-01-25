import { evaluateSandboxTripwire } from "../github/sandbox-tripwire";

describe("sandbox tripwire", () => {
  test("allows non-sandbox profiles", () => {
    const result = evaluateSandboxTripwire({
      profile: "prod",
      repo: "3mdistal/ralph",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(result.allowed).toBe(true);
  });

  test("allows sandbox repo within boundary", () => {
    const result = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "3mdistal/ralph-sandbox-demo",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(result.allowed).toBe(true);
  });

  test("denies sandbox repo outside prefix", () => {
    const result = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "3mdistal/ralph",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/does not start/i);
  });
});
