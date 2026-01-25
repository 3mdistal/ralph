import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
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

  test("reads setup commands when valid", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      bwrbVault: "vault",
      repos: [
        {
          name: "demo/repo",
          setup: ["pnpm install --frozen-lockfile", "  npm test  "],
        },
      ],
    });

    const cfgMod = await import("../config?config-setup-valid");
    cfgMod.__resetConfigForTests();

    const commands = cfgMod.getRepoSetupCommands("demo/repo");
    expect(commands).toEqual(["pnpm install --frozen-lockfile", "npm test"]);
  });

  test("invalid setup config is ignored with warning", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      bwrbVault: "vault",
      repos: [
        {
          name: "demo/repo",
          setup: ["pnpm install", 123],
        },
      ],
    });

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      const cfgMod = await import("../config?config-setup-invalid");
      cfgMod.__resetConfigForTests();

      const commands = cfgMod.getRepoSetupCommands("demo/repo");
      expect(commands).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
    }
  });

  test("missing setup config yields empty list", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      bwrbVault: "vault",
      repos: [{ name: "demo/repo" }],
    });

    const cfgMod = await import("../config?config-setup-missing");
    cfgMod.__resetConfigForTests();

    const commands = cfgMod.getRepoSetupCommands("demo/repo");
    expect(commands).toEqual([]);
  });
});
