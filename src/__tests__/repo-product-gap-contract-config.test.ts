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

describe("repos[].productGapDeterministicContract config", () => {
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

  test("returns true when repo opts into required contract", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", productGapDeterministicContract: "required" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.isRepoProductGapDeterministicContractRequired("demo/repo")).toBe(true);
  });

  test("defaults to non-blocking when repo does not opt in", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.isRepoProductGapDeterministicContractRequired("demo/repo")).toBe(false);
  });
});
