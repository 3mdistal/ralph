import { describe, test, expect, afterEach } from "bun:test";
import { beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
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
    expect(isDraining(homeDir, { autoCreate: false, suppressMissingWarnings: true })).toBe(false);

    mkdirSync(dirname(controlPath), { recursive: true });
    writeFileSync(controlPath, JSON.stringify({ mode: "draining" }));
    expect(isDraining(homeDir, { autoCreate: false, suppressMissingWarnings: true })).toBe(true);

    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    expect(isDraining(homeDir, { autoCreate: false, suppressMissingWarnings: true })).toBe(false);
  });

  test("resolveControlFilePath falls back to uid-scoped /tmp when home missing", () => {
    const controlPath = resolveControlFilePath("", "");
    const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
    expect(controlPath).toBe(join("/tmp", "ralph", String(uid), "control.json"));
  });

  test(
    "DrainMonitor emits transition logs",
    async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const logs: string[] = [];

    const controlPath = resolveControlFilePath(homeDir);
    mkdirSync(dirname(controlPath), { recursive: true });

    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      log: (message) => logs.push(message),
    });

    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    monitor.start();

    await sleep(1100);
    writeFileSync(controlPath, JSON.stringify({ mode: "draining" }));
    await sleep(25);
    utimesSync(controlPath, new Date(), new Date());
    await waitFor(() => logs.some((line) => line.includes("Control mode: draining")), 20000);

    await sleep(1100);
    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    await sleep(25);
    utimesSync(controlPath, new Date(), new Date());
    await waitFor(() => logs.some((line) => line.includes("Control mode: running")), 20000);

    monitor.stop();
  },
  20000
  );

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

  test("DrainMonitor creates control file on startup", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const controlPath = resolveControlFilePath(homeDir);
    const controlDir = dirname(controlPath);

    expect(existsSync(controlDir)).toBe(false);
    expect(existsSync(controlPath)).toBe(false);

    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
    });

    monitor.start();
    await sleep(25);

    expect(existsSync(controlDir)).toBe(true);
    expect(() => statSync(controlDir)).not.toThrow();
    expect(existsSync(controlPath)).toBe(true);

    monitor.stop();
  });

  test("DrainMonitor respects autoCreate=false", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const controlPath = resolveControlFilePath(homeDir);
    const controlDir = dirname(controlPath);

    expect(existsSync(controlDir)).toBe(false);

    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      defaults: { autoCreate: false },
    });

    monitor.start();
    await sleep(25);

    expect(existsSync(controlDir)).toBe(false);

    monitor.stop();
  });

  test("DrainMonitor respects suppressMissingWarnings", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const warnings: string[] = [];
    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      defaults: { suppressMissingWarnings: true, autoCreate: false },
      warn: (message) => warnings.push(message),
    });

    monitor.start();
    await sleep(50);

    expect(warnings.length).toBe(0);

    monitor.stop();
  });

  test("DrainMonitor warns when suppressMissingWarnings=false", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const warnings: string[] = [];
    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      defaults: { suppressMissingWarnings: false, autoCreate: false },
      warn: (message) => warnings.push(message),
    });

    monitor.start();
    await sleep(50);

    expect(warnings.length).toBeGreaterThan(0);

    monitor.stop();
  });

  test("falls back to uid-scoped tmp dir when homes missing", () => {
    const homeDir = "";
    const path = resolveControlFilePath(homeDir, "");
    const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
    expect(path).toBe(`/tmp/ralph/${uid}/control.json`);
  });

  test("refuses symlinked control dir", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const realDir = mkdtempSync(join(tmpdir(), "ralph-drain-real-"));
    tmpDirs.push(realDir);

    const controlPath = resolveControlFilePath(homeDir);
    const controlDir = dirname(controlPath);

    rmSync(controlDir, { recursive: true, force: true });
    mkdirSync(dirname(controlDir), { recursive: true });
    symlinkSync(realDir, controlDir, "dir");

    expect(isDraining(homeDir, { autoCreate: false, suppressMissingWarnings: true })).toBe(false);
  });
});
