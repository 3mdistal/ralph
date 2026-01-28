import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

const ghCalls: Array<{ repo: string; mode: string; command: string; cwd: string | null }> = [];

mock.module("../github/gh-runner", () => ({
  createGhRunner: ({ repo, mode }: { repo: string; mode: string }) => {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
      let cwd: string | null = null;

      let command = strings[0] ?? "";
      for (let i = 0; i < values.length; i += 1) {
        command += String(values[i] ?? "");
        command += strings[i + 1] ?? "";
      }
      command = command.trim();

      const proc = {
        cwd: (path: string) => {
          cwd = path;
          return proc;
        },
        quiet: async () => {
          ghCalls.push({ repo, mode, command, cwd });
          return { stdout: "" };
        },
      };

      return proc;
    };
  },
}));

import { RepoWorker } from "../worker";

afterAll(() => {
  mock.restore();
});

beforeEach(async () => {
  releaseLock = await acquireGlobalTestLock();
  priorHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
  process.env.HOME = homeDir;
  __resetConfigForTests();

  await writeJson(getRalphConfigJsonPath(), {
    repos: [],
    maxWorkers: 1,
    batchSize: 10,
    pollInterval: 30_000,
    bwrbVault: "/tmp", 
    owner: "3mdistal",
    allowedOwners: ["3mdistal"],
    devDir: "/tmp",
    profile: "prod",
  });
  __resetConfigForTests();
  ghCalls.length = 0;
});

afterEach(async () => {
  process.env.HOME = priorHome;
  await rm(homeDir, { recursive: true, force: true });
  __resetConfigForTests();
  releaseLock?.();
  releaseLock = null;
});

test("mergePullRequest uses the GitHub merge API (non-interactive)", async () => {
  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  await (worker as any).mergePullRequest("https://github.com/3mdistal/ralph/pull/999", "deadbeef", "/tmp/cwd");

  expect(ghCalls).toHaveLength(1);
  expect(ghCalls[0]?.mode).toBe("write");
  expect(ghCalls[0]?.cwd).toBe("/tmp/cwd");
  expect(ghCalls[0]?.command).toContain("gh api");
  expect(ghCalls[0]?.command).toContain("-X PUT");
  expect(ghCalls[0]?.command).toContain("/repos/3mdistal/ralph/pulls/999/merge");
  expect(ghCalls[0]?.command).toContain("-f merge_method=merge");
  expect(ghCalls[0]?.command).toContain("-f sha=deadbeef");
  expect(ghCalls[0]?.command).not.toContain("gh pr merge");
});
