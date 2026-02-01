import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { getRalphConfigTomlPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

type EnvSnapshot = {
  HOME?: string;
};

let homeDir: string;
let priorEnv: EnvSnapshot;
let releaseLock: (() => void) | null = null;

async function writeToml(lines: string[]): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(getRalphConfigTomlPath(), lines.join("\n"), "utf8");
}

describe("throttle config validation", () => {
  beforeEach(async () => {
    priorEnv = { HOME: process.env.HOME };
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = priorEnv.HOME;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("loads throttle config including per-profile overrides", async () => {
    await writeToml([
      "repos = []",
      "",
      "[throttle]",
      "enabled = true",
      'providerID = "openai"',
      'openaiSource = "remoteUsage"',
      "softPct = 0.5",
      "hardPct = 0.9",
      "minCheckIntervalMs = 0",
      "",
      "[throttle.windows.rolling5h]",
      "budgetTokens = 200",
      "",
      "[throttle.windows.weekly]",
      "budgetTokens = 2000",
      "",
      "[throttle.reset.weekly]",
      "dayOfWeek = 1",
      "hour = 19",
      "minute = 5",
      'timeZone = "America/Indiana/Indianapolis"',
      "",
      "[throttle.perProfile.p1]",
      'providerID = "openai"',
      "softPct = 0.2",
      "hardPct = 0.3",
      "minCheckIntervalMs = 0",
      "",
      "[throttle.perProfile.p1.windows.rolling5h]",
      "budgetTokens = 123",
      "",
      "[throttle.perProfile.p1.windows.weekly]",
      "budgetTokens = 1234",
      "",
      "[throttle.perProfile.p1.reset.weekly]",
      "dayOfWeek = 4",
      "hour = 19",
      "minute = 9",
      'timeZone = "America/Indiana/Indianapolis"',
      "",
    ]);

    const query: string = "throttle-config-validation";
    const cfgMod = await import(`../config?${query}`);
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;

    expect(cfg.throttle?.enabled).toBe(true);
    expect(cfg.throttle?.providerID).toBe("openai");
    expect(cfg.throttle?.openaiSource).toBe("localLogs");
    expect(cfg.throttle?.softPct).toBe(0.5);
    expect(cfg.throttle?.hardPct).toBe(0.9);
    expect(cfg.throttle?.minCheckIntervalMs).toBe(0);

    expect(cfg.throttle?.windows?.rolling5h?.budgetTokens).toBe(200);
    expect(cfg.throttle?.windows?.weekly?.budgetTokens).toBe(2000);

    expect(cfg.throttle?.reset?.weekly?.dayOfWeek).toBe(1);
    expect(cfg.throttle?.reset?.weekly?.hour).toBe(19);
    expect(cfg.throttle?.reset?.weekly?.minute).toBe(5);
    expect(cfg.throttle?.reset?.weekly?.timeZone).toBe("America/Indiana/Indianapolis");

    expect(cfg.throttle?.perProfile?.p1?.softPct).toBe(0.2);
    expect(cfg.throttle?.perProfile?.p1?.hardPct).toBe(0.3);
    expect(cfg.throttle?.perProfile?.p1?.windows?.rolling5h?.budgetTokens).toBe(123);
    expect(cfg.throttle?.perProfile?.p1?.windows?.weekly?.budgetTokens).toBe(1234);

    expect(cfg.throttle?.perProfile?.p1?.reset?.weekly?.dayOfWeek).toBe(4);
    expect(cfg.throttle?.perProfile?.p1?.reset?.weekly?.hour).toBe(19);
    expect(cfg.throttle?.perProfile?.p1?.reset?.weekly?.minute).toBe(9);
    expect(cfg.throttle?.perProfile?.p1?.reset?.weekly?.timeZone).toBe("America/Indiana/Indianapolis");
  });

  test("sanitizes invalid throttle config", async () => {
    await writeToml([
      "repos = []",
      "",
      "[throttle]",
      "enabled = true",
      "softPct = 2",
      "hardPct = -1",
      "minCheckIntervalMs = -10",
      "",
      "[throttle.windows.rolling5h]",
      "budgetTokens = 0",
      "",
      "[throttle.windows.weekly]",
      "budgetTokens = -5",
      "",
    ]);

    const query: string = "throttle-config-validation-invalid";
    const cfgMod = await import(`../config?${query}`);
    cfgMod.__resetConfigForTests();
    const cfg = cfgMod.loadConfig().config;

    expect(cfg.throttle?.providerID).toBe("openai");
    expect(cfg.throttle?.openaiSource).toBe("localLogs");
    expect(cfg.throttle?.softPct).toBe(0.65);
    expect(cfg.throttle?.hardPct).toBe(0.75);
    expect(cfg.throttle?.minCheckIntervalMs).toBe(15_000);
    expect(cfg.throttle?.windows?.rolling5h?.budgetTokens).toBe(16_987_015);
    expect(cfg.throttle?.windows?.weekly?.budgetTokens).toBe(55_769_305);
  });
});
