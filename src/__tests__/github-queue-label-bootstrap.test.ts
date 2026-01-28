import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import { getRalphConfigJsonPath } from "../paths";

let homeDir: string;
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

describe("GitHub queue label bootstrap", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("does not ensure workflow labels during initial poll when no label mutations occur", async () => {
    await writeJson(getRalphConfigJsonPath(), {
      queueBackend: "github",
      repos: [{ name: "3mdistal/bwrb", path: "/tmp/bwrb" }],
    });

    const cfgMod = await import("../config");
    cfgMod.__resetConfigForTests();

    const stateMod = await import("../state");
    stateMod.initStateDb();

    const ensureCalls: string[] = [];
    const queueMod = await import("../github-queue/io");
    const driver = queueMod.createGitHubQueueDriver({
      io: {
        ensureWorkflowLabels: async (repo: string) => {
          ensureCalls.push(repo);
          return { ok: true, created: [], updated: [] };
        },
        listIssueLabels: async () => [],
        addIssueLabel: async () => {},
        removeIssueLabel: async () => ({ removed: true }),
      },
    });

    await driver.initialPoll();
    expect(ensureCalls).toEqual([]);
  });
});
