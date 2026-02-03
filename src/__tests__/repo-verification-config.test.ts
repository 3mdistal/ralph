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

describe("repos[].verification config", () => {
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

  test("reads verification config from TOML", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    await writeToml(
      configTomlPath,
      [
        "maxWorkers = 1",
        "ownershipTtlMs = 60000",
        "repos = [{ name = \"demo/repo\", verification = { preflight = [\"bun test\"], e2e = [{ title = \"Login\", steps = [\"Sign in\", \"Sign out\"] }], staging = [{ url = \"https://staging.example.test\", expected = \"Loads\" }] } } ]",
        "",
      ].join("\n")
    );

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoVerificationConfig("demo/repo")).toEqual({
      preflight: ["bun test"],
      e2e: [{ title: "Login", steps: ["Sign in", "Sign out"] }],
      staging: [{ url: "https://staging.example.test", expected: "Loads" }],
    });
  });

  test("reads verification config from JSON", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [
        {
          name: "demo/repo",
          verification: {
            preflight: ["bun test"],
            e2e: [{ steps: ["Create record"] }],
            staging: [{ url: "https://preview.example.test" }],
          },
        },
      ],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(cfgMod.getRepoVerificationConfig("demo/repo")).toEqual({
      preflight: ["bun test"],
      e2e: [{ steps: ["Create record"] }],
      staging: [{ url: "https://preview.example.test" }],
    });
  });

  test("warns and drops invalid verification values", async () => {
    const configJsonPath = getRalphConfigJsonPath();
    await writeJson(configJsonPath, {
      maxWorkers: 1,
      ownershipTtlMs: 60000,
      repos: [
        {
          name: "demo/repo",
          verification: {
            preflight: ["", 123],
            e2e: [{ steps: [] }, "bad"],
            staging: [{ url: "" }, { url: 123 }],
          },
        },
      ],
    });

    const warn = mock(() => {});
    const priorWarn = console.warn;
    console.warn = warn as any;

    try {
      const cfgMod = await import("../config");
      cfgMod.__resetConfigForTests();
      expect(cfgMod.getRepoVerificationConfig("demo/repo")).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = priorWarn;
    }
  });
});
