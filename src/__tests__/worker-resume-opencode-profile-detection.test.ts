import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { loadConfig } from "../config";
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

test("resume detects the configured profile that contains the OpenCode session", async () => {
  const appleData = join(homeDir, ".opencode-profiles", "apple", "data");
  const appleCfg = join(homeDir, ".opencode-profiles", "apple", "config");
  const appleState = join(homeDir, ".opencode-profiles", "apple", "state");

  const googleData = join(homeDir, ".opencode-profiles", "google", "data");
  const googleCfg = join(homeDir, ".opencode-profiles", "google", "config");
  const googleState = join(homeDir, ".opencode-profiles", "google", "state");

  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: appleData, xdgConfigHome: appleCfg, xdgStateHome: appleState },
        google: { xdgDataHome: googleData, xdgConfigHome: googleCfg, xdgStateHome: googleState },
      },
    },
  });

  __resetConfigForTests();
  const cfg = loadConfig().config;
  expect(cfg.opencode?.enabled).toBe(true);

  const sessionId = "ses_test_profile_detect";
  const shard = "deadbeef";
  const sessionFile = join(appleData, "opencode", "storage", "session", shard, `${sessionId}.json`);
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "{}", "utf8");

  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  const task: any = {
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#555",
    name: "issue 555",
    status: "in-progress",
    _path: "orchestration/tasks/555.md",
    "opencode-profile": "",
    "session-id": sessionId,
  };

  const resolved = await (worker as any).resolveOpencodeXdgForTask(task, "resume", sessionId);
  expect(resolved.profileName).toBe("apple");
  expect(resolved.opencodeXdg?.dataHome).toBe(appleData);
  expect(resolved.opencodeXdg?.configHome).toBeUndefined();
});

test("resume does not auto-switch profiles when session cannot be found", async () => {
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

  const sessionId = "ses_missing_profile_detect";
  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  const task: any = {
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#555",
    name: "issue 555",
    status: "in-progress",
    _path: "orchestration/tasks/555.md",
    "opencode-profile": "",
    "session-id": sessionId,
  };

  const resolved = await (worker as any).resolveOpencodeXdgForTask(task, "resume", sessionId);
  expect(resolved.kind).toBe("restart-fresh");
  expect(resolved.profileName).toBe(null);
  expect(resolved.opencodeXdg).toBeUndefined();
  expect(resolved.reason).toContain(sessionId);
});

test("resume falls back to configured profiles when pinned affinity is stale", async () => {
  const appleData = join(homeDir, ".opencode-profiles", "apple", "data");
  const appleCfg = join(homeDir, ".opencode-profiles", "apple", "config");
  const appleState = join(homeDir, ".opencode-profiles", "apple", "state");

  const googleData = join(homeDir, ".opencode-profiles", "google", "data");
  const googleCfg = join(homeDir, ".opencode-profiles", "google", "config");
  const googleState = join(homeDir, ".opencode-profiles", "google", "state");

  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: appleData, xdgConfigHome: appleCfg, xdgStateHome: appleState },
        google: { xdgDataHome: googleData, xdgConfigHome: googleCfg, xdgStateHome: googleState },
      },
    },
  });

  __resetConfigForTests();

  const sessionId = "ses_fallback_from_stale_affinity";
  const shard = "a11ce11a";
  const sessionFile = join(googleData, "opencode", "storage", "session", shard, `${sessionId}.json`);
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "{}", "utf8");

  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  const task: any = {
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#557",
    name: "issue 557",
    status: "in-progress",
    _path: "orchestration/tasks/557.md",
    "opencode-profile": "stale-profile",
    "session-id": sessionId,
  };

  const resolved = await (worker as any).resolveOpencodeXdgForTask(task, "resume", sessionId);
  expect(resolved.kind).toBe("ok");
  expect(resolved.profileName).toBe("google");
  expect(resolved.opencodeXdg?.dataHome).toBe(googleData);
});

