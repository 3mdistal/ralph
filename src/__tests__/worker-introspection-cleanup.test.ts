import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { cleanupIntrospectionLogs } from "../worker/introspection";
import { getRalphConfigJsonPath } from "../paths";
import { __resetConfigForTests } from "../config";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let sessionsDir: string;
let priorHome: string | undefined;
let priorToken: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("cleanupIntrospectionLogs", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorToken = process.env.GITHUB_SANDBOX_TOKEN;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    sessionsDir = await mkdtemp(join(tmpdir(), "ralph-sessions-"));
    process.env.HOME = homeDir;
    process.env.RALPH_SESSIONS_DIR = sessionsDir;
    process.env.GITHUB_SANDBOX_TOKEN = "token";

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
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorToken === undefined) delete process.env.GITHUB_SANDBOX_TOKEN;
    else process.env.GITHUB_SANDBOX_TOKEN = priorToken;
    delete process.env.RALPH_SESSIONS_DIR;
    await rm(homeDir, { recursive: true, force: true });
    await rm(sessionsDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("skips cleanup in sandbox profile", async () => {
    const sessionId = "ses_keep_sandbox";
    const sessionDir = join(sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "events.jsonl"), "{}\n");
    await writeFile(join(sessionDir, "summary.json"), "summary");

    await cleanupIntrospectionLogs(sessionId);

    expect(existsSync(join(sessionDir, "summary.json"))).toBe(true);
    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
  });
});
