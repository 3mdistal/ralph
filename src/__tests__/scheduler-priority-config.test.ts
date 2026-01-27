import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { getRalphConfigJsonPath, getRalphConfigTomlPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeToml(path: string, body: string): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(path, body, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("repos[].schedulerPriority config", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("reads valid schedulerPriority from TOML", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    await writeToml(
      configTomlPath,
      [
        "maxWorkers = 1",
        "ownershipTtlMs = 60000",
        "repos = [{ name = \"demo/repo\", schedulerPriority = 3 }]",
        "",
      ].join("\n")
    );

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoSchedulerPriority("demo/repo")).toBe(3);
  });

  test("warns and defaults invalid schedulerPriority values", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", schedulerPriority: -2 }],
    });

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      const cfgMod = await import("../config");
      cfgMod.__resetConfigForTests();
      expect(cfgMod.getRepoSchedulerPriority("demo/repo")).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
    }
  });
});
