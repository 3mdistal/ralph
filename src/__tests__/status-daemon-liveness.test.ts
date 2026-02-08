import { afterEach, beforeEach, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { __resetConfigForTests } from "../config";
import { writeDaemonRecord } from "../daemon-record";
import { __resetQueueBackendStateForTests } from "../queue-backend";
import { closeStateDbForTests, initStateDb } from "../state";
import { runStatusCommand } from "../commands/status";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir = "";
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let priorXdgStateHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function setupEnv(): Promise<void> {
  priorHome = process.env.HOME;
  priorStateDb = process.env.RALPH_STATE_DB_PATH;
  priorXdgStateHome = process.env.XDG_STATE_HOME;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-liveness-"));
  process.env.HOME = homeDir;
  process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
  process.env.XDG_STATE_HOME = join(homeDir, "xdg-state");


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

  if (priorXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = priorXdgStateHome;
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
  releaseLock = await acquireGlobalTestLock();
  await setupEnv();
});

afterEach(async () => {
  await teardownEnv();
  releaseLock?.();
  releaseLock = null;
});

test("status --json fails closed when no live daemon can be confirmed", async () => {
  const parsed = await runStatusJson();
  expect(parsed.desiredMode).toBe("running");
  expect(parsed.mode).not.toBe("running");
  expect(["missing", "dead", "unknown"]).toContain(parsed.daemonLiveness?.state);
  expect(parsed.daemonLiveness?.mismatch).toBe(true);
  expect(String(parsed.daemonLiveness?.hint ?? "")).toContain("Daemon liveness mismatch");
  expect(String(parsed.daemonLiveness?.hint ?? "")).not.toContain(homeDir);
});

test("status --json fails closed when daemon pid is dead", async () => {
  writeDaemonRecord({
    version: 1,
    daemonId: "d-test",
    pid: 999_999,
    startedAt: new Date("2026-02-08T00:00:00.000Z").toISOString(),
    ralphVersion: "test",
    command: ["bun", "run", "src/index.ts"],
    cwd: homeDir,
    controlFilePath: join(homeDir, "control.json"),
  });

  const parsed = await runStatusJson();
  expect(parsed.desiredMode).toBe("running");
  expect(parsed.mode).not.toBe("running");
  expect(parsed.daemonLiveness).toMatchObject({
    state: "dead",
    mismatch: true,
    pid: 999_999,
  });
  expect(String(parsed.daemonLiveness?.hint ?? "")).toContain("Daemon liveness mismatch");
  expect(String(parsed.daemonLiveness?.hint ?? "")).not.toContain(homeDir);
});
