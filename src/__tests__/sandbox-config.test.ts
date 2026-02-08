import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath } from "../paths";
import { __resetConfigForTests } from "../config";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

async function writeManifest(home: string, runId: string, manifest: Record<string, unknown>): Promise<string> {
  const manifestPath = join(home, ".ralph", "sandbox", "manifests", `${runId}.json`);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

describe("sandbox config validation", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    delete process.env.RALPH_PROFILE;
    delete process.env.RALPH_SANDBOX_TARGET_FROM_MANIFEST;
    delete process.env.RALPH_SANDBOX_RUN_ID;
    __resetConfigForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    delete process.env.RALPH_PROFILE;
    delete process.env.RALPH_SANDBOX_TARGET_FROM_MANIFEST;
    delete process.env.RALPH_SANDBOX_RUN_ID;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("defaults profile to prod when unset", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;

    expect(cfg.profile).toBe("prod");
  });

  test("requires sandbox block when profile is sandbox", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      profile: "sandbox",
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(() => cfgMod.loadConfig()).toThrow(/sandbox config block/i);
  });

  test("requires token env var when sandbox uses tokenEnvVar", async () => {
    const priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    delete process.env.GITHUB_SANDBOX_TOKEN;

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      profile: "sandbox",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
      },
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(() => cfgMod.loadConfig()).toThrow(/GITHUB_SANDBOX_TOKEN/i);

    process.env.GITHUB_SANDBOX_TOKEN = "token";
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;
    expect(cfg.profile).toBe("sandbox");

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });

  test("accepts sandbox provisioning config", async () => {
    const priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    process.env.GITHUB_SANDBOX_TOKEN = "token";

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      profile: "sandbox",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
        provisioning: {
          templateRepo: "3mdistal/ralph-template",
          templateRef: "main",
          repoVisibility: "private",
          settingsPreset: "minimal",
          seed: { preset: "baseline" },
        },
      },
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;
    expect(cfg.sandbox?.provisioning?.templateRepo).toBe("3mdistal/ralph-template");

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });

  test("rejects sandbox provisioning with non-private visibility", async () => {
    const priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    process.env.GITHUB_SANDBOX_TOKEN = "token";

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      profile: "sandbox",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
        provisioning: {
          templateRepo: "3mdistal/ralph-template",
          repoVisibility: "public",
        },
      },
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(() => cfgMod.loadConfig()).toThrow(/repoVisibility/i);

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });

  test("rejects sandbox provisioning seed with relative file path", async () => {
    const priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    process.env.GITHUB_SANDBOX_TOKEN = "token";

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
      profile: "sandbox",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
        provisioning: {
          templateRepo: "3mdistal/ralph-template",
          seed: { file: "seed.json" },
        },
      },
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    expect(() => cfgMod.loadConfig()).toThrow(/absolute path/i);

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });

  test("resolves sandbox target repo from newest valid manifest", async () => {
    const priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    process.env.GITHUB_SANDBOX_TOKEN = "token";
    process.env.RALPH_SANDBOX_TARGET_FROM_MANIFEST = "1";

    await writeJson(getRalphConfigJsonPath(), {
      repos: [{ name: "3mdistal/ignored", path: "/tmp/ignored", botBranch: "bot/integration" }],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp/dev",
      profile: "sandbox",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
      },
    });

    await writeManifest(homeDir, "sandbox-old", {
      schemaVersion: 1,
      runId: "sandbox-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      templateRepo: "3mdistal/ralph-template",
      templateRef: "main",
      repo: { fullName: "3mdistal/ralph-sandbox-old", url: "https://example.com", visibility: "private" },
      settingsPreset: "minimal",
      defaultBranch: "main",
      botBranch: "bot/integration",
      steps: {},
    });

    await writeManifest(homeDir, "sandbox-new", {
      schemaVersion: 1,
      runId: "sandbox-new",
      createdAt: "2026-02-01T00:00:00.000Z",
      templateRepo: "3mdistal/ralph-template",
      templateRef: "main",
      repo: { fullName: "3mdistal/ralph-sandbox-new", url: "https://example.com", visibility: "private" },
      settingsPreset: "minimal",
      defaultBranch: "main",
      botBranch: "bot/integration",
      steps: {},
    });

    await writeManifest(homeDir, "sandbox-invalid", {
      schemaVersion: 99,
      runId: "sandbox-invalid",
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;
    expect(cfg.repos).toHaveLength(1);
    expect(cfg.repos[0]?.name).toBe("3mdistal/ralph-sandbox-new");
    expect(cfg.repos[0]?.path).toBe("/tmp/dev/ralph-sandbox-new");

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });

  test("supports env profile override and exact run-id selection", async () => {
    const priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    process.env.GITHUB_SANDBOX_TOKEN = "token";
    process.env.RALPH_PROFILE = "sandbox";
    process.env.RALPH_SANDBOX_TARGET_FROM_MANIFEST = "1";
    process.env.RALPH_SANDBOX_RUN_ID = "sandbox-picked";

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp/dev",
      profile: "prod",
      sandbox: {
        allowedOwners: ["3mdistal"],
        repoNamePrefix: "ralph-sandbox-",
        githubAuth: { tokenEnvVar: "GITHUB_SANDBOX_TOKEN" },
      },
    });

    await writeManifest(homeDir, "sandbox-picked", {
      schemaVersion: 1,
      runId: "sandbox-picked",
      createdAt: "2026-02-01T00:00:00.000Z",
      templateRepo: "3mdistal/ralph-template",
      templateRef: "main",
      repo: { fullName: "3mdistal/ralph-sandbox-picked", url: "https://example.com", visibility: "private" },
      settingsPreset: "minimal",
      defaultBranch: "main",
      botBranch: "bot/integration",
      steps: {},
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;
    expect(cfg.profile).toBe("sandbox");
    expect(cfg.repos).toHaveLength(1);
    expect(cfg.repos[0]?.name).toBe("3mdistal/ralph-sandbox-picked");

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });
});
