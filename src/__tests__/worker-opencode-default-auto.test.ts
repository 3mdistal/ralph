import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { RepoWorker } from "../worker";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

beforeEach(async () => {
  releaseLock = await acquireGlobalTestLock();
  priorHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
  process.env.HOME = homeDir;
  __resetConfigForTests();
});

afterEach(async () => {
  process.env.HOME = priorHome;
  await rm(homeDir, { recursive: true, force: true });
  __resetConfigForTests();
  releaseLock?.();
  releaseLock = null;
});

test("never calls throttle with opencodeProfile=auto", async () => {
  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: "/tmp", xdgConfigHome: "/tmp", xdgStateHome: "/tmp" },
      },
    },
  });

  __resetConfigForTests();

  const throttleCalls: Array<string | null | undefined> = [];
  const throttleAdapter = {
    getThrottleDecision: async (_now: number, opts?: { opencodeProfile?: string | null }) => {
      throttleCalls.push(opts?.opencodeProfile ?? null);
      return {
        state: "ok",
        resumeAtTs: null,
        snapshot: {
          opencodeProfile: opts?.opencodeProfile ?? null,
          state: "ok",
          resumeAt: null,
          windows: [],
        },
      } as any;
    },
  };

  const worker = new RepoWorker("3mdistal/ralph", "/tmp", { throttle: throttleAdapter as any });
  const task = {
    name: "Task",
    issue: "3mdistal/ralph#424",
    repo: "3mdistal/ralph",
    status: "in-progress",
  } as any;

  await (worker as any).pauseIfHardThrottled(task, "checkpoint");

  expect(throttleCalls.includes("auto")).toBe(false);
});
