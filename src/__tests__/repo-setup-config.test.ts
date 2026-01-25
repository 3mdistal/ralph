import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath, getRalphConfigTomlPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeToml(path: string, body: string): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(path, body, "utf8");
}

describe("repos[].setup config", () => {
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

  test("reads valid setup commands from TOML", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    await writeToml(
      configTomlPath,
      [
        "maxWorkers = 1",
        "ownershipTtlMs = 60000",
        "repos = [{ name = \"demo/repo\", setup = [\"bun install --frozen-lockfile\"] }]",
        "",
      ].join("\n")
    );

    const cfgMod = await import("../config?repo-setup-config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoSetupCommands("demo/repo")).toEqual(["bun install --frozen-lockfile"]);
  });

  test("returns empty array when setup is []", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    await writeToml(
      configTomlPath,
      ["maxWorkers = 1", "ownershipTtlMs = 60000", "repos = [{ name = \"demo/repo\", setup = [] }]", ""].join(
        "\n"
      )
    );

    const cfgMod = await import("../config?repo-setup-empty");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoSetupCommands("demo/repo")).toEqual([]);
  });

  test("warns and ignores invalid setup values", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeFile(
      configJsonPath,
      JSON.stringify(
        {
          maxWorkers: 1,
          ownershipTtlMs: 60000,
          repos: [{ name: "demo/repo", setup: ["", 123] }],
        },
        null,
        2
      ),
      "utf8"
    );

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      const cfgMod = await import("../config?repo-setup-invalid");
      cfgMod.__resetConfigForTests();
      expect(cfgMod.getRepoSetupCommands("demo/repo")).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
    }
  });
});
