import { describe, expect, test } from "bun:test";

import { evaluateSandboxTripwire } from "../github/sandbox-tripwire";

describe("sandbox tripwire core", () => {
  test("allows non-sandbox profile", () => {
    const decision = evaluateSandboxTripwire({
      profile: "prod",
      repo: "3mdistal/ralph",
      allowedOwners: [],
      repoNamePrefix: "",
    });
    expect(decision.allowed).toBe(true);
  });

  test("denies invalid repo", () => {
    const decision = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/repo is missing or invalid/i);
  });

  test("denies empty allowedOwners", () => {
    const decision = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "3mdistal/ralph-sandbox-demo",
      allowedOwners: [],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/allowedOwners/i);
  });

  test("denies missing prefix", () => {
    const decision = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "3mdistal/ralph-sandbox-demo",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/repoNamePrefix/i);
  });

  test("denies owner outside allowlist", () => {
    const decision = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "other/ralph-sandbox-demo",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/owner/i);
  });

  test("denies repo name without prefix", () => {
    const decision = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "3mdistal/not-sandbox",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/does not start/i);
  });

  test("allows matching owner and prefix (case-insensitive)", () => {
    const decision = evaluateSandboxTripwire({
      profile: "sandbox",
      repo: "3MDistal/RALPH-Sandbox-demo",
      allowedOwners: ["3mdistal"],
      repoNamePrefix: "ralph-sandbox-",
    });
    expect(decision.allowed).toBe(true);
  });
});
