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

describe("sandbox config validation", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    __resetConfigForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
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

    const cfgMod = await import("../config?sandbox-default");
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

    const cfgMod = await import("../config?sandbox-missing");
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

    const cfgMod = await import("../config?sandbox-token");
    cfgMod.__resetConfigForTests();
    expect(() => cfgMod.loadConfig()).toThrow(/GITHUB_SANDBOX_TOKEN/i);

    process.env.GITHUB_SANDBOX_TOKEN = "token";
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;
    expect(cfg.profile).toBe("sandbox");

    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
  });
});
