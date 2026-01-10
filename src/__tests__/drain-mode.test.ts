import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { DrainMonitor, isDraining, resolveDrainFilePath } from "../drain";

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

  test("isDraining reflects presence of drain file", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-drain-"));
    tmpDirs.push(homeDir);

    const drainPath = resolveDrainFilePath(homeDir);
    expect(isDraining(homeDir)).toBe(false);

    mkdirSync(dirname(drainPath), { recursive: true });
    writeFileSync(drainPath, "");
    expect(isDraining(homeDir)).toBe(true);

    rmSync(drainPath, { force: true });
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

    const drainPath = resolveDrainFilePath(homeDir);
    mkdirSync(dirname(drainPath), { recursive: true });
    writeFileSync(drainPath, "");
    await sleep(100);

    rmSync(drainPath, { force: true });
    await sleep(100);

    monitor.stop();

    expect(logs.some((l) => l.includes("Drain enabled"))).toBe(true);
    expect(logs.some((l) => l.includes("Drain disabled"))).toBe(true);
    expect(modeChanges).toContain("draining");
    expect(modeChanges).toContain("running");
  });
});