test("resume detects session stored under session_diff", async () => {
  const appleData = join(homeDir, ".opencode-profiles", "apple", "data");
  const appleCfg = join(homeDir, ".opencode-profiles", "apple", "config");
  const appleState = join(homeDir, ".opencode-profiles", "apple", "state");

  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: appleData, xdgConfigHome: appleCfg, xdgStateHome: appleState },
      },
    },
  });

  __resetConfigForTests();

  const sessionId = "ses_test_profile_diff";
  const shard = "feedbead";
  const sessionFile = join(appleData, "opencode", "storage", "session_diff", shard, `${sessionId}.json`);
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "{}", "utf8");

  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  const task: any = {
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#556",
    name: "issue 556",
    status: "in-progress",
    _path: "orchestration/tasks/556.md",
    "opencode-profile": "",
    "session-id": sessionId,
  };

  const resolved = await (worker as any).resolveOpencodeXdgForTask(task, "resume", sessionId);
  expect(resolved.profileName).toBe("apple");
  expect(resolved.opencodeXdg?.dataHome).toBe(appleData);
});

test("resume falls back when pinned profile session moved to another configured profile", async () => {
  const appleData = join(homeDir, ".opencode-profiles", "apple", "data");
  const appleCfg = join(homeDir, ".opencode-profiles", "apple", "config");
  const appleState = join(homeDir, ".opencode-profiles", "apple", "state");

  const googleData = join(homeDir, ".opencode-profiles", "google", "data");
  const googleCfg = join(homeDir, ".opencode-profiles", "google", "config");
  const googleState = join(homeDir, ".opencode-profiles", "google", "state");

  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: appleData, xdgConfigHome: appleCfg, xdgStateHome: appleState },
        google: { xdgDataHome: googleData, xdgConfigHome: googleCfg, xdgStateHome: googleState },
      },
    },
  });

  __resetConfigForTests();

  const sessionId = "ses_moved_profile_detect";
  const shard = "fadedcab";
  const sessionFile = join(googleData, "opencode", "storage", "session", shard, `${sessionId}.json`);
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "{}", "utf8");

  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  const task: any = {
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#557",
    name: "issue 557",
    status: "in-progress",
    _path: "orchestration/tasks/557.md",
    "opencode-profile": "apple",
    "session-id": sessionId,
  };

  const resolved = await (worker as any).resolveOpencodeXdgForTask(task, "resume", sessionId);
  expect(resolved.profileName).toBe("google");
  expect(resolved.opencodeXdg?.dataHome).toBe(googleData);
  expect(resolved.error).toBeUndefined();
});

test("resume emits terminal profile-unresolvable reason when session is missing everywhere", async () => {
  const appleData = join(homeDir, ".opencode-profiles", "apple", "data");
  const appleCfg = join(homeDir, ".opencode-profiles", "apple", "config");
  const appleState = join(homeDir, ".opencode-profiles", "apple", "state");

  const googleData = join(homeDir, ".opencode-profiles", "google", "data");
  const googleCfg = join(homeDir, ".opencode-profiles", "google", "config");
  const googleState = join(homeDir, ".opencode-profiles", "google", "state");

  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: appleData, xdgConfigHome: appleCfg, xdgStateHome: appleState },
        google: { xdgDataHome: googleData, xdgConfigHome: googleCfg, xdgStateHome: googleState },
      },
    },
  });

  __resetConfigForTests();

  const sessionId = "ses_missing_everywhere";
  const worker = new RepoWorker("3mdistal/ralph", "/tmp");
  const task: any = {
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#558",
    name: "issue 558",
    status: "in-progress",
    _path: "orchestration/tasks/558.md",
    "opencode-profile": "apple",
    "session-id": sessionId,
  };

  const resolved = await (worker as any).resolveOpencodeXdgForTask(task, "resume", sessionId);
  expect(resolved.profileName).toBe(null);
  expect(resolved.opencodeXdg).toBeUndefined();
  expect(resolved.error).toContain("blocked:profile-unresolvable");
  expect(resolved.error).toContain("terminal");
  expect(resolved.error).toContain("pinnedProfile=apple");
});

test("writes config to the expected path", async () => {
  // Sanity check that our HOME override affects config resolution.
  const path = getRalphConfigJsonPath();
  expect(path.startsWith(homeDir)).toBe(true);
});
