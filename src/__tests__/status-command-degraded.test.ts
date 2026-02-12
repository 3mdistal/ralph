import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

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

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-degraded-"));
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

type CapturedStatusRun = {
  logs: string[];
  warns: string[];
  thrown: unknown;
};

async function runStatus(args: string[]): Promise<CapturedStatusRun> {
  const logs: string[] = [];
  const warns: string[] = [];
  const priorLog = console.log;
  const priorWarn = console.warn;
  const priorExit = process.exit;
  let thrown: unknown = null;

  console.log = (...line: any[]) => {
    logs.push(line.join(" "));
  };
  console.warn = (...line: any[]) => {
    warns.push(line.join(" "));
  };
  (process.exit as any) = (code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  };

  try {
    await runStatusCommand({
      args,
      drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.log = priorLog;
    console.warn = priorWarn;
    process.exit = priorExit;
  }

  return { logs, warns, thrown };
}

beforeEach(async () => {
  await setupEnv();
});

afterEach(async () => {
  await teardownEnv();
});

test("status --json returns degraded snapshot for forward-incompatible durable state", async () => {
  const dbPath = join(homeDir, "state.sqlite");
  closeStateDbForTests();
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("DELETE FROM meta WHERE key = 'schema_version'");
    db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '999')");
  } finally {
    db.close();
  }

  const { logs, thrown } = await runStatus(["--json"]);
  expect(String((thrown as any)?.message ?? "")).toContain("exit:0");
  const raw = logs.find((line) => line.trim().startsWith("{")) ?? "";
  const parsed = JSON.parse(raw);

  expect(parsed.durableState?.ok).toBeFalse();
  expect(parsed.durableState?.code).toBe("forward_incompatible");
  expect(parsed.durableState?.schemaVersion).toBe(999);
  expect(parsed.inProgress).toEqual([]);
  expect(parsed.queued).toEqual([]);
  expect(parsed.usage).toBeUndefined();
});

test("status text mode shows explicit unavailable counts in degraded mode", async () => {
  const dbPath = join(homeDir, "state.sqlite");
  closeStateDbForTests();
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("DELETE FROM meta WHERE key = 'schema_version'");
    db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '999')");
  } finally {
    db.close();
  }

  const { logs, warns, thrown } = await runStatus([]);
  expect(String((thrown as any)?.message ?? "")).toContain("exit:0");
  expect(warns.some((line) => line.includes("Durable state degraded (forward_incompatible)"))).toBe(true);
  expect(logs).toContain("In-progress tasks: unavailable");
  expect(logs).toContain("Queued tasks: unavailable");
  expect(logs).toContain("Queue parity: unavailable (durable state degraded)");
});

test("status does not mask non-durable failures as degraded mode", async () => {
  const prior = process.env.RALPH_STATUS_FORCE_INTERNAL_ERROR;
  process.env.RALPH_STATUS_FORCE_INTERNAL_ERROR = "1";

  try {
    const { thrown, warns } = await runStatus(["--json"]);
    expect(String((thrown as any)?.message ?? thrown)).toContain("Forced status internal error");
    expect(warns.some((line) => line.includes("Durable state degraded"))).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.RALPH_STATUS_FORCE_INTERNAL_ERROR;
    else process.env.RALPH_STATUS_FORCE_INTERNAL_ERROR = prior;
  }
});
