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
let priorTmpdir: string | undefined;
let priorTmp: string | undefined;
let priorTemp: string | undefined;
let releaseLock: (() => void) | null = null;

describe("OpenCode config env", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorOverride = process.env.RALPH_OPENCODE_CONFIG_DIR;
    priorOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    priorTmpdir = process.env.TMPDIR;
    priorTmp = process.env.TMP;
    priorTemp = process.env.TEMP;
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
    if (priorTmpdir) process.env.TMPDIR = priorTmpdir;
    else delete process.env.TMPDIR;
    if (priorTmp) process.env.TMP = priorTmp;
    else delete process.env.TMP;
    if (priorTemp) process.env.TEMP = priorTemp;
    else delete process.env.TEMP;
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

  test("keeps managed OPENCODE_CONFIG_DIR shared across profile switches", () => {
    const appleDataHome = join(homeDir, ".opencode-profiles", "apple", "data");
    const googleDataHome = join(homeDir, ".opencode-profiles", "google", "data");

    const appleEnv = __buildOpencodeEnvForTests({
      repo: "demo",
      cacheKey: "shared-managed-config",
      opencodeXdg: { dataHome: appleDataHome },
    });
    const googleEnv = __buildOpencodeEnvForTests({
      repo: "demo",
      cacheKey: "shared-managed-config",
      opencodeXdg: { dataHome: googleDataHome },
    });

    expect(appleEnv.OPENCODE_CONFIG_DIR).toBe(getRalphOpencodeConfigDir());
    expect(googleEnv.OPENCODE_CONFIG_DIR).toBe(getRalphOpencodeConfigDir());
    expect(appleEnv.OPENCODE_CONFIG_DIR).toBe(googleEnv.OPENCODE_CONFIG_DIR);
    expect(appleEnv.XDG_DATA_HOME).toBe(appleDataHome);
    expect(googleEnv.XDG_DATA_HOME).toBe(googleDataHome);
  });

  test("sets temp environment variables when tempDir is provided", () => {
    const tempDir = join(homeDir, "worktree", ".ralph-tmp");
    const env = __buildOpencodeEnvForTests({ repo: "demo", cacheKey: "tmp", tempDir });

    expect(env.TMPDIR).toBe(tempDir);
    expect(env.TMP).toBe(tempDir);
    expect(env.TEMP).toBe(tempDir);
  });

  test("tempDir override wins over inherited TMP variables", () => {
    process.env.TMPDIR = "/tmp/inherited";
    process.env.TMP = "/tmp/inherited";
    process.env.TEMP = "/tmp/inherited";

    const tempDir = join(homeDir, "override", ".ralph-tmp");
    const env = __buildOpencodeEnvForTests({ repo: "demo", cacheKey: "tmp-override", tempDir });

    expect(env.TMPDIR).toBe(tempDir);
    expect(env.TMP).toBe(tempDir);
    expect(env.TEMP).toBe(tempDir);
  });
});
