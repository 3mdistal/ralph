import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { RepoWorker } from "../worker";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorGhToken: string | undefined;
let priorGithubToken: string | undefined;
let releaseLock: (() => void) | null = null;

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

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/ralph#392",
    repo: "3mdistal/ralph",
    status: "queued",
    priority: "p2-medium",
    name: "Test Task",
    ...overrides,
  } as any;
}

describe("agent-run note warnings", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();

    priorHome = process.env.HOME;
    priorGhToken = process.env.GH_TOKEN;
    priorGithubToken = process.env.GITHUB_TOKEN;

    process.env.GH_TOKEN = "";
    process.env.GITHUB_TOKEN = "";

    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;

    __resetConfigForTests();
  });

  afterEach(async () => {
    restoreEnv("HOME", priorHome);
    restoreEnv("GH_TOKEN", priorGhToken);
    restoreEnv("GITHUB_TOKEN", priorGithubToken);

    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();

    releaseLock?.();
    releaseLock = null;
  });

  test("github tasks skip agent-run warnings", async () => {
    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      bwrbVault: join(homeDir, "missing-vault"),
      repos: [],
    });
    __resetConfigForTests();

    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const warnMock = mock((..._args: unknown[]) => {});
    const priorWarn = console.warn;
    console.warn = warnMock;

    try {
      const task = createMockTask({
        _path: "github:3mdistal/ralph#392",
      });

      await (worker as any).createAgentRun(task, {
        outcome: "success",
        started: new Date("2026-01-01T00:00:00Z"),
        completed: new Date("2026-01-01T00:00:10Z"),
      });
    } finally {
      console.warn = priorWarn;
    }

    expect(warnMock).not.toHaveBeenCalled();
  });

  test("vault-backed tasks warn when task note is missing", async () => {
    const vaultPath = join(homeDir, "vault");
    await mkdir(join(vaultPath, ".bwrb"), { recursive: true });
    await writeFile(join(vaultPath, ".bwrb", "schema.json"), "{}", "utf8");

    const configPath = getRalphConfigJsonPath();
    await writeJson(configPath, {
      bwrbVault: vaultPath,
      repos: [],
    });
    __resetConfigForTests();

    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const warnMock = mock((..._args: unknown[]) => {});
    const priorWarn = console.warn;
    console.warn = warnMock;

    try {
      const task = createMockTask({
        _path: "orchestration/tasks/missing-task.md",
      });

      await (worker as any).createAgentRun(task, {
        outcome: "success",
        started: new Date("2026-01-01T00:00:00Z"),
        completed: new Date("2026-01-01T00:00:10Z"),
      });
    } finally {
      console.warn = priorWarn;
    }

    expect(warnMock).toHaveBeenCalled();
    const warningText = warnMock.mock.calls[0]?.[0] ?? "";
    expect(String(warningText)).toContain("Skipping agent-run note; task note missing");
  });
});
