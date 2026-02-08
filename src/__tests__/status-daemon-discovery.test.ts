import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getStatusSnapshot } from "../commands/status";
import { __resetQueueBackendStateForTests } from "../queue-backend";
import { __resetBwrbRunnerForTests, __setBwrbRunnerForTests } from "../queue";
import { closeStateDbForTests } from "../state";
import { resolveDaemonRecordPath } from "../daemon-record";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir = "";
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

function createEmptyBwrbRunner() {
  return () => {
    const runner = {
      cwd: () => runner,
      quiet: async () => ({ stdout: Buffer.from("[]") }),
    };
    return runner;
  };
}

beforeEach(async () => {
  releaseLock = await acquireGlobalTestLock();
  priorHome = process.env.HOME;
  priorStateDb = process.env.RALPH_STATE_DB_PATH;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-daemon-"));
  process.env.HOME = homeDir;
  process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");

  const vaultDir = join(homeDir, "vault");
  await mkdir(join(vaultDir, ".bwrb"), { recursive: true });
  await writeFile(join(vaultDir, ".bwrb", "schema.json"), "{}", "utf8");

  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(
    join(homeDir, ".ralph", "config.json"),
    JSON.stringify({ queueBackend: "bwrb", bwrbVault: vaultDir }),
    "utf8"
  );

  __setBwrbRunnerForTests(createEmptyBwrbRunner() as any);
  __resetConfigForTests();
  __resetQueueBackendStateForTests();
  closeStateDbForTests();
});

afterEach(async () => {
  __resetBwrbRunnerForTests();
  __resetQueueBackendStateForTests();
  __resetConfigForTests();
  closeStateDbForTests();

  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
  else process.env.RALPH_STATE_DB_PATH = priorStateDb;

  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }

  releaseLock?.();
  releaseLock = null;
});

describe("status daemon discovery", () => {
  test("does not report running daemon for dead PID record", async () => {
    const recordPath = resolveDaemonRecordPath();
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify(
        {
          version: 1,
          daemonId: "dead",
          pid: 999_999_991,
          startedAt: new Date().toISOString(),
          ralphVersion: "test",
          command: ["bun", "src/index.ts"],
          cwd: homeDir,
          controlFilePath: "/tmp/control.json",
        },
        null,
        2
      ),
      "utf8"
    );

    const snapshot = await getStatusSnapshot();
    expect(snapshot.daemon).toBeNull();
    expect(snapshot.daemonDiscovery?.state).toBe("stale");
  });
});
