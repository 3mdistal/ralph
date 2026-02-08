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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

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
    restoreEnv("HOME", priorHome);
    restoreEnv("GH_TOKEN", priorGhToken);
    restoreEnv("GITHUB_TOKEN", priorGithubToken);

    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    __resetQueueBackendStateForTests();
  });

  test("defaults queueBackend to github", () => {
    const cfg = loadConfig().config;
    expect(cfg.queueBackend).toBe("github");
  });

  test("falls back to none when GitHub auth is missing", async () => {
    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      repos: [],
    });

    __resetConfigForTests();
    __resetQueueBackendStateForTests();

    const state = getQueueBackendState();
    expect(state.desiredBackend).toBe("github");
    expect(state.backend).toBe("none");
    expect(state.health).toBe("degraded");
    expect(state.fallback).toBe(true);
    expect(state.diagnostics ?? "").toContain("auth is not configured");
  });

  test("explicit github is unavailable when auth is missing", async () => {
    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      queueBackend: "github",
      repos: [],
    });

    __resetConfigForTests();
    __resetQueueBackendStateForTests();

    const state = getQueueBackendState();
    expect(state.desiredBackend).toBe("github");
    expect(state.backend).toBe("github");
    expect(state.health).toBe("unavailable");
    expect(state.fallback).toBe(false);
    expect(state.diagnostics ?? "").toContain("auth is not configured");
  });

  test("uses github backend when auth is configured", async () => {
    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      queueBackend: "github",
      repos: [],
    });

    const priorToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "token";

    try {
      __resetConfigForTests();
      __resetQueueBackendStateForTests();

      const state = getQueueBackendState();
      expect(state.desiredBackend).toBe("github");
      expect(state.backend).toBe("github");
      expect(state.health).toBe("ok");
      expect(state.fallback).toBe(false);
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = priorToken;
    }
  });

  test("invalid queueBackend is treated as explicit and unavailable", async () => {
    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      queueBackend: "githb",
      repos: [],
    });

    __resetConfigForTests();
    __resetQueueBackendStateForTests();

    const state = getQueueBackendState();
    expect(state.desiredBackend).toBe("github");
    expect(state.backend).toBe("github");
    expect(state.health).toBe("unavailable");
    expect(state.fallback).toBe(false);
    expect(state.diagnostics ?? "").toContain("Invalid queueBackend");
  });
});
