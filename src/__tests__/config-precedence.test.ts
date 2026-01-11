import { describe, test, expect, mock } from "bun:test";
import crypto from "crypto";
import { existsSync } from "fs";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";

import { getRalphConfigJsonPath, getRalphConfigTomlPath, getRalphLegacyConfigPath } from "../paths";

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function backupFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const backupPath = `${path}.bak.${crypto.randomUUID()}`;
  await rename(path, backupPath);
  return backupPath;
}

async function restoreFile(path: string, backupPath: string | null): Promise<void> {
  if (backupPath) {
    if (existsSync(path)) {
      await rm(path, { force: true });
    }
    await rename(backupPath, path);
    return;
  }

  await rm(path, { force: true });
}

describe("Config precedence (~/.ralph)", () => {
  test("prefers ~/.ralph/config.toml over ~/.ralph/config.json", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    const configJsonPath = getRalphConfigJsonPath();
    const legacyPath = getRalphLegacyConfigPath();

    const tomlBak = await backupFile(configTomlPath);
    const jsonBak = await backupFile(configJsonPath);
    const legacyBak = await backupFile(legacyPath);

    try {
      await writeText(
        configTomlPath,
        [
          'bwrbVault = "toml-vault"',
          "maxWorkers = 3",
          "batchSize = 11",
          "pollInterval = 12345",
          "owner = \"toml-owner\"",
          "devDir = \"/tmp/toml-dev\"",
          "repos = []",
          "",
        ].join("\n")
      );

      await writeJson(configJsonPath, {
        bwrbVault: "json-vault",
        maxWorkers: 2,
        batchSize: 99,
        repos: [],
      });

      const cfgMod = await import("../config");
      cfgMod.__resetConfigForTests();
      const cfg = cfgMod.loadConfig();

      expect(cfg.bwrbVault).toBe("toml-vault");
      expect(cfg.maxWorkers).toBe(3);
      expect(cfg.batchSize).toBe(11);
      expect(cfg.owner).toBe("toml-owner");
    } finally {
      await restoreFile(configTomlPath, tomlBak);
      await restoreFile(configJsonPath, jsonBak);
      await restoreFile(legacyPath, legacyBak);
    }
  });

  test("falls back to ~/.ralph/config.json when TOML missing", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    const configJsonPath = getRalphConfigJsonPath();
    const legacyPath = getRalphLegacyConfigPath();

    const tomlBak = await backupFile(configTomlPath);
    const jsonBak = await backupFile(configJsonPath);
    const legacyBak = await backupFile(legacyPath);

    try {
      await rm(configTomlPath, { force: true });

      await writeJson(configJsonPath, {
        bwrbVault: "json-vault",
        maxWorkers: 4,
        repos: [],
      });

      const cfgMod = await import("../config");
      cfgMod.__resetConfigForTests();
      const cfg = cfgMod.loadConfig();

      expect(cfg.bwrbVault).toBe("json-vault");
      expect(cfg.maxWorkers).toBe(4);
    } finally {
      await restoreFile(configTomlPath, tomlBak);
      await restoreFile(configJsonPath, jsonBak);
      await restoreFile(legacyPath, legacyBak);
    }
  });

  test("falls back to legacy ~/.config/opencode/ralph/ralph.json with warning", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    const configJsonPath = getRalphConfigJsonPath();
    const legacyPath = getRalphLegacyConfigPath();

    const tomlBak = await backupFile(configTomlPath);
    const jsonBak = await backupFile(configJsonPath);
    const legacyBak = await backupFile(legacyPath);

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      await rm(configTomlPath, { force: true });
      await rm(configJsonPath, { force: true });

      await writeJson(legacyPath, {
        bwrbVault: "legacy-vault",
        maxWorkers: 5,
        repos: [],
      });

      const cfgMod = await import("../config");
      cfgMod.__resetConfigForTests();
      const cfg = cfgMod.loadConfig();

      expect(cfg.bwrbVault).toBe("legacy-vault");
      expect(cfg.maxWorkers).toBe(5);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
      await restoreFile(configTomlPath, tomlBak);
      await restoreFile(configJsonPath, jsonBak);
      await restoreFile(legacyPath, legacyBak);
    }
  });
});
