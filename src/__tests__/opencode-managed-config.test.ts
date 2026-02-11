import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { getRalphOpencodeConfigDir } from "../paths";
import { ensureManagedOpencodeConfigInstalled, getManagedOpencodeConfigManifest } from "../opencode-managed-config";
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
    const managedDir = getRalphOpencodeConfigDir();
    const manifest = getManagedOpencodeConfigManifest(managedDir);

    ensureManagedOpencodeConfigInstalled(managedDir);

    for (const file of manifest.files) {
      const contents = await readFile(file.path, "utf8");
      expect(contents).toBe(file.contents);
    }

    await writeFile(manifest.files[0].path, "overwritten", "utf8");
    ensureManagedOpencodeConfigInstalled(managedDir);
    const restored = await readFile(manifest.files[0].path, "utf8");
    expect(restored).toBe(manifest.files[0].contents);
  });

  test("refuses non-managed directories without marker", async () => {
    const unsafeDir = join(homeDir, "not-managed");
    await mkdir(unsafeDir, { recursive: true });
    await writeFile(join(unsafeDir, "notes.txt"), "do not overwrite", "utf8");

    expect(() => ensureManagedOpencodeConfigInstalled(unsafeDir)).toThrow();
  });

  test("allows existing managed layout without marker", async () => {
    const managedDir = join(homeDir, "existing-managed");
    await mkdir(join(managedDir, "agent"), { recursive: true });
    await writeFile(join(managedDir, "opencode.json"), "{}", "utf8");

    ensureManagedOpencodeConfigInstalled(managedDir);
    const markerPath = join(managedDir, ".ralph-managed-opencode");
    const marker = await readFile(markerPath, "utf8");
    expect(marker).toContain("managed by ralph");
  });

  test("includes tool-disabled review agents in managed config", async () => {
    const managedDir = getRalphOpencodeConfigDir();
    const manifest = getManagedOpencodeConfigManifest(managedDir);
    const opencodeConfig = manifest.files.find((file) => file.path.endsWith("/opencode.json"));
    expect(opencodeConfig).toBeDefined();

    const parsed = JSON.parse(opencodeConfig?.contents ?? "{}");
    const productReview = parsed?.agent?.["product-review"];
    const devexReview = parsed?.agent?.["devex-review"];

    expect(productReview?.prompt).toBe("agent/product.md");
    expect(devexReview?.prompt).toBe("agent/devex.md");
    expect(productReview?.permission?.tool).toBe("deny");
    expect(devexReview?.permission?.tool).toBe("deny");
    expect(productReview?.permission?.question).toBe("deny");
    expect(devexReview?.permission?.question).toBe("deny");
  });
});
