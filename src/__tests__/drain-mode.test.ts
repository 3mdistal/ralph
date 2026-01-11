import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { DrainMonitor, isDraining, resolveControlFilePath } from "../drain";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Drain mode", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
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

  test("DrainMonitor emits transition logs", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const logs: string[] = [];
    const modeChanges: string[] = [];

    const monitor = new DrainMonitor({
      homeDir,
      pollIntervalMs: 10,
      log: (message) => logs.push(message),
      onModeChange: (mode) => modeChanges.push(mode),
    });

    monitor.start();

    const controlPath = resolveControlFilePath(homeDir);
    mkdirSync(dirname(controlPath), { recursive: true });

    writeFileSync(controlPath, JSON.stringify({ mode: "draining" }));
    await sleep(100);

    writeFileSync(controlPath, JSON.stringify({ mode: "running" }));
    await sleep(100);

    monitor.stop();

    expect(logs.some((l) => l.includes("Control mode: draining"))).toBe(true);
    expect(logs.some((l) => l.includes("Control mode: running"))).toBe(true);
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
});
