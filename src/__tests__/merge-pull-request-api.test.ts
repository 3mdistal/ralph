import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { RepoWorker } from "../worker";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorGhToken: string | undefined;
let priorGithubToken: string | undefined;
let priorDollar: unknown;
let releaseLock: (() => void) | null = null;

type GhCall = { command: string; cwd: string | null };

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

function buildCommand(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += String(values[i] ?? "");
    out += strings[i + 1] ?? "";
  }
  return out.trim();
}

beforeEach(async () => {
  releaseLock = await acquireGlobalTestLock();
  priorHome = process.env.HOME;
  priorGhToken = process.env.GH_TOKEN;
  priorGithubToken = process.env.GITHUB_TOKEN;
  priorDollar = (globalThis as any).$;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
  process.env.HOME = homeDir;

  process.env.GH_TOKEN = "token";
  process.env.GITHUB_TOKEN = "token";

  await writeJson(getRalphConfigJsonPath(), {
    repos: [],
    maxWorkers: 1,
    batchSize: 10,
    pollInterval: 30_000,
    owner: "3mdistal",
    allowedOwners: ["3mdistal"],
    devDir: "/tmp",
    profile: "prod",
  });
  __resetConfigForTests();
});

afterEach(async () => {
  process.env.HOME = priorHome;
  if (priorGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = priorGhToken;
  if (priorGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = priorGithubToken;
  (globalThis as any).$ = priorDollar;

  await rm(homeDir, { recursive: true, force: true });
  __resetConfigForTests();
  releaseLock?.();
  releaseLock = null;
});

test("mergePullRequest uses the GitHub merge API (non-interactive)", async () => {
  const calls: GhCall[] = [];

  (globalThis as any).$ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let cwd: string | null = null;

    const stub: any = {
      cwd: (path: string) => {
        cwd = path;
        return stub;
      },
      quiet: async () => {
        calls.push({ command: buildCommand(strings, values), cwd });
        return { stdout: "" } as any;
      },
    };

    return stub;
  }) as any;

  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  await (worker as any).mergePullRequest("https://github.com/3mdistal/ralph/pull/999", "deadbeef", "/tmp/cwd");

  expect(calls).toHaveLength(1);
  expect(calls[0]?.cwd).toBe("/tmp/cwd");
  expect(calls[0]?.command).toContain("gh api");
  expect(calls[0]?.command).toContain("-X PUT");
  expect(calls[0]?.command).toContain("/repos/3mdistal/ralph/pulls/999/merge");
  expect(calls[0]?.command).toContain("-f merge_method=merge");
  expect(calls[0]?.command).toContain("-f sha=deadbeef");
  expect(calls[0]?.command).not.toContain("gh pr merge");
});
