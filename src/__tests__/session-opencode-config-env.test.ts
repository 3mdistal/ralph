import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { __buildOpencodeEnvForTests } from "../session";
import { getRalphOpencodeConfigDir } from "../paths";
import { __resetConfigForTests } from "../config";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let priorOverride: string | undefined;
let priorOpencodeConfigDir: string | undefined;
let releaseLock: (() => void) | null = null;

describe("OpenCode config env", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorOverride = process.env.RALPH_OPENCODE_CONFIG_DIR;
    priorOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    delete process.env.RALPH_OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    __resetConfigForTests();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    if (priorOverride) process.env.RALPH_OPENCODE_CONFIG_DIR = priorOverride;
    else delete process.env.RALPH_OPENCODE_CONFIG_DIR;
    if (priorOpencodeConfigDir) process.env.OPENCODE_CONFIG_DIR = priorOpencodeConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("sets OPENCODE_CONFIG_DIR to the managed default", () => {
    const env = __buildOpencodeEnvForTests({ repo: "demo", cacheKey: "123" });
    expect(env.OPENCODE_CONFIG_DIR).toBe(getRalphOpencodeConfigDir());
  });

  test("sets XDG_CONFIG_HOME to an isolated dir by default", () => {
    const env = __buildOpencodeEnvForTests({ repo: "demo", cacheKey: "abc" });
    expect(typeof env.XDG_CONFIG_HOME).toBe("string");
    expect(env.XDG_CONFIG_HOME).toContain("ralph-opencode");
  });

  test("keeps XDG_CONFIG_HOME isolated even when profile configHome is set", () => {
    const profileConfigHome = join(homeDir, ".opencode-profiles", "apple", "config");
    const env = __buildOpencodeEnvForTests({
      repo: "demo",
      cacheKey: "abc-profile",
      opencodeXdg: { configHome: profileConfigHome },
    });
    expect(env.XDG_CONFIG_HOME).toContain("ralph-opencode");
    expect(env.XDG_CONFIG_HOME).not.toBe(profileConfigHome);
  });

  test("respects RALPH_OPENCODE_CONFIG_DIR override", () => {
    const override = join(homeDir, "custom-opencode");
    process.env.RALPH_OPENCODE_CONFIG_DIR = override;
    const env = __buildOpencodeEnvForTests({ repo: "demo", cacheKey: "456" });
    expect(env.OPENCODE_CONFIG_DIR).toBe(override);
  });

  test("ignores OPENCODE_CONFIG_DIR env var", () => {
    process.env.OPENCODE_CONFIG_DIR = join(homeDir, "ignored-opencode");
    const env = __buildOpencodeEnvForTests({ repo: "demo", cacheKey: "789" });
    expect(env.OPENCODE_CONFIG_DIR).toBe(getRalphOpencodeConfigDir());
  });
});
