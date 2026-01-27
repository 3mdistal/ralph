import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("repos[].concurrencySlots config", () => {
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

  test("prefers concurrencySlots over maxWorkers", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", concurrencySlots: 3, maxWorkers: 2 }],
    });

    const cfgMod = await import("../config?repo-concurrency");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoConcurrencySlots("demo/repo")).toBe(3);
  });

  test("falls back to maxWorkers when concurrencySlots unset", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", maxWorkers: 4 }],
    });

    const cfgMod = await import("../config?repo-concurrency-max");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoConcurrencySlots("demo/repo")).toBe(4);
  });

  test("invalid concurrencySlots falls back to default", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", concurrencySlots: 0 }],
    });

    const cfgMod = await import("../config?repo-concurrency-invalid");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoConcurrencySlots("demo/repo")).toBe(1);
  });
});
