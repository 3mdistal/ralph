import { describe, expect, test } from "bun:test";

import { applySeedFromSpec } from "../sandbox/provisioning-io";
import type { SandboxManifest } from "../sandbox/manifest";
import { parseSeedSpec } from "../sandbox/seed-spec";

describe("sandbox seed idempotency", () => {
  test("skips writes when manifest already contains seed keys", async () => {
    const manifest: SandboxManifest = {
      schemaVersion: 1,
      runId: "run-1",
      createdAt: new Date().toISOString(),
      templateRepo: "acme/template",
      templateRef: "main",
      repo: { fullName: "acme/sandbox", url: "https://github.com/acme/sandbox", visibility: "private" },
      settingsPreset: "minimal",
      defaultBranch: "main",
      botBranch: "bot/integration",
      steps: {},
      seed: {
        issues: [{ key: "issue-1", number: 1, url: "https://github.com/acme/sandbox/issues/1" }],
        pullRequests: [{ key: "pr-1", number: 2, url: "https://github.com/acme/sandbox/pull/2" }],
      },
    };

    const seedSpec = parseSeedSpec({
      schemaVersion: 1,
      issues: [{ key: "issue-1", title: "Seeded issue" }],
      pullRequests: [{ key: "pr-1", title: "Seeded pr" }],
    });

    await expect(
      applySeedFromSpec({
        repoFullName: "acme/sandbox",
        manifest,
        seedSpec,
        ports: {
          githubFactory: () => {
            throw new Error("githubFactory should not be called for idempotent seed");
          },
          ensureLabels: async () => {
            // no-op
          },
        },
      })
    ).resolves.toBeDefined();
  });
});
