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
});
