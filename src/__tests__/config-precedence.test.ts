import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath, getRalphConfigTomlPath, getRalphLegacyConfigPath } from "../paths";

let homeDir: string;
let priorHome: string | undefined;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("Config precedence (~/.ralph)", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("prefers ~/.ralph/config.toml over ~/.ralph/config.json", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    const configJsonPath = getRalphConfigJsonPath();

    await mkdir(join(homeDir, ".ralph"), { recursive: true });
    await writeFile(
      configTomlPath,
      [
        'bwrbVault = "toml-vault"',
        "maxWorkers = 3",
        "batchSize = 11",
        "pollInterval = 12345",
        "owner = \"toml-owner\"",
        "devDir = \"/tmp/toml-dev\"",
        "repos = [{ name = \"demo/repo\", rollupBatchSize = 4 }]",
        "",
      ].join("\n"),
      "utf8"
    );

    await writeJson(configJsonPath, {
      bwrbVault: "json-vault",
      maxWorkers: 2,
      batchSize: 99,
      repos: [{ name: "demo/repo", rollupBatchSize: 22 }],
    });

    const cfgMod = await import("../config?config-precedence");
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig();

    expect(cfg.bwrbVault).toBe("toml-vault");
    expect(cfg.maxWorkers).toBe(3);
    expect(cfg.batchSize).toBe(11);
    expect(cfg.owner).toBe("toml-owner");
    expect(cfg.repos[0]?.rollupBatchSize).toBe(4);
  });

  test("falls back to ~/.ralph/config.json when TOML missing", async () => {
    const configJsonPath = getRalphConfigJsonPath();

    await writeJson(configJsonPath, {
      bwrbVault: "json-vault",
      maxWorkers: 4,
      repos: [],
    });

    const cfgMod = await import("../config?config-precedence");
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig();

    expect(cfg.bwrbVault).toBe("json-vault");
    expect(cfg.maxWorkers).toBe(4);
  });

  test("falls back to legacy ~/.config/opencode/ralph/ralph.json with warning", async () => {
    const legacyPath = getRalphLegacyConfigPath();
    await writeJson(legacyPath, {
      bwrbVault: "legacy-vault",
      maxWorkers: 5,
      repos: [],
    });

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      const cfgMod = await import("../config?config-precedence");
      cfgMod.__resetConfigForTests();
      const cfg = cfgMod.loadConfig();

      expect(cfg.bwrbVault).toBe("legacy-vault");
      expect(cfg.maxWorkers).toBe(5);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
    }
  });
});
