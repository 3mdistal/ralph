import { describe, test, expect, afterEach } from "bun:test";
import { beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { DrainMonitor, isDraining, resolveControlFilePath } from "../drain";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for DrainMonitor update");
}

describe("Drain mode", () => {
  const tmpDirs: string[] = [];
  let priorXdgStateHome: string | undefined;

  beforeEach(() => {
    priorXdgStateHome = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (priorXdgStateHome !== undefined) process.env.XDG_STATE_HOME = priorXdgStateHome;
    else delete process.env.XDG_STATE_HOME;

    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  test("isDraining reflects mode in control.json", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const controlPath = resolveControlFilePath(homeDir);
    expect(isDraining(homeDir)).toBe(false);

    mkdirSync(dirname(controlPath), { recursive: true });
    writeFileSync(controlPath, JSON.stringify({ mode: "draining" }));
    expect(isDraining(homeDir)).toBe(true);

    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    expect(isDraining(homeDir)).toBe(false);
  });

  test("resolveControlFilePath falls back to /tmp when home missing", () => {
    const controlPath = resolveControlFilePath("", "");
    expect(controlPath).toBe(join("/tmp", "ralph", "control.json"));
  });

  test("DrainMonitor emits transition logs", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const logs: string[] = [];
    const modeChanges: string[] = [];

    const controlPath = resolveControlFilePath(homeDir);
    mkdirSync(dirname(controlPath), { recursive: true });

    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      log: (message) => logs.push(message),
      onModeChange: (mode) => modeChanges.push(mode),
    });

    monitor.start();

    writeFileSync(controlPath, JSON.stringify({ mode: "draining" }));
    await waitFor(() => monitor.getMode() === "draining", 5000);

    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    await waitFor(() => monitor.getMode() === "running", 5000);

    monitor.stop();

    expect(logs.some((l) => l.includes("Control mode: draining")) || modeChanges.includes("draining")).toBe(true);
    expect(logs.some((l) => l.includes("Control mode: running")) || modeChanges.includes("running")).toBe(true);
    expect(modeChanges).toContain("draining");
    expect(modeChanges).toContain("running");
  });

  test("DrainMonitor keeps last-known-good when control.json is invalid", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const warnings: string[] = [];
    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      warn: (message) => warnings.push(message),
    });

    const controlPath = resolveControlFilePath(homeDir);
    mkdirSync(dirname(controlPath), { recursive: true });

    writeFileSync(controlPath, JSON.stringify({ mode: "draining" }));
    monitor.start();
    await sleep(50);

    writeFileSync(controlPath, "{\"mode\":\"draining\"");
    await sleep(50);

    expect(monitor.getMode()).toBe("draining");
    expect(warnings.some((w) => w.toLowerCase().includes("invalid"))).toBe(true);

    const warningCount = warnings.length;
    await sleep(50);
    expect(warnings.length).toBe(warningCount);

    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    await sleep(50);

    monitor.stop();
    expect(monitor.getMode()).toBe("running");
  });

  test("DrainMonitor creates control directory on startup", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const controlPath = resolveControlFilePath(homeDir);
    const controlDir = dirname(controlPath);

    expect(existsSync(controlDir)).toBe(false);

    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
    });

    monitor.start();
    await sleep(25);

    expect(existsSync(controlDir)).toBe(true);
    expect(() => statSync(controlDir)).not.toThrow();

    monitor.stop();
  });
});
