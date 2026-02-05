import { afterEach, beforeEach, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { __resetConfigForTests } from "../config";
import { __resetQueueBackendStateForTests } from "../queue-backend";
import { __resetBwrbRunnerForTests, __setBwrbRunnerForTests } from "../queue";
import { closeStateDbForTests, initStateDb, recordIdempotencyKey } from "../state";
import { runStatusCommand } from "../commands/status";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir = "";
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

function createMockBwrbRunner() {
  return (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const runner = {
      cwd: () => runner,
      quiet: async () => ({ stdout: Buffer.from("[]") }),
    };
    return runner;
  };
}

async function setupEnv(): Promise<void> {
  priorHome = process.env.HOME;
  priorStateDb = process.env.RALPH_STATE_DB_PATH;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-depsat-"));
  process.env.HOME = homeDir;
  process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

  const vaultDir = join(homeDir, "vault");
  await mkdir(join(vaultDir, ".bwrb"), { recursive: true });
  await writeFile(join(vaultDir, ".bwrb", "schema.json"), "{}", "utf8");

  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(join(homeDir, ".ralph", "config.json"), JSON.stringify({ queueBackend: "bwrb", bwrbVault: vaultDir }), "utf8");

  __resetConfigForTests();
  __resetQueueBackendStateForTests();
  __resetBwrbRunnerForTests();
  closeStateDbForTests();
  initStateDb();
}

async function teardownEnv(): Promise<void> {
  __resetBwrbRunnerForTests();
  __resetQueueBackendStateForTests();
  __resetConfigForTests();
  closeStateDbForTests();

  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }

  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;

  if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
  else process.env.RALPH_STATE_DB_PATH = priorStateDb;
}

beforeEach(async () => {
  releaseLock = await acquireGlobalTestLock();
  await setupEnv();
});

afterEach(async () => {
  await teardownEnv();
  releaseLock?.();
  releaseLock = null;
});

test("status --json includes dependency satisfaction overrides", async () => {
  __setBwrbRunnerForTests(createMockBwrbRunner());
  recordIdempotencyKey({
    key: "ralph:satisfy:v1:3mdistal/ralph#535",
    scope: "dependency-satisfaction",
    payloadJson: JSON.stringify({ version: 1, satisfiedAt: "2026-02-05T12:00:00.000Z", via: "ralph:cmd:satisfy" }),
    createdAt: "2026-02-05T12:00:00.000Z",
  });

  const logs: string[] = [];
  const priorLog = console.log;
  const priorExit = process.exit;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  (process.exit as any) = () => {
    throw new Error("exit");
  };

  try {
    await runStatusCommand({
      args: ["--json"],
      drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
    });
  } catch (err: any) {
    if (!String(err?.message ?? err).includes("exit")) throw err;
  } finally {
    console.log = priorLog;
    process.exit = priorExit;
  }

  const raw = logs.find((line) => line.trim().startsWith("{")) ?? "";
  const parsed = JSON.parse(raw);
  expect(Array.isArray(parsed.dependencySatisfactionOverrides)).toBe(true);
  expect(parsed.dependencySatisfactionOverrides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        repo: "3mdistal/ralph",
        issueNumber: 535,
        satisfiedAt: "2026-02-05T12:00:00.000Z",
        via: "ralph:cmd:satisfy",
      }),
    ])
  );
});
