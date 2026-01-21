import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath } from "../paths";
import { __resetConfigForTests, loadConfig } from "../config";
import { __resetQueueBackendStateForTests, getQueueBackendState } from "../queue-backend";

let homeDir: string;
let priorHome: string | undefined;
let priorGhToken: string | undefined;
let priorGithubToken: string | undefined;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("queue backend selection", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorGhToken = process.env.GH_TOKEN;
    priorGithubToken = process.env.GITHUB_TOKEN;

    process.env.GH_TOKEN = "";
    process.env.GITHUB_TOKEN = "";

    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;

    __resetConfigForTests();
    __resetQueueBackendStateForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    process.env.GH_TOKEN = priorGhToken;
    process.env.GITHUB_TOKEN = priorGithubToken;

    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    __resetQueueBackendStateForTests();
  });

  test("defaults queueBackend to github", () => {
    const cfg = loadConfig();
    expect(cfg.queueBackend).toBe("github");
  });

  test("falls back to none when GitHub auth missing and backend defaulted", () => {
    const state = getQueueBackendState();
    expect(state.desiredBackend).toBe("github");
    expect(state.backend).toBe("none");
    expect(state.health).toBe("degraded");
  });

  test("explicit github without auth is unavailable", async () => {
    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      queueBackend: "github",
      bwrbVault: "/tmp",
      repos: [],
    });

    __resetConfigForTests();
    __resetQueueBackendStateForTests();

    const state = getQueueBackendState();
    expect(state.desiredBackend).toBe("github");
    expect(state.backend).toBe("github");
    expect(state.health).toBe("unavailable");
  });
});
