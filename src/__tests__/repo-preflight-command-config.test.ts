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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("repos[].preflightCommand config", () => {
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

  test("reads preflightCommand as string from TOML", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    await writeToml(
      configTomlPath,
      [
        "maxWorkers = 1",
        "ownershipTtlMs = 60000",
        "repos = [{ name = \"demo/repo\", preflightCommand = \"bun test\" }]",
        "",
      ].join("\n")
    );

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoPreflightCommands("demo/repo")).toEqual({
      commands: ["bun test"],
      source: "preflightCommand",
      configured: true,
      invalid: false,
    });
  });

  test("reads preflightCommand as array from JSON", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", preflightCommand: ["bun test", "bun run typecheck"] }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoPreflightCommands("demo/repo")).toEqual({
      commands: ["bun test", "bun run typecheck"],
      source: "preflightCommand",
      configured: true,
      invalid: false,
    });
  });

  test("preflightCommand takes precedence over verification.preflight", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [
        {
          name: "demo/repo",
          preflightCommand: "bun test",
          verification: { preflight: ["bun run legacy"] },
        },
      ],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoPreflightCommands("demo/repo")).toEqual({
      commands: ["bun test"],
      source: "preflightCommand",
      configured: true,
      invalid: false,
    });
  });

  test("falls back to verification.preflight when preflightCommand missing", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", verification: { preflight: ["bun test"] } }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoPreflightCommands("demo/repo")).toEqual({
      commands: ["bun test"],
      source: "verification.preflight",
      configured: true,
      invalid: false,
    });
  });

  test("marks invalid preflightCommand as configured-invalid", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [{ name: "demo/repo", preflightCommand: ["", 123] }],
    });

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      const cfgMod = await import("../config");
      cfgMod.__resetConfigForTests();
      expect(cfgMod.getRepoPreflightCommands("demo/repo")).toEqual({
        commands: [],
        source: "preflightCommand",
        configured: true,
        invalid: true,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
    }
  });
});
