import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorGhToken: string | undefined;
let priorGithubToken: string | undefined;
let priorSandboxToken: string | undefined;
let priorDollar: unknown;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("gh runner env scoping", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorGhToken = process.env.GH_TOKEN;
    priorGithubToken = process.env.GITHUB_TOKEN;
    priorSandboxToken = process.env.GITHUB_SANDBOX_TOKEN;
    priorDollar = (globalThis as any).$;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    __resetConfigForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorGhToken;
    if (priorGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorGithubToken;
    if (priorSandboxToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorSandboxToken;
    (globalThis as any).$ = priorDollar;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("restores GH_TOKEN between sandbox and prod", async () => {
    const snapshots: Array<{ gh: string | undefined; github: string | undefined }> = [];

    (globalThis as any).$ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const stub: any = {
        cwd: () => stub,
        quiet: async () => {
          snapshots.push({
            gh: process.env.GH_TOKEN,
            github: process.env.GITHUB_TOKEN,
          });
          return { stdout: "" } as any;
        },
      };
      return stub;
    }) as any;

    process.env.GH_TOKEN = "prod-token";
    process.env.GITHUB_TOKEN = "prod-token";
    process.env.GITHUB_SANDBOX_TOKEN = "sandbox-token";

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
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
    __resetConfigForTests();

    const ghModule = await import("../github/gh-runner");
    const ghRead = ghModule.createGhRunner({ repo: "3mdistal/ralph-sandbox-demo", mode: "read" });
    await ghRead`gh issue view 1 --repo 3mdistal/ralph-sandbox-demo`.quiet();

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

    await ghRead`gh issue view 1 --repo 3mdistal/ralph-sandbox-demo`.quiet();

    expect(snapshots[0]).toEqual({ gh: "sandbox-token", github: "sandbox-token" });
    expect(snapshots[1]).toEqual({ gh: "prod-token", github: "prod-token" });
    expect(process.env.GH_TOKEN).toBe("prod-token");
    expect(process.env.GITHUB_TOKEN).toBe("prod-token");
  });

  test("annotates gh failures with ghCommand", async () => {
    (globalThis as any).$ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const stub: any = {
        cwd: () => stub,
        quiet: async () => {
          const err: any = new Error("ShellError: Failed with exit code 1");
          err.stderr = "HTTP 405: Required status checks are expected.";
          throw err;
        },
      };
      return stub;
    }) as any;

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

    const ghModule = await import("../github/gh-runner");
    const ghRead = ghModule.createGhRunner({ repo: "3mdistal/ralph", mode: "read" });

    let caught: any = null;
    try {
      await ghRead`gh issue view 1 --repo 3mdistal/ralph`.quiet();
    } catch (e: any) {
      caught = e;
    }

    expect(caught).toBeTruthy();
    expect(caught.ghCommand).toContain("gh issue view 1 --repo 3mdistal/ralph");
    expect(caught.ghRepo).toBe("3mdistal/ralph");
    expect(caught.ghMode).toBe("read");
  });
});
