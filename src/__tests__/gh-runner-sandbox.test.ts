import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { getRalphConfigJsonPath } from "../paths";
import { __resetConfigForTests } from "../config";
import { createGhRunner } from "../github/gh-runner";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorToken: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("gh runner sandbox guard", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
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
      },
    });
    __resetConfigForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("ghRead rejects write commands", () => {
    const ghRead = createGhRunner({ repo: "3mdistal/ralph-sandbox-demo", mode: "read" });
    expect(() => ghRead`gh pr merge 123 --repo 3mdistal/ralph-sandbox-demo`).toThrow(/ghRead/);
  });

  test("ghRead rejects unknown commands in sandbox", () => {
    const ghRead = createGhRunner({ repo: "3mdistal/ralph-sandbox-demo", mode: "read" });
    expect(() => ghRead`gh magic unknown`).toThrow(/SANDBOX TRIPWIRE/i);
  });

  test("ghWrite blocks writes outside sandbox boundary", () => {
    const ghWrite = createGhRunner({ repo: "3mdistal/prod-repo", mode: "write" });
    expect(() => ghWrite`gh issue comment 1 --repo 3mdistal/prod-repo --body test`).toThrow(/SANDBOX TRIPWIRE/i);
  });
});
