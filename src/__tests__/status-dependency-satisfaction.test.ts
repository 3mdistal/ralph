import { afterEach, beforeEach, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { __resetConfigForTests } from "../config";
import { __resetQueueBackendStateForTests } from "../queue-backend";
import { runStatusCommand } from "../commands/status";
import { closeStateDbForTests, initStateDb, recordIdempotencyKey } from "../state";

let homeDir = "";
let priorHome: string | undefined;
let priorStateDb: string | undefined;

async function setupEnv(): Promise<void> {
  priorHome = process.env.HOME;
  priorStateDb = process.env.RALPH_STATE_DB_PATH;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-depsat-"));
  process.env.HOME = homeDir;
  process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(join(homeDir, ".ralph", "config.json"), JSON.stringify({ queueBackend: "none" }), "utf8");

  __resetConfigForTests();
  __resetQueueBackendStateForTests();
  closeStateDbForTests();
  initStateDb();
}

async function teardownEnv(): Promise<void> {
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

async function runStatusJson(): Promise<any> {
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
  return JSON.parse(raw);
}

beforeEach(async () => {
  await setupEnv();
});

afterEach(async () => {
  await teardownEnv();
});

test("status --json includes dependency satisfaction overrides", async () => {
  recordIdempotencyKey({
    key: "ralph:satisfy:v1:3mdistal/ralph#632",
    scope: "dependency-satisfaction",
    payloadJson: JSON.stringify({
      version: 1,
      satisfiedAt: "2026-02-08T19:54:33.474Z",
      via: "ralph:cmd:satisfy",
    }),
    createdAt: "2026-02-08T19:54:33.474Z",
  });

  const parsed = await runStatusJson();
  expect(Array.isArray(parsed.dependencySatisfactionOverrides)).toBe(true);
  expect(parsed.dependencySatisfactionOverrides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        repo: "3mdistal/ralph",
        issueNumber: 632,
        satisfiedAt: "2026-02-08T19:54:33.474Z",
        via: "ralph:cmd:satisfy",
      }),
    ])
  );
});
