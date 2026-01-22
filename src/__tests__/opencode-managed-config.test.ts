import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { getRalphOpencodeConfigDir } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorOverride: string | undefined;
let releaseLock: (() => void) | null = null;

describe("Managed OpenCode config", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorOverride = process.env.RALPH_OPENCODE_CONFIG_DIR;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    delete process.env.RALPH_OPENCODE_CONFIG_DIR;
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorOverride) process.env.RALPH_OPENCODE_CONFIG_DIR = priorOverride;
    else delete process.env.RALPH_OPENCODE_CONFIG_DIR;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("installs and overwrites the managed config", async () => {
    const mod = await import("../opencode-managed-config?managed-config-test");
    const managedDir = getRalphOpencodeConfigDir();
    const manifest = mod.getManagedOpencodeConfigManifest(managedDir);

    mod.ensureManagedOpencodeConfigInstalled(managedDir);

    for (const file of manifest.files) {
      const contents = await readFile(file.path, "utf8");
      expect(contents).toBe(file.contents);
    }

    await writeFile(manifest.files[0].path, "overwritten", "utf8");
    mod.ensureManagedOpencodeConfigInstalled(managedDir);
    const restored = await readFile(manifest.files[0].path, "utf8");
    expect(restored).toBe(manifest.files[0].contents);
  });
});
