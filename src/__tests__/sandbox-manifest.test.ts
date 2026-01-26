import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { readSandboxManifest, writeSandboxManifest } from "../sandbox/manifest";

describe("sandbox manifest", () => {
  test("writes and reads schemaVersion=1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-manifest-"));
    const path = join(dir, "manifest.json");
    const manifest = {
      schemaVersion: 1 as const,
      runId: "run-1",
      createdAt: new Date().toISOString(),
      templateRepo: "acme/template",
      templateRef: "main",
      repo: { fullName: "acme/sandbox", url: "https://github.com/acme/sandbox", visibility: "private" },
      settingsPreset: "minimal" as const,
      defaultBranch: "main",
      botBranch: "bot/integration",
      steps: {},
    };

    await writeSandboxManifest(path, manifest);
    const reloaded = await readSandboxManifest(path);
    expect(reloaded.runId).toBe("run-1");

    await rm(dir, { recursive: true, force: true });
  });
});
