import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { getRalphConfigTomlPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

const ENV_KEYS = [
  "RALPH_DASHBOARD_ENABLED",
  "RALPH_DASHBOARD_HOST",
  "RALPH_DASHBOARD_PORT",
  "RALPH_DASHBOARD_TOKEN",
  "RALPH_DASHBOARD_REPLAY_DEFAULT",
  "RALPH_DASHBOARD_REPLAY_MAX",
];

describe("dashboard control plane config", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    for (const key of ENV_KEYS) delete process.env[key];
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("env overrides dashboard control plane settings", async () => {
    const configTomlPath = getRalphConfigTomlPath();
    await mkdir(join(homeDir, ".ralph"), { recursive: true });
    await writeFile(
      configTomlPath,
      [
        "[dashboard.controlPlane]",
        "enabled = false",
        "host = \"127.0.0.1\"",
        "port = 9999",
        "token = \"file-token\"",
        "replayLastDefault = 10",
        "replayLastMax = 20",
        "",
      ].join("\n"),
      "utf8"
    );

    process.env.RALPH_DASHBOARD_ENABLED = "true";
    process.env.RALPH_DASHBOARD_HOST = "localhost";
    process.env.RALPH_DASHBOARD_PORT = "8788";
    process.env.RALPH_DASHBOARD_TOKEN = "env-token";
    process.env.RALPH_DASHBOARD_REPLAY_DEFAULT = "3";
    process.env.RALPH_DASHBOARD_REPLAY_MAX = "5";

    const cfgMod = await import("../config?dashboard-control-plane");
    cfgMod.__resetConfigForTests();
    const resolved = cfgMod.getDashboardControlPlaneConfig();

    expect(resolved.enabled).toBe(true);
    expect(resolved.host).toBe("localhost");
    expect(resolved.port).toBe(8788);
    expect(resolved.token).toBe("env-token");
    expect(resolved.replayLastDefault).toBe(3);
    expect(resolved.replayLastMax).toBe(5);
  });
});
