import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { writeDaemonRecord, readDaemonRecord } from "../daemon-record";
import { resolveControlFilePath } from "../drain";
import { getRalphConfigJsonPath } from "../paths";
import { resolveOpencodeXdgForTask } from "../worker/opencode-profiles";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorXdgStateHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

async function writeConfig(defaultProfile: string): Promise<void> {
  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile,
      profiles: {
        apple: {
          xdgDataHome: join(homeDir, ".opencode-profiles", "apple", "data"),
          xdgConfigHome: join(homeDir, ".opencode-profiles", "apple", "config"),
          xdgStateHome: join(homeDir, ".opencode-profiles", "apple", "state"),
        },
        google: {
          xdgDataHome: join(homeDir, ".opencode-profiles", "google", "data"),
          xdgConfigHome: join(homeDir, ".opencode-profiles", "google", "config"),
          xdgStateHome: join(homeDir, ".opencode-profiles", "google", "state"),
        },
      },
    },
  });
  __resetConfigForTests();
}

function mockThrottleDecision(_now: number, opts?: { opencodeProfile?: string | null }) {
  const profile = opts?.opencodeProfile ?? null;
  return Promise.resolve({
    state: "ok",
    resumeAtTs: null,
    snapshot: { opencodeProfile: profile, state: "ok", resumeAt: null, windows: [] },
  } as any);
}

describe("opencode profile/runtime decoupling", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    priorXdgStateHome = process.env.XDG_STATE_HOME;

    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    process.env.XDG_STATE_HOME = join(homeDir, ".xdg-state");
    __resetConfigForTests();
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;

    if (priorXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorXdgStateHome;

    __resetConfigForTests();
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("profile flips change worker env but keep control-plane identity stable", async () => {
    await writeConfig("apple");

    const controlPathBefore = resolveControlFilePath();
    writeDaemonRecord({
      version: 1,
      daemonId: "d_stable",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ralphVersion: "test",
      command: ["bun", "run", "start"],
      cwd: homeDir,
      controlFilePath: controlPathBefore,
    });

    const firstDefault = await resolveOpencodeXdgForTask({
      task: { issue: "3mdistal/ralph#608", "opencode-profile": "" } as any,
      phase: "start",
      repo: "3mdistal/ralph",
      getThrottleDecision: mockThrottleDecision as any,
    });

    await writeConfig("google");

    const secondDefault = await resolveOpencodeXdgForTask({
      task: { issue: "3mdistal/ralph#608", "opencode-profile": "" } as any,
      phase: "start",
      repo: "3mdistal/ralph",
      getThrottleDecision: mockThrottleDecision as any,
    });

    const controlPathAfter = resolveControlFilePath();
    const daemon = readDaemonRecord();

    expect(firstDefault.profileName).toBe("apple");
    expect(secondDefault.profileName).toBe("google");
    expect(controlPathAfter).toBe(controlPathBefore);
    expect(daemon?.daemonId).toBe("d_stable");
    expect(daemon?.controlFilePath).toBe(controlPathBefore);
  });
});
