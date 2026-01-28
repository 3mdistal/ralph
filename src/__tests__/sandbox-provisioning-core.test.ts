import { describe, expect, test } from "bun:test";

import { buildProvisionPlan } from "../sandbox/provisioning-core";

describe("sandbox provisioning core", () => {
  test("builds deterministic plan", () => {
    const plan = buildProvisionPlan({
      runId: "abc12345-ffff",
      owner: "3mdistal",
      botBranch: "bot/integration",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
      },
      provisioning: {
        templateRepo: "3mdistal/ralph-template",
        templateRef: "main",
        repoVisibility: "private",
        settingsPreset: "minimal",
        seed: { preset: "baseline" },
      },
    });

    expect(plan.runIdShort).toBe("abc12345");
    expect(plan.repoName).toBe("ralph-sandbox-abc12345");
    expect(plan.repoFullName).toBe("3mdistal/ralph-sandbox-abc12345");
    expect(plan.settingsPreset).toBe("minimal");
    expect(plan.seed?.preset).toBe("baseline");
  });
});
