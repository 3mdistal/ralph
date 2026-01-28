import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests, loadConfig } from "../config";
import { getRalphConfigJsonPath } from "../paths";
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

test("accepts opencode.defaultProfile=auto when profiles enabled", async () => {
  await writeJson(getRalphConfigJsonPath(), {
    opencode: {
      enabled: true,
      defaultProfile: "auto",
      profiles: {
        apple: { xdgDataHome: "/tmp", xdgConfigHome: "/tmp", xdgStateHome: "/tmp" },
      },
    },
  });

  const warn = mock(() => {});
  const priorWarn = console.warn;
  console.warn = warn as any;

  try {
    __resetConfigForTests();
    const cfg = loadConfig().config;
    expect(cfg.opencode?.enabled).toBe(true);
    expect(cfg.opencode?.defaultProfile).toBe("auto");
  } finally {
    console.warn = priorWarn;
  }

  const warned = warn.mock.calls.some((call: unknown[]) =>
    String(call[0]).includes("Invalid config opencode.defaultProfile")
  );
  expect(warned).toBe(false);
});
