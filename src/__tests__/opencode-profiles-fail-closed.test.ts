import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { resolveOpencodeXdgForTask } from "../worker/opencode-profiles";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

function mockThrottleDecision(_now: number, opts?: { opencodeProfile?: string | null }) {
  const profile = opts?.opencodeProfile ?? null;
  return Promise.resolve({
    state: "ok",
    resumeAtTs: null,
    snapshot: { opencodeProfile: profile, state: "ok", resumeAt: null, windows: [] },
  } as any);
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
  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }
  __resetConfigForTests();
  releaseLock?.();
  releaseLock = null;
});

test("start fails closed when requested/default profile is not configured", async () => {
  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "missing-profile",
      profiles: {
        apple: {
          xdgDataHome: join(homeDir, ".opencode-profiles", "apple", "data"),
          xdgConfigHome: join(homeDir, ".opencode-profiles", "apple", "config"),
          xdgStateHome: join(homeDir, ".opencode-profiles", "apple", "state"),
        },
      },
    },
  });
  __resetConfigForTests();

  const resolved = await resolveOpencodeXdgForTask({
    task: { issue: "3mdistal/ralph#610", "opencode-profile": "" } as any,
    phase: "start",
    repo: "3mdistal/ralph",
    getThrottleDecision: mockThrottleDecision as any,
  });

  expect(resolved.profileName).toBe(null);
  expect(resolved.opencodeXdg).toBeUndefined();
  expect(resolved.error).toContain("blocked:profile-unresolvable");
  expect(resolved.error).toContain("requestedProfile=missing-profile");
  expect(resolved.error).toContain("configuredProfiles=apple");
});

test("resume fails closed when session id is missing", async () => {
  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "apple",
      profiles: {
        apple: {
          xdgDataHome: join(homeDir, ".opencode-profiles", "apple", "data"),
          xdgConfigHome: join(homeDir, ".opencode-profiles", "apple", "config"),
          xdgStateHome: join(homeDir, ".opencode-profiles", "apple", "state"),
        },
      },
    },
  });
  __resetConfigForTests();

  const resolved = await resolveOpencodeXdgForTask({
    task: { issue: "3mdistal/ralph#610", "opencode-profile": "" } as any,
    phase: "resume",
    sessionId: "",
    repo: "3mdistal/ralph",
    getThrottleDecision: mockThrottleDecision as any,
  });

  expect(resolved.profileName).toBe(null);
  expect(resolved.opencodeXdg).toBeUndefined();
  expect(resolved.error).toContain("blocked:profile-unresolvable");
  expect(resolved.error).toContain("phase=resume");
});

test("profiles disabled preserves legacy non-fail-closed behavior", async () => {
  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: false,
      defaultProfile: "apple",
    },
  });
  __resetConfigForTests();

  const resolved = await resolveOpencodeXdgForTask({
    task: { issue: "3mdistal/ralph#610", "opencode-profile": "" } as any,
    phase: "start",
    repo: "3mdistal/ralph",
    getThrottleDecision: mockThrottleDecision as any,
  });

  expect(resolved.error).toBeUndefined();
  expect(resolved.profileName).toBe(null);
});
