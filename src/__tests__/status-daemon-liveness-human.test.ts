import { afterEach, beforeEach, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { __resetConfigForTests } from "../config";
import { __resetQueueBackendStateForTests } from "../queue-backend";
import { runStatusCommand } from "../commands/status";
import { closeStateDbForTests, initStateDb } from "../state";

let homeDir = "";
let priorHome: string | undefined;
let priorStateDb: string | undefined;

async function setupEnv(): Promise<void> {
  priorHome = process.env.HOME;
  priorStateDb = process.env.RALPH_STATE_DB_PATH;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-liveness-human-"));
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

beforeEach(async () => {
  await setupEnv();
});

afterEach(async () => {
  await teardownEnv();
});

test("status non-json prints daemon liveness mismatch with hint", async () => {
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
      args: [],
      drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
    });
  } catch (err: any) {
    if (!String(err?.message ?? err).includes("exit")) throw err;
  } finally {
    console.log = priorLog;
    process.exit = priorExit;
  }

  const livenessLine = logs.find((line) => line.startsWith("Daemon liveness:")) ?? "";
  expect(livenessLine).toContain("mismatch=true");
  expect(livenessLine).toContain("hint=Daemon liveness mismatch");
});
